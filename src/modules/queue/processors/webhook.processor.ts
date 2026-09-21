import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { createLogger } from '../../../common/services/logger.service';
import { QUEUE_NAMES } from '../queue-names';
import { workerConnectionOptions, webhookWorkerConcurrency } from '../redis-connection';
import { WebhookJobData, WebhookPayload } from '../../webhook/webhook.service';
import { Webhook } from '../../webhook/entities/webhook.entity';
import { WebhookDeliveryFailure } from '../../webhook/entities/webhook-delivery-failure.entity';
import { recordWebhookDeliveryFailure, statusCodeFromError } from '../../webhook/utils/record-delivery-failure';
import { buildDeliveryHeaders, postWebhookPayload } from '../../webhook/utils/deliver-once';
import { HookManager } from '../../../core/hooks';
import { redactSsrfError } from '../../../common/security/ssrf-guard';
import { incrementWebhookDeliveryFailures } from '../../../common/metrics/webhook-delivery-metrics';

export interface WebhookJobResult {
  statusCode: number;
  success: boolean;
  error?: string;
  responseTime: number;
}

/**
 * The exact `failedReason` BullMQ 5.80.x sets when a job stalls more than `maxStalledCount` (worker
 * default 1, so the SECOND genuine stall): the stalled checker (moveStalledJobsToWait Lua script)
 * stores it as the job's deferred failure, and the worker then fails the job itself — emitting
 * 'failed' WITHOUT ever calling process(). Lock renewal means a slow-but-alive processor never
 * stalls, so reaching this sentinel implies the job genuinely died twice mid-processing.
 */
const STALL_EXHAUSTION_MESSAGE = 'job stalled more than allowable limit';

/** Per-attempt delivery context threaded through the process() pipeline stages (was closure state). */
interface WebhookDeliveryContext {
  job: Job<WebhookJobData>;
  webhookId: string;
  url: string;
  event: string;
  payload: WebhookPayload;
  maxRetries: number;
  sessionId: string;
  startTime: number;
}

// Override the Worker's connection so it does NOT inherit the producer's `enableOfflineQueue: false`
// from the shared BullModule connection — the Worker must tolerate a brief Redis reconnect. Set an
// explicit concurrency: BullMQ defaults a Worker to 1, which serializes every session's webhook
// deliveries behind one slow/timing-out receiver.
@Processor(QUEUE_NAMES.WEBHOOK, { connection: workerConnectionOptions(), concurrency: webhookWorkerConcurrency() })
export class WebhookProcessor extends WorkerHost {
  private readonly logger = createLogger('WebhookProcessor');

