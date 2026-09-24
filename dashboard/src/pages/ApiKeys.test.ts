// Render test for the API Keys page under the bare `node --test` runner, on the Templates.test.ts
// harness. The list endpoint returns only each key's prefix (the plaintext exists once, at creation),
// so the row offers no control that claims to show the key.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// The status GET /auth/api-keys answers with: 200 lists the key below.
let listStatus = 200;

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/sessions') return Promise.resolve(jsonResponse([]));
    if (path === '/api/auth/api-keys') {
      if (listStatus !== 200) {
        return Promise.resolve(jsonResponse({ message: 'This API key cannot access this resource' }, listStatus));
      }
      return Promise.resolve(
        jsonResponse([
          {
            id: 'key-1',
            name: 'billing-bot',
            keyPrefix: 'owa_k1ab',
            role: 'operator',
            isActive: true,
            usageCount: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
      );
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let ApiKeys: (typeof import('./ApiKeys.tsx'))['ApiKeys'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ ApiKeys } = await import('./ApiKeys.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  listStatus = 200;
});

function renderApiKeys(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ToastProvider, null, createElement(ApiKeys)),
    ),
  );
}

test('a key row shows its prefix masked and offers no show/hide toggle', async () => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ToastProvider, null, createElement(ApiKeys)),
    ),
  );
  await rtl.screen.findByText('owa_k1ab****');
  assert.ok(
    !rtl.screen.queryByRole('button', { name: 'Show API key' }),
    'the row offers to show a key it does not have',
  );
});

// An admin key restricted to sessions is refused here (the route needs an unscoped key), and a
// failed read is not an empty list: "No API keys created" would read as a gateway with no keys.
test('a refused read says so instead of showing the empty state', async () => {
  listStatus = 403;
  renderApiKeys();
  await rtl.screen.findByText('No access to API keys');
  assert.ok(!rtl.screen.queryByText('No API keys created'), 'a refused read rendered as an empty list');
});

test('a failed read shows the error instead of the empty state', async () => {
  listStatus = 500;
  renderApiKeys();
  await rtl.screen.findByText('Could not load API keys');
  assert.ok(!rtl.screen.queryByText('No API keys created'), 'a failed read rendered as an empty list');
});
