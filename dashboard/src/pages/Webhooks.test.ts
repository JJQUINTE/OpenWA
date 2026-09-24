// Render test for the Webhooks page under the bare `node --test` runner, on the Templates.test.ts
// harness. GET /webhooks is OPERATOR-only, so a viewer key always gets 403 there; a failed read must
// say so instead of rendering the "no webhooks configured" empty state.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let webhooksStatus = 200;
let webhookList: unknown[] = [];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/sessions') return Promise.resolve(jsonResponse([]));
    if (path === '/api/webhooks') {
      if (webhooksStatus === 403) {
        return Promise.resolve(jsonResponse({ message: 'Insufficient permissions. Required: operator' }, 403));
      }
      if (webhooksStatus !== 200) return Promise.resolve(jsonResponse({ message: 'database offline' }, 500));
      return Promise.resolve(jsonResponse(webhookList));
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Webhooks: (typeof import('./Webhooks.tsx'))['Webhooks'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  window.sessionStorage.setItem('openwa_user_role', 'viewer');
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Webhooks } = await import('./Webhooks.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  webhookList = [];
});

function renderWebhooks(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Webhooks))),
    ),
  );
}

test('a 403 on the webhook list shows a permission state, not an empty list', async () => {
  webhooksStatus = 403;
  renderWebhooks();
  await rtl.screen.findByText('No access to webhooks');
  assert.ok(!rtl.screen.queryByText('No webhooks configured'), 'a refused read claimed there are no webhooks');
});

test('any other failed read shows the error, not an empty list', async () => {
  webhooksStatus = 500;
  renderWebhooks();
  await rtl.screen.findByText('Could not load webhooks');
  rtl.screen.getByText('database offline');
  assert.ok(!rtl.screen.queryByText('No webhooks configured'), 'a failed read claimed there are no webhooks');
});

test('a successful empty read still shows the empty state', async () => {
  webhooksStatus = 200;
  renderWebhooks();
  await rtl.screen.findByText('No webhooks configured');
});

test('a failed refetch keeps the cached list and flags the error above it', async () => {
  webhooksStatus = 200;
  webhookList = [{ id: 'w1', sessionId: 'sess-1', url: 'https://example.test/hook', events: [], active: true }];
  renderWebhooks();
  await rtl.screen.findByText('https://example.test/hook');

  webhooksStatus = 500;
  await rtl.act(() => queryClient!.refetchQueries({ queryKey: ['webhooks'] }));
  await rtl.screen.findByText('Failed to load data');
  rtl.screen.getByText('https://example.test/hook');
});

test('the filter badge popover names enum values in words, like the filter builder', async () => {
  webhooksStatus = 200;
  webhookList = [
    {
      id: 'w1',
      sessionId: 'sess-1',
      url: 'https://example.test/hook',
      events: ['message.received'],
      active: true,
      filters: {
        conditions: [
          { field: 'type', operator: 'is', value: ['image', 'unknown', 'future-type'] },
          { field: 'kind', operator: 'isNot', value: ['individual'] },
          { field: 'sender', operator: 'is', value: ['628123@c.us'] },
        ],
      },
    },
  ];
  renderWebhooks();
  const badge = (await rtl.screen.findByText('3 filters')).closest('.filter-badge') as HTMLElement;
  rtl.fireEvent.focus(badge);

  const rows = Array.from(document.querySelectorAll('.filter-popover-row')).map(r => r.textContent);
  assert.deepEqual(rows, [
    // An unmapped value stays raw rather than disappearing.
    'Message type is Image, Unknown type, future-type',
    'Chat kind is not Individual',
    // A contact field has no labels; its JIDs are shown as they are.
    'Sender is 628123@c.us',
  ]);
});