  constructor(
    @InjectRepository(Webhook, 'data')
    private readonly webhookRepository: Repository<Webhook>,
    @InjectRepository(WebhookDeliveryFailure, 'data')
    private readonly failureRepository: Repository<WebhookDeliveryFailure>,
    private readonly hookManager: HookManager,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  async process(job: Job<WebhookJobData>): Promise<WebhookJobResult> {
    const { webhookId, event, payload, maxRetries } = job.data;
    const startTime = Date.now();
    const sessionId = payload.sessionId;

    this.logger.log(`Processing webhook job ${job.id}`, {
      webhookId,
      event,
      deliveryId: payload.deliveryId,
      idempotencyKey: payload.idempotencyKey,
      attempt: job.attemptsMade + 1,
      action: 'webhook_process_start',
    });

    const ctx: WebhookDeliveryContext = {
      job,
      webhookId,
      url: job.data.url,
      event,
      payload,
      maxRetries,
      sessionId,
      startTime,
    };

    try {
      // The job carries a snapshot taken at enqueue time. Re-read the row before every attempt: a
      // webhook that was deleted, disabled or unsubscribed from this event since then must not
      // receive it (the reconciler skips only deleted and disabled rows; neither re-applies the
      // webhook's filters, which need the event data). Completing the job instead of throwing
      // stops the retries and files no dead-letter row. Otherwise deliver with the CURRENT url,
      // headers and secret, as the reconciler's replay does, so a receiver move or a rotated
      // secret or auth header applies to jobs already waiting in the queue.
      // A read error lands in the catch below and counts as a failed attempt, like a failed POST.
      const current = await this.loadDeliverableWebhook(webhookId, event);
      if (!current) {
        this.logger.warn('Skipping queued webhook delivery: webhook removed, disabled or unsubscribed', {
          webhookId,
          event,
          deliveryId: payload.deliveryId,
          idempotencyKey: payload.idempotencyKey,
          action: 'webhook_skipped_stale',
        });
        return { statusCode: 0, success: false, error: 'webhook removed, disabled or unsubscribed', responseTime: 0 };
      }
      ctx.url = current.url;
      const body = JSON.stringify(payload);
      const requestHeaders = buildDeliveryHeaders(
        current,
        event,
        payload.idempotencyKey,
        payload.deliveryId,
        body,
        job.attemptsMade,
      );

      const { status, responseTime } = await this.postToReceiver(ctx, body, requestHeaders);
      await this.recordSuccessfulDelivery(ctx, status, responseTime);
      return {
        statusCode: status,
        success: true,
        responseTime,
      };
    } catch (error) {
      await this.recordDeliveryFailure(ctx, error);
      // Re-throw to trigger BullMQ retry
      throw error;
    }
  }

  /** The webhook row as it is now, or null when it was deleted, disabled or no longer takes `event`. */
  private async loadDeliverableWebhook(webhookId: string, event: string): Promise<Webhook | null> {
    const row = await this.webhookRepository.findOne({ where: { id: webhookId } });
    return row && row.active && (row.events.includes(event) || row.events.includes('*')) ? row : null;
  }

  /**
   * POST the payload to the receiver through the SSRF-guarded fetch and classify the response:
   * a non-ok status throws into the failure path. Returns the status and measured response time.
   */
  private async postToReceiver(
    ctx: WebhookDeliveryContext,
    body: string,
    requestHeaders: Record<string, string>,
  ): Promise<{ status: number; responseTime: number }> {
    const { url, startTime } = ctx;
    const { status } = await postWebhookPayload(
      url,
      body,
      requestHeaders,
      // Honor WEBHOOK_TIMEOUT on the primary (queued) path too — not just the deprecated direct one.
      this.configService.get<number>('webhook.timeout', 10000),
    );

    const responseTime = Date.now() - startTime;
    return { status, responseTime };
  }

  /**
   * Post-delivery bookkeeping for a 2xx answer: guarded lastTriggeredAt update, the
   * webhook:delivered hook, and the success log.
   */
  private async recordSuccessfulDelivery(
    ctx: WebhookDeliveryContext,
    status: number,
    responseTime: number,
  ): Promise<void> {
    const { job, webhookId, event, payload, sessionId } = ctx;
    // The receiver already answered 2xx — the delivery SUCCEEDED. Everything up to the return is
    // bookkeeping and must never throw back into the failure path: a rethrow would make BullMQ
    // retry (a duplicate POST for an already-delivered event) and, on the final attempt, file a
    // false dead-letter row. Log a bookkeeping failure and keep the success outcome.
    try {
      await this.webhookRepository.update(webhookId, {
        lastTriggeredAt: new Date(),
      });
    } catch (bookkeepingError) {
      this.logger.error(
        'Webhook delivered but lastTriggeredAt update failed',
        bookkeepingError instanceof Error ? bookkeepingError.message : String(bookkeepingError),
        { webhookId, deliveryId: payload.deliveryId, action: 'webhook_bookkeeping_failed' },
      );
    }

    // Execute hook after successful delivery
    await this.hookManager.execute(
      'webhook:delivered',
      {
        sessionId,
        event,
        webhookId,
        deliveryId: payload.deliveryId,
        statusCode: status,
        responseTime,
        attempt: job.attemptsMade + 1,
      },
      { sessionId, source: 'WebhookProcessor' },
    );

    this.logger.log(`Webhook delivered successfully`, {
      webhookId,
      event,
      deliveryId: payload.deliveryId,
      idempotencyKey: payload.idempotencyKey,
      statusCode: status,
      responseTime,
      attempt: job.attemptsMade + 1,
      action: 'webhook_delivered',
    });
  }

  /**
   * Failure-path bookkeeping: log the delivery failure and, on the final attempt, fire the
   * webhook:error hook, persist the durable dead-letter row, and bump the failures metric.
   */
  private async recordDeliveryFailure(ctx: WebhookDeliveryContext, error: unknown): Promise<void> {
    const { job, webhookId, url, event, payload, maxRetries, sessionId, startTime } = ctx;
    const responseTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isFinalAttempt = job.attemptsMade + 1 >= maxRetries;

    this.logger.error(`Webhook delivery failed`, errorMessage, {
      webhookId,
      event,
      deliveryId: payload.deliveryId,
      idempotencyKey: payload.idempotencyKey,
      responseTime,
      attempt: job.attemptsMade + 1,
      maxRetries,
      isFinalAttempt,
      action: 'webhook_failed',
    });

    // On final failure (all retries exhausted): fire the error hook AND persist a durable record so
    // the lost event is visible after the BullMQ failed-set / logs roll off.
    if (isFinalAttempt) {
      // The hook payload and the durable row are surfaced to operators/plugins — redact SSRF detail
      // (resolved internal IP) from the client-facing message. The full `errorMessage` is already
      // logged server-side above; statusCodeFromError never matches an SSRF block (matches ^HTTP \d{3}).
      const clientError = redactSsrfError(error);
      await this.hookManager.execute(
        'webhook:error',
        {
          sessionId,
          event,
          webhookId,
          deliveryId: payload.deliveryId,
          error: clientError,
          attempt: job.attemptsMade + 1,
        },
        { sessionId, source: 'WebhookProcessor' },
      );
      const recorded = await recordWebhookDeliveryFailure(this.failureRepository, this.logger, {
        webhookId,
        sessionId,
        event,
        url,
        idempotencyKey: payload.idempotencyKey,
        deliveryId: payload.deliveryId,
        attempts: job.attemptsMade + 1,
        lastStatusCode: statusCodeFromError(errorMessage),
        lastError: clientError,
      });
      if (recorded) {
        incrementWebhookDeliveryFailures();
      }
    }
  }

  /**
   * A job failed by stall exhaustion never enters process(): the worker fails it internally after
   * the second stall and only emits 'failed'. Without this handler such a job bypasses every product
   * failure channel — no dead-letter row, no metric, no webhook:error hook. Normal delivery failures
   * are already recorded by process() on the final attempt (and non-final ones are retried), so this
   * handler MUST ignore anything but the stall-exhaustion sentinel, or every failure is recorded
   * twice. `job` can be undefined when the queue's bounded `removeOnFail` window (see QueueModule's
   * WEBHOOK_QUEUE_JOB_OPTIONS) pruned it before this event fired — that window keeps failed-job
   * retention bounded, and each retained payload was size-gated before enqueue.
   */
  @OnWorkerEvent('failed')
  async onWorkerFailed(job: Job<WebhookJobData> | undefined, error: Error): Promise<void> {
    if (!job || error.message !== STALL_EXHAUSTION_MESSAGE) {
      return;
    }

    const { webhookId, event, payload } = job.data;
    const sessionId = payload.sessionId;

    // Same rule as process(): no dead-letter row or webhook:error for a webhook that is gone, disabled
    // or unsubscribed, and the row records the URL a retry would have used. If the read itself fails,
    // record against the enqueue-time snapshot rather than lose the failure.
    let url = job.data.url;
    try {
      const current = await this.loadDeliverableWebhook(webhookId, event);
      if (!current) {
        return;
      }
      url = current.url;
    } catch (readError) {
      this.logger.warn('Could not re-read webhook for a stalled job; recording the enqueue-time URL', {
        webhookId,
        error: readError instanceof Error ? readError.message : String(readError),
      });
    }

    this.logger.error('Webhook job failed after stalling beyond the recovery limit', error.message, {
      webhookId,
      event,
      deliveryId: payload.deliveryId,
      idempotencyKey: payload.idempotencyKey,
      attemptsMade: job.attemptsMade,
      action: 'webhook_stall_exhausted',
    });

    await this.hookManager.execute(
      'webhook:error',
      {
        sessionId,
        event,
        webhookId,
        deliveryId: payload.deliveryId,
        error: error.message,
        attempt: job.attemptsMade,
      },
      { sessionId, source: 'WebhookProcessor' },
    );

    const recorded = await recordWebhookDeliveryFailure(this.failureRepository, this.logger, {
      webhookId,
      sessionId,
      event,
      url,
      idempotencyKey: payload.idempotencyKey,
      deliveryId: payload.deliveryId,
      attempts: job.attemptsMade,
      lastStatusCode: null, // no HTTP exchange completed on the stalled attempts
      lastError: error.message,
    });
    if (recorded) {
      incrementWebhookDeliveryFailures();
    }
  }
}
