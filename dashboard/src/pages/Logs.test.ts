// Render smoke test for the Logs page under the bare `node --test` runner, following the
// Sessions.test.ts harness (same providers, recorded-fetch stub, jsdom loader hooks). The Logs
// page is the AuditLog type's only consumer, and the wire type now carries required nullable
// fields (apiKeyId..statusCode are `| null`, userAgent/metadata added) — this pins that the page
// renders null fields with its fallbacks rather than crashing, and that the search filter matches
// action and errorMessage case-insensitively over rows whose other fields are null.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AuditLog } from '../services/api';

// Every nullable field at its null floor: the pre-UI wire shape for actions that carry no session
// and no API-key linkage (infra admin operations).
const LOG_WITH_NULLS: AuditLog = {
  id: 'row-nulls',
  action: 'infra.restart',
  severity: 'info',
  apiKeyId: null,
  apiKeyName: null,
  sessionId: null,
  sessionName: null,
  ipAddress: null,
  userAgent: null,
  method: null,
  path: null,
  statusCode: null,
  errorMessage: null,
  metadata: null,
  createdAt: '2026-08-16T01:02:03.000Z',
};

const LOG_FAILED_SEND: AuditLog = {
  ...LOG_WITH_NULLS,
  id: 'row-failed',
  action: 'session.stop',
  severity: 'error',
  sessionId: 'sess-1',
  sessionName: 'billing-bot',
  ipAddress: '10.0.0.9',
  method: 'POST',
  path: '/api/sessions/sess-1/stop',
  statusCode: 502,
  errorMessage: 'SESSION_STOP_INCOMPLETE',
};

const LOGS = [LOG_WITH_NULLS, LOG_FAILED_SEND];

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
}

// When set, the export's page walk (limit=200) fails with this status; the on-screen page still loads.
let exportFailure: number | null = null;
// When set, the export's page walk sees a table of this many rows, served 200 at a time.
let exportTotal: number | null = null;
// When set, every export page from this offset on is refused with a 429, as a tripped minute tier does.
let exportThrottledFrom: number | null = null;

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (exportFailure && url.includes('limit=200')) {
      return Promise.resolve(new Response(JSON.stringify({ message: 'boom' }), { status: exportFailure }));
    }
    const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset') ?? 0);
    if (exportThrottledFrom !== null && url.includes('limit=200') && offset >= exportThrottledFrom) {
      return Promise.resolve(new Response(JSON.stringify({ message: 'Too Many Requests' }), { status: 429 }));
    }
    if (exportTotal && url.includes('limit=200')) {
      return Promise.resolve(jsonResponse({ data: Array(200).fill(LOG_FAILED_SEND), total: exportTotal }));
    }
    return Promise.resolve(jsonResponse({ data: LOGS, total: LOGS.length }));
  }) as typeof fetch;
}

/** Record the export's blobs instead of handing them to jsdom, which has no object URLs. */
function recordDownloads(): { downloads: Blob[]; restore: () => void } {
  const downloads: Blob[] = [];
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob: Blob) => {
    downloads.push(blob);
    return 'blob:export';
  };
  URL.revokeObjectURL = () => {};
  return {
    downloads,
    restore: () => {
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    },
  };
}

let rtl: typeof import('@testing-library/react');
let Logs: () => React.ReactElement;
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Logs } = await import('./Logs.tsx'));
});

afterEach(() => rtl.cleanup());

function renderLogs(): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtl.render(
    createElement(QueryClientProvider, { client }, createElement(ToastProvider, null, createElement(Logs))),
  ).container;
}

test('the log table renders rows whose nullable fields are null without crashing, and shows both severities', async () => {
  const container = renderLogs();
  await rtl.waitFor(() => {
    assert.ok(container.textContent?.includes('infra.restart'), 'null-floor row renders its action');
    assert.ok(container.textContent?.includes('session.stop'), 'populated row renders its action');
  });
  // The fallback for a null ip is an em-dash, not a crash and not the string "null".
  assert.ok(container.textContent?.includes('—'), 'null ip falls back to the dash placeholder');
  assert.ok(!container.textContent?.includes('null'), 'no raw null leaks into the DOM');
});

test('a failed full export is reported, and the rows on screen are not downloaded in its place', async () => {
  const { screen, fireEvent } = rtl;
  const { downloads, restore } = recordDownloads();
  exportFailure = 500;
  try {
    renderLogs();
    await screen.findByText('infra.restart');
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await screen.findByText("Couldn't export the audit log");
    assert.equal(downloads.length, 0, 'the current page was downloaded as if it were the full export');
  } finally {
    exportFailure = null;
    restore();
  }
});

test('an export that stops at the row cap says so, counted in the UI language', async () => {
  const { screen, fireEvent } = rtl;
  const { downloads, restore } = recordDownloads();
  // Stand in for a machine whose default locale groups digits with a dot, as de-DE does.
  const realToLocaleString = Number.prototype.toLocaleString;
  Number.prototype.toLocaleString = function (
    this: number,
    locales?: Intl.LocalesArgument,
    options?: Intl.NumberFormatOptions,
  ) {
    return realToLocaleString.call(this, locales ?? 'de-DE', options);
  };
  exportTotal = 60_000;
  try {
    renderLogs();
    await screen.findByText('infra.restart');
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await screen.findByText(/covers only the newest 10,000 entries/, {}, { timeout: 10_000 });
    assert.equal(downloads.length, 1, 'the rows fetched up to the cap are still downloaded');
  } finally {
    exportTotal = null;
    Number.prototype.toLocaleString = realToLocaleString;
    restore();
  }
});

test('an export stopped by the throttle says to wait, not to narrow the filter', async () => {
  const { screen, fireEvent } = rtl;
  const { downloads, restore } = recordDownloads();
  exportTotal = 60_000;
  exportThrottledFrom = 400;
  try {
    renderLogs();
    await screen.findByText('infra.restart');
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    // The walk retries the refused page after one second and after two more before it stops.
    await screen.findByText(/newest 400 entries because the gateway is rate-limiting/, {}, { timeout: 10_000 });
    assert.equal(screen.queryByText(/Narrow the severity filter/), null, 'the throttle was reported as the row cap');
    assert.equal(downloads.length, 1, 'the rows fetched before the throttle are still downloaded');
  } finally {
    exportTotal = null;
    exportThrottledFrom = null;
    restore();
  }
});

test('an export whose search matches no entry says so and downloads nothing', async () => {
  const { screen, fireEvent } = rtl;
  const { downloads, restore } = recordDownloads();
  try {
    renderLogs();
    await screen.findByText('infra.restart');
    fireEvent.change(screen.getByPlaceholderText('Search logs...'), { target: { value: 'no-such-action' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await screen.findByText('No audit log entries match the search, so nothing was exported.');
    assert.equal(downloads.length, 0, 'an empty export was downloaded');
  } finally {
    restore();
  }
});

test('a truncated export whose search matches nothing names the entries it scanned', async () => {
  const { screen, fireEvent } = rtl;
  const { downloads, restore } = recordDownloads();
  exportTotal = 60_000;
  try {
    renderLogs();
    await screen.findByText('infra.restart');
    fireEvent.change(screen.getByPlaceholderText('Search logs...'), { target: { value: 'no-such-action' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await screen.findByText(/None of the newest 10,000 entries scanned match the search/, {}, { timeout: 10_000 });
    assert.equal(screen.queryByText(/The export covers only/), null, 'the warning reads as if a file was produced');
    assert.equal(downloads.length, 0, 'an empty export was downloaded');
  } finally {
    exportTotal = null;
    restore();
  }
});
