// The "Messages by type" pie names each slice in its legend. Those names are message type keys from
// the stats API (voice, masked, unknown), which must read as words, not as the raw keys. Each type
// also keeps a color of its own, so no two slices can look alike.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

let rtl: typeof import('@testing-library/react');
let DashboardCharts: (typeof import('./DashboardCharts.tsx'))['DashboardCharts'];
let queryClient: QueryClient | undefined;
let byType: Record<string, number> = {};

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
  globalThis.fetch = (() => Promise.resolve(jsonResponse({ timeSeries: [], byType, topChats: [] }))) as typeof fetch;
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ DashboardCharts } = await import('./DashboardCharts.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
});

function byTypeCard(): Promise<HTMLElement> {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  rtl.render(createElement(QueryClientProvider, { client: queryClient }, createElement(DashboardCharts)));
  return rtl.screen.findByText('Messages by type').then(n => n.closest('.chart-card') as HTMLElement);
}

test('the by-type pie legend names message types in words', async () => {
  byType = { voice: 3, masked: 2, unknown: 1 };
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  rtl.render(createElement(QueryClientProvider, { client: queryClient }, createElement(DashboardCharts)));

  const card = (await rtl.screen.findByText('Messages by type')).closest('.chart-card') as HTMLElement;
  await rtl.waitFor(() => {
    const legend = Array.from(card.querySelectorAll('.recharts-legend-item-text')).map(n => n.textContent);
    assert.deepEqual(legend.sort(), ['Hidden message', 'Unknown type', 'Voice message']);
  });
});

test('every message type gets a slice color no other type uses', async () => {
  const { MESSAGE_TYPES } = await import('../services/api.ts');
  // Plus one type this build has no color for, as a newer gateway could send.
  const types = [...MESSAGE_TYPES, 'future-type'];
  byType = Object.fromEntries(types.map((type, i) => [type, i + 1]));
  const card = await byTypeCard();
  await rtl.waitFor(() => {
    const fills = Array.from(card.querySelectorAll('.recharts-legend-item .recharts-legend-icon')).map(n =>
      n.getAttribute('fill'),
    );
    assert.equal(fills.length, types.length);
    assert.equal(new Set(fills).size, types.length, `shared colors: ${fills.join(', ')}`);
  });
});
