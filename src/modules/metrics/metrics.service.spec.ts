import { HttpException, HttpStatus, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService, METRICS_RENDER_TTL_MS } from './metrics.service';
import { StatsService, OverviewStats } from '../stats/stats.service';
import { getWebhookDeliveryFailuresTotal } from '../../common/metrics/webhook-delivery-metrics';
import {
  getSessionReconnectAttemptsTotal,
  getSessionReconnectLoopAlertsTotal,
} from '../../common/metrics/session-reconnect-metrics';
import { setRestrictedSessionCount } from '../../common/metrics/session-restriction-metrics';

describe('MetricsService', () => {
  const overview: OverviewStats = {
    sessions: { active: 2, total: 3, byStatus: { ready: 2, failed: 1 } },
    messages: { sent: 100, received: 50, failed: 3, today: { sent: 10, received: 5 } },
  };

  const makeService = (token?: string): MetricsService => {
    const config = { get: (k: string) => (k === 'METRICS_TOKEN' ? token : undefined) } as unknown as ConfigService;
    const stats = { getOverview: jest.fn().mockResolvedValue(overview) } as unknown as StatsService;
    return new MetricsService(config, stats);
  };

  describe('assertScrapeAuthorized', () => {
    it('returns 404 when no token is configured (endpoint disabled by default)', () => {
      const svc = makeService(undefined);
      expect(() => svc.assertScrapeAuthorized('Bearer anything')).toThrow(NotFoundException);
    });

    it('rejects a missing bearer with 401 when a token is configured', () => {
      const svc = makeService('s3cret');
      expect(() => svc.assertScrapeAuthorized(undefined)).toThrow(UnauthorizedException);
    });

    it('rejects a wrong token with 401', () => {
      const svc = makeService('s3cret');
      expect(() => svc.assertScrapeAuthorized('Bearer nope')).toThrow(UnauthorizedException);
    });

    it('accepts a correct bearer token', () => {
      const svc = makeService('s3cret');
      expect(() => svc.assertScrapeAuthorized('Bearer s3cret')).not.toThrow();
    });

    it('is tolerant of bearer casing/whitespace', () => {
      const svc = makeService('s3cret');
      expect(() => svc.assertScrapeAuthorized('bearer   s3cret')).not.toThrow();
    });

    // The route skips the shared throttler so scrapes cost no budget; failed compares get their own.
    it('answers 429 once one client has failed too often, without comparing further guesses', () => {
      const svc = makeService('s3cret');
      const guesser = { headers: {}, socket: { remoteAddress: '198.51.100.7' } };
      for (let i = 0; i < 10; i++) {
        expect(() => svc.assertScrapeAuthorized('Bearer nope', guesser)).toThrow(UnauthorizedException);
      }
      const locked = (): void => svc.assertScrapeAuthorized('Bearer s3cret', guesser);
      expect(locked).toThrow(HttpException);
      try {
        locked();
      } catch (err) {
        expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      }
      // Another client is unaffected.
      expect(() =>
        svc.assertScrapeAuthorized('Bearer s3cret', { headers: {}, socket: { remoteAddress: '203.0.113.9' } }),
      ).not.toThrow();
    });

    it('never charges a successful scrape against that budget', () => {
      const svc = makeService('s3cret');
      const scraper = { headers: {}, socket: { remoteAddress: '198.51.100.8' } };
      for (let i = 0; i < 50; i++) {
        expect(() => svc.assertScrapeAuthorized('Bearer s3cret', scraper)).not.toThrow();
      }
    });
  });

  describe('render', () => {
    it('emits Prometheus exposition with session + message gauges', async () => {
      const svc = makeService('s3cret');
      const out = await svc.render();

      expect(out).toContain('openwa_up 1');
      expect(out).toContain('openwa_sessions_active 2');
      expect(out).toContain('openwa_sessions_total 3');
      expect(out).toContain('openwa_sessions{status="ready"} 2');
      expect(out).toContain('openwa_sessions{status="failed"} 1');
      expect(out).toContain('openwa_messages_total{direction="outgoing"} 100');
      expect(out).toContain('openwa_messages_total{direction="incoming"} 50');
      expect(out).toContain('openwa_messages_failed_total 3');
      // Every metric must declare HELP/TYPE before its sample.
      expect(out).toContain('# TYPE openwa_messages_total gauge');
      expect(out).toContain('# TYPE openwa_messages_failed_total gauge');
      // Webhook terminal-failure counter is emitted with correct counter typing + current total.
      expect(out).toContain('# TYPE openwa_webhook_delivery_failures_total counter');
      expect(out).toContain(`openwa_webhook_delivery_failures_total ${getWebhookDeliveryFailuresTotal()}`);
      // Reconnect observability counters are emitted with correct counter typing + current totals.
      expect(out).toContain('# TYPE openwa_session_reconnect_attempts_total counter');
      expect(out).toContain(`openwa_session_reconnect_attempts_total ${getSessionReconnectAttemptsTotal()}`);
      expect(out).toContain('# TYPE openwa_session_reconnect_loop_alerts_total counter');
      expect(out).toContain(`openwa_session_reconnect_loop_alerts_total ${getSessionReconnectLoopAlertsTotal()}`);
      expect(out.endsWith('\n')).toBe(true);
    });

    // A gauge, not a counter: what matters is how many accounts are restricted right now, and a
    // restriction that is applied, lifted and re-applied is one recurring fact, not a running total.
    it('emits the restricted-session gauge from the live count', async () => {
      setRestrictedSessionCount(2);
      const out = await makeService('s3cret').render();

      expect(out).toContain('# TYPE openwa_sessions_restricted gauge');
      expect(out).toContain('openwa_sessions_restricted 2');
    });

    it('reports zero restricted sessions rather than omitting the gauge', async () => {
      setRestrictedSessionCount(0);
      const out = await makeService('s3cret').render();

      expect(out).toContain('openwa_sessions_restricted 0');
    });

    it('memoizes the rendered output within the TTL (one getOverview per window)', async () => {
      jest.useFakeTimers();
      try {
        const config = {
          get: (k: string) => (k === 'METRICS_TOKEN' ? 's3cret' : undefined),
        } as unknown as ConfigService;
        const getOverview = jest.fn().mockResolvedValue(overview);
        const svc = new MetricsService(config, { getOverview } as unknown as StatsService);

        await svc.render();
        await svc.render();
        expect(getOverview).toHaveBeenCalledTimes(1); // 2nd scrape served from the memo, no DB work

        jest.advanceTimersByTime(METRICS_RENDER_TTL_MS + 1);
        await svc.render();
        expect(getOverview).toHaveBeenCalledTimes(2); // window expired → recomputed
      } finally {
        jest.useRealTimers();
      }
    });
  });
});

