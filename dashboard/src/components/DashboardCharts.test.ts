// The "Messages by type" pie names each slice in its legend. Those names are message type keys from
// the stats API (voice, masked, unknown), which must read as words, not as the raw keys.
import '../test-helpers/register-hooks.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

let rtl: typeof import('@testing-library/react');
let DashboardCharts: (typeof import('./DashboardCharts.tsx'))['DashboardCharts'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  // jsdom lays nothing out, so report a real box or ResponsiveContainer never draws the chart.
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    private readonly cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(target: Element): void {
      this.cb([{ target, contentRect: { width: 400, height: 260 } } as ResizeObserverEntry], this as never);
    }
    unobserve(): void {}
    disconnect(): void {}
  };
  globalThis.fetch = (() =>
    Promise.resolve(
      jsonResponse({ timeSeries: [], byType: { voice: 3, masked: 2, unknown: 1 }, topChats: [] }),
    )) as typeof fetch;
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ DashboardCharts } = await import('./DashboardCharts.tsx'));
});

after(() => {
  rtl.cleanup();
  queryClient?.clear();
});

test('the by-type pie legend names message types in words', async () => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  rtl.render(createElement(QueryClientProvider, { client: queryClient }, createElement(DashboardCharts)));

  const card = (await rtl.screen.findByText('Messages by type')).closest('.chart-card') as HTMLElement;
  await rtl.waitFor(() => {
    const legend = Array.from(card.querySelectorAll('.recharts-legend-item-text')).map(n => n.textContent);
    assert.deepEqual(legend.sort(), ['Hidden message', 'Unknown type', 'Voice message']);
  });
});
