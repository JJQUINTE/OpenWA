// Render test for the per-session plugin config override under the bare `node --test` runner, on the
// ApiKeys.test.ts harness. PUT /plugins/:id/config/:sessionId reports a rejected save as 200 +
// {success:false}; the override form must show that failure, not "Saved". A cleared override must also
// leave the form on the Global values, or the next save writes the cleared ones back.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const PLUGIN = {
  id: 'greeter',
  name: 'Greeter',
  version: '1.0.0',
  type: 'extension',
  status: 'enabled',
  config: { greeting: 'hello' },
  builtIn: false,
  provides: [],
  ingressCapable: false,
  configSchema: { type: 'object', properties: { greeting: { type: 'string', title: 'Greeting' } } },
  sessionScoped: true,
  activeSessions: ['*'],
  sessionConfig: {},
};

const SESSION = { id: 'sess-1', name: 'Main', status: 'ready', createdAt: '2026-01-01T00:00:00.000Z' };

const REJECTION = 'Cannot tell which entry was removed; reload and try again';

// Per-test server state: the session overrides GET returns, what PUT answers, and each PUT body sent.
let sessionConfig: Record<string, Record<string, unknown>> = {};
let putReply: { success: boolean; message?: string } = { success: false, message: REJECTION };
let putBodies: unknown[] = [];

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path === '/api/plugins') {
      return Promise.resolve(jsonResponse([{ ...PLUGIN, sessionConfig }]));
    }
    if (method === 'GET' && path === '/api/sessions') return Promise.resolve(jsonResponse([SESSION]));
    if (method === 'PUT' && path === `/api/plugins/${PLUGIN.id}/config/${SESSION.id}`) {
      const body = JSON.parse(String(init?.body)) as { config: Record<string, unknown> };
      putBodies.push(body);
      if (putReply.success) {
        // The server drops an empty override, so the session inherits Global again.
        sessionConfig = { ...sessionConfig };
        if (Object.keys(body.config).length === 0) delete sessionConfig[SESSION.id];
        else sessionConfig[SESSION.id] = body.config;
      }
      return Promise.resolve(jsonResponse(putReply));
    }
    return Promise.resolve(jsonResponse([]));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Plugins: (typeof import('./Plugins.tsx'))['default'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  // useTheme reads the colour-scheme media query; jsdom has no matchMedia.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ default: Plugins } = await import('./Plugins.tsx'));
});

afterEach(() => {
  sessionConfig = {};
  putReply = { success: false, message: REJECTION };
  putBodies = [];
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
});

async function openSessionOverride(sessionLabel: string): Promise<void> {
  const { screen, fireEvent, findByText } = rtl;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ToastProvider, null, createElement(Plugins)),
    ),
  );

  fireEvent.click(await screen.findByTitle('Configure'));
  fireEvent.click(await screen.findByRole('button', { name: 'Sessions' }));
  const select = await screen.findByRole('combobox', { name: 'Select a session…' });
  await findByText(select, sessionLabel);
  fireEvent.change(select, { target: { value: SESSION.id } });
}

test('a per-session override the server rejects reports the failure, not "Saved"', async () => {
  const { screen, fireEvent } = rtl;
  await openSessionOverride('Main');
  fireEvent.click(await screen.findByRole('button', { name: 'Save override' }));

  await screen.findByText(REJECTION);
  assert.equal(screen.queryByText('Configuration Saved'), null);
});

test('clearing an override shows the Global values, so the next save does not pin the cleared ones back', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  sessionConfig = { [SESSION.id]: { greeting: 'hi' } };
  putReply = { success: true };
  await openSessionOverride('Main ●');
  const field = await screen.findByLabelText<HTMLInputElement>('Greeting');
  assert.equal(field.value, 'hi');

  fireEvent.click(screen.getByRole('button', { name: 'Clear override' }));
  await waitFor(() => assert.equal(putBodies.length, 1));
  await waitFor(() => assert.equal(field.value, 'hello'));

  await waitFor(() =>
    assert.equal(screen.getByRole<HTMLButtonElement>('button', { name: 'Save override' }).disabled, false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save override' }));
  await waitFor(() => assert.equal(putBodies.length, 2));
  assert.deepEqual(putBodies, [{ config: {} }, { config: {} }]);
});
