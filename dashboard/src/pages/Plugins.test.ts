import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { i18nReady } from '../i18n/index.ts';
import i18next from 'i18next';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

import type { Plugin } from '../services/api';

const pluginHtml = '<p>Editor</p>';
let pluginsList: Plugin[] = [];

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/plugins') return Promise.resolve(jsonResponse(pluginsList));
    if (path.startsWith('/api/plugins/p1/config-ui')) return Promise.resolve(new Response(pluginHtml, { status: 200 }));
    if (path === '/api/plugins/catalog') return Promise.resolve(jsonResponse([]));
    return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Plugins: (typeof import('./Plugins.tsx'))['default'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();

  // Mock matchMedia for useTheme
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {}, // Deprecated
      removeListener: () => {}, // Deprecated
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });

  installFetchStub();
  window.localStorage.setItem('openwa_user_role', 'admin');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ default: Plugins } = await import('./Plugins.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  pluginsList = [];
});

function renderPlugins(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Plugins))),
    ),
  );
}

test('PluginConfigUi replies to config:get with localized schema and locale', async () => {
  // Set the dashboard language so we can verify the schema gets localized
  await i18next.changeLanguage('es');

  pluginsList = [
    {
      id: 'p1',
      name: 'Plugin 1',
      type: 'extension',
      config: {},
      configUi: { entry: 'ui.html' },
      configSchema: {
        type: 'object',
        properties: {
          field1: { type: 'string', title: 'English Title' },
        },
      },
      i18n: {
        es: {
          config: {
            field1: { title: 'Spanish Title' },
          },
        },
      },
    },
  ];

  renderPlugins();

  // Wait for plugin list to load by finding the Configure button
  const configureButton = await rtl.screen.findByTitle('Configurar');

  // Open the configuration modal
  rtl.fireEvent.click(configureButton);

  // Wait for the iframe to be rendered
  let iframe: HTMLIFrameElement | null = null;
  await rtl.waitFor(() => {
    iframe = document.querySelector('iframe');
    assert.ok(iframe, 'ConfigUi iframe not found in DOM');
  });

  // We spy on the iframe's contentWindow postMessage
  // JSDOM creates an empty contentWindow for the iframe
  let postedMessage: Record<string, unknown> | null = null;
  iframe.contentWindow!.postMessage = (message: unknown) => {
    postedMessage = message as Record<string, unknown>;
  };

  // Dispatch the handshake message from the iframe to the window
  const messageEvent = new window.MessageEvent('message', {
    source: iframe.contentWindow as Window,
    data: { type: 'config:get' },
  });
  window.dispatchEvent(messageEvent);

  // Assert that PluginConfigUi replied with the correct schema and locale
  assert.ok(postedMessage, 'No postMessage received by iframe');
  assert.equal(postedMessage.type, 'config:value');

  // Bug #1522: The schema must be localized and locale must be present
  assert.equal(postedMessage.locale, 'es', 'locale was not sent in config:value');
  assert.equal(
    postedMessage.schema.properties.field1.title,
    'Spanish Title',
    'schema was not localized in config:value',
  );
});
