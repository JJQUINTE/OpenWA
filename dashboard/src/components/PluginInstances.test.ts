// Render test for the plugin instance manager under the bare `node --test` runner, on the ApiKeys.test.ts
// harness: the edit modal's session scope and the view that shows a freshly minted instance.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const BASE = '/api/integration/plugins/chatwoot/instances';

const BOUND = {
  id: 'i-1',
  pluginId: 'chatwoot',
  instanceId: 'acct1',
  sessionScope: 'sess-a',
  secret: '***',
  verifyToken: null,
  config: null,
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ingressUrls: [],
};

const calls: { method: string; path: string; body?: unknown }[] = [];

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    if (method === 'GET' && path === BASE) return Promise.resolve(jsonResponse([BOUND]));
    if (method === 'PATCH' && path === `${BASE}/acct1`) return Promise.resolve(jsonResponse(BOUND));
    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let PluginInstances: (typeof import('./PluginInstances.tsx'))['PluginInstances'];
let ToastProvider: (typeof import('./Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('./Toast.tsx'));
  ({ PluginInstances } = await import('./PluginInstances.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  calls.length = 0;
});

function renderInstances(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ToastProvider, null, createElement(PluginInstances, { pluginId: 'chatwoot' })),
    ),
  );
}

test('clearing a bound session scope saves the instance for all sessions', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  renderInstances();

  fireEvent.click(await screen.findByTitle('Edit'));
  const scope = (await screen.findByLabelText('Session scope (optional)')) as HTMLInputElement;
  assert.equal(scope.value, 'sess-a');
  fireEvent.change(scope, { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => {
    const patch = calls.find(c => c.method === 'PATCH');
    assert.ok(patch, 'expected a PATCH');
    assert.equal((patch.body as { sessionScope?: unknown }).sessionScope, null);
  });
});