// The scrape had a hard runtime dependency on the data database: render() awaited
// StatsService.getOverview() unguarded, so once the stats memo lapsed during a database problem
// EVERY scrape answered 500 and Prometheus lost the whole target — including the process and HTTP
// series that need no database at all, during the exact incident they exist for.
describe('MetricsService.render survives a failing stats query', () => {
  const healthyOverview: OverviewStats = {
    sessions: { active: 2, total: 3, byStatus: { ready: 2, failed: 1 } },
    messages: { sent: 100, received: 50, failed: 3, today: { sent: 10, received: 5 } },
  };

  const failing = (): MetricsService => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const stats = {
      getOverview: jest.fn().mockRejectedValue(new Error('SQLITE_BUSY: database is locked')),
    } as unknown as StatsService;
    return new MetricsService(config, stats);
  };

  it('still serves the series that need no database', async () => {
    const text = await failing().render();

    expect(text).toContain('openwa_up 1');
    expect(text).toContain('openwa_process_uptime_seconds');
    expect(text).toContain('openwa_process_resident_memory_bytes');
    expect(text).toContain('openwa_webhook_delivery_failures_total');
  });

  it('signals that the database-derived series are missing rather than reporting them as zero', async () => {
    const text = await failing().render();

    expect(text).toContain('openwa_stats_available 0');
    // A stale or invented 0 would be worse than an absent series: an alert on
    // openwa_sessions_active would fire as if every session had dropped.
    expect(text).not.toContain('openwa_sessions_active');
    expect(text).not.toContain('openwa_messages_total');
  });

  // Negative twin: a healthy scrape must still carry the database-derived series and say so.
  it('reports the stats source as available on a healthy scrape', async () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const stats = { getOverview: jest.fn().mockResolvedValue(healthyOverview) } as unknown as StatsService;
    const text = await new MetricsService(config, stats).render();

    expect(text).toContain('openwa_stats_available 1');
    expect(text).toContain('openwa_sessions_active 2');
  });
});
