import { AsyncLocalStorage } from 'async_hooks';
import { WorkerToHostMessage, HostToWorkerMessage } from './protocol';

/**
 * Carries the per-session-resolved config for the duration of a hook dispatch so ctx.config (a getter
 * in worker-bootstrap) returns the right slice — even when events for different sessions interleave.
 * AsyncLocalStorage scopes it per async call tree, so concurrent dispatches never see each other's.
 * It also carries the dispatch's in-flight hook chain, which a capability call made from that tree
 * sends back to the host: only a call caused by a hook handler is re-entrancy-guarded, never an
 * unrelated one (an ingress handler, a timer set outside a hook) that merely overlaps a dispatch.
 */
export const hookConfigStore = new AsyncLocalStorage<{ config?: Record<string, unknown>; inFlight?: string[] }>();

export interface WorkerHookContext {
  event: string;
  data: unknown;
  sessionId?: string;
  source: string;
  timestamp: Date;
}

export interface WorkerHookResult {
  continue: boolean;
  data?: unknown;
}

export type WorkerHookHandler = (ctx: WorkerHookContext) => Promise<WorkerHookResult> | WorkerHookResult;

/**
 * Worker-side hook handling. A sandboxed plugin registers handlers here (via ctx.registerHook). The
 * registry subscribes the host to each event the first time it sees a handler for it, and on a `hook`
 * message runs the plugin's handlers in priority order — threading data, stopping on continue:false,
 * and swallowing a handler error so one bad handler can't break the chain. A swallowed error is NOT
 * silent: the first failure rides the hook-result back to the host, which logs it and records it for
 * the plugin's health surface.
 */
export class WorkerHookRegistry {
  private readonly handlers = new Map<string, { handler: WorkerHookHandler; priority: number }[]>();

  constructor(private readonly post: (message: WorkerToHostMessage) => void) {}

  register(event: string, handler: WorkerHookHandler, priority = 100): void {
    const list = this.handlers.get(event);
    if (list) {
      list.push({ handler, priority });
      list.sort((a, b) => a.priority - b.priority);
      return;
    }
    this.handlers.set(event, [{ handler, priority }]);
    this.post({ kind: 'hook-subscribe', event, priority });
  }

  async handleHook(message: Extract<HostToWorkerMessage, { kind: 'hook' }>): Promise<void> {
    // Run the whole dispatch inside the per-session config scope so every handler (and any async work
    // it awaits) sees ctx.config resolved for THIS event's session. Absent config => the bootstrap
    // getter falls back to the base config.
    // The store outlives the dispatch in any timer or detached promise a handler starts; drop the
    // chain once it settles so such a later call is not treated as re-entrant.
    const store: { config?: Record<string, unknown>; inFlight?: string[] } = {
      config: message.config,
      inFlight: message.inFlight ?? [message.event],
    };
    try {
      await hookConfigStore.run(store, () => this.dispatch(message));
    } finally {
      store.inFlight = undefined;
    }
  }

  private async dispatch(message: Extract<HostToWorkerMessage, { kind: 'hook' }>): Promise<void> {
    const list = this.handlers.get(message.event) ?? [];
    let data = message.data;
    let shouldContinue = true;
    let firstError: string | undefined;
    for (const { handler } of list) {
      try {
        const result = await handler({
          event: message.event,
          data,
          sessionId: message.sessionId,
          source: message.source,
          timestamp: new Date(),
        });
        if (result.data !== undefined) data = result.data;
        if (!result.continue) {
          shouldContinue = false;
          break;
        }
      } catch (error) {
        // A handler error must not break the chain (mirrors the host hook manager). Report the FIRST
        // failure to the host so a throwing hook is visible to the operator instead of failing open
        // in silence; later handlers still run.
        firstError ??= error instanceof Error ? error.message : String(error);
      }
    }
    const result: Extract<WorkerToHostMessage, { kind: 'hook-result' }> = {
      kind: 'hook-result',
      id: message.id,
      continue: shouldContinue,
      data,
    };
    if (firstError !== undefined) result.error = firstError;
    this.post(result);
  }
}
