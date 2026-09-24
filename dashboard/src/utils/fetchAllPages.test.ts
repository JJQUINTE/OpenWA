import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllPages } from './fetchAllPages.ts';

/** Fake page source: holds `total` rows, but never returns more than `serverMax` per call. */
function fakeSource(total: number, serverMax: number) {
  const calls: Array<{ limit: number; offset: number }> = [];
  const fetchPage = async (limit: number, offset: number) => {
    calls.push({ limit, offset });
    const take = Math.min(limit, serverMax);
    const data = Array.from({ length: Math.max(0, Math.min(take, total - offset)) }, (_, i) => offset + i);
    return { data, total };
  };
  return { fetchPage, calls };
}

test('walks every page when the server clamps below the requested size', async () => {
  // The shipped bug: requesting 500 against a server that clamps to 200 stopped after one page.
  const { fetchPage, calls } = fakeSource(650, 200);
  const { items: rows, truncated } = await fetchAllPages(fetchPage, { pageSize: 500 });
  assert.equal(rows.length, 650);
  assert.deepEqual(rows.slice(0, 3), [0, 1, 2]);
  assert.equal(calls.length, 4);
  assert.equal(truncated, false);
});

test('stops once total is reached without an extra empty request', async () => {
  const { fetchPage, calls } = fakeSource(400, 200);
  const { items: rows } = await fetchAllPages(fetchPage, { pageSize: 200 });
  assert.equal(rows.length, 400);
  assert.equal(calls.length, 2);
});

test('stops on an empty page even if total over-reports', async () => {
  // Guards the infinite loop: a stale/wrong `total` must not keep the loop spinning.
  const { fetchPage, calls } = fakeSource(50, 200);
  const { items: rows } = await fetchAllPages(async (limit, offset) => {
    const page = await fetchPage(limit, offset);
    return { data: page.data, total: 9999 };
  });
  assert.equal(rows.length, 50);
  assert.equal(calls.length, 2);
});

test('honours the safety cap, and says the result stopped short', async () => {
  const { fetchPage } = fakeSource(10_000, 200);
  const { items: rows, truncated } = await fetchAllPages(fetchPage, { pageSize: 200, maxItems: 500 });
  assert.equal(rows.length, 600); // stops at the first page that crosses the cap
  assert.equal(truncated, true);
});

test('a walk that ends exactly at the cap is not truncated', async () => {
  const { fetchPage } = fakeSource(600, 200);
  const { items: rows, truncated } = await fetchAllPages(fetchPage, { pageSize: 200, maxItems: 600 });
  assert.equal(rows.length, 600);
  assert.equal(truncated, false);
});

test('returns an empty list when there is nothing to export', async () => {
  const { fetchPage, calls } = fakeSource(0, 200);
  const { items: rows } = await fetchAllPages(fetchPage);
  assert.deepEqual(rows, []);
  assert.equal(calls.length, 1);
});

/** An error shaped like the API client's: the HTTP status rides on the Error. */
function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

test('a throttled page is retried at the same offset instead of ending the walk', async () => {
  // The per-IP throttler allows 10 requests a second, so a large export trips it partway through.
  const { fetchPage, calls } = fakeSource(600, 200);
  let throttled = 2;
  const { items: rows } = await fetchAllPages(
    async (limit, offset) => {
      if (offset === 400 && throttled-- > 0) throw httpError(429);
      return fetchPage(limit, offset);
    },
    { retryDelayMs: 0 },
  );
  assert.equal(rows.length, 600);
  assert.deepEqual(
    calls.map(c => c.offset),
    [0, 200, 400],
  );
});

test('a first page that stays throttled, or a page failing any other way, fails the walk', async () => {
  const { fetchPage } = fakeSource(600, 200);
  let attempts = 0;
  await assert.rejects(
    fetchAllPages(
      async () => {
        attempts++;
        throw httpError(429);
      },
      { retryDelayMs: 0 },
    ),
    { status: 429 },
  );
  // Waits of one and then two seconds outlast the one-second tier; a 429 after that is a tier no
  // wait here outlasts, so a further retry only spends the budget that tier is refusing.
  assert.equal(attempts, 3, 'two retries after the first attempt');

  attempts = 0;
  await assert.rejects(
    fetchAllPages(
      async (limit, offset) => {
        attempts++;
        if (offset === 200) throw httpError(500);
        return fetchPage(limit, offset);
      },
      { retryDelayMs: 0 },
    ),
    { status: 500 },
  );
  assert.equal(attempts, 2, 'a server error is not retried');
});

test('a default walk leaves half the per-minute route budget and says the result stopped short', async () => {
  // The gateway allows 100 requests a minute per route and IP and then refuses that route for the
  // whole minute, which no retry outlasts. The Logs page's own reads share that budget.
  const { fetchPage, calls } = fakeSource(60_000, 200);
  const { items: rows, truncated } = await fetchAllPages(fetchPage, { retryDelayMs: 0 });
  assert.equal(truncated, true);
  assert.ok(calls.length <= 50, `the walk spent ${calls.length} of the 100 requests the minute allows`);
  assert.equal(rows.length, calls.length * 200);
});

test('a page still throttled past the one-second tier ends the walk with the rows in hand', async () => {
  // The per-minute or per-hour tier refused the route: keep what came in rather than wait and throw.
  const { fetchPage, calls } = fakeSource(6_000, 200);
  let attempts = 0;
  const { items: rows, truncated } = await fetchAllPages(
    async (limit, offset) => {
      attempts++;
      if (offset >= 1_000) throw httpError(429);
      return fetchPage(limit, offset);
    },
    { retryDelayMs: 0 },
  );
  assert.equal(truncated, true);
  assert.equal(rows.length, 1_000);
  assert.equal(attempts, calls.length + 3, 'the refused page was tried more than three times');
});
