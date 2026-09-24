interface Page<T> {
  data: T[];
  total: number;
}

interface FetchAllPagesOptions {
  pageSize?: number;
  maxItems?: number;
  /** Wait before the first retry of a throttled (429) page; doubles on each further retry. */
  retryDelayMs?: number;
}

// The gateway's per-IP throttler allows 10 requests a second by default, so a walk of more than ten
// pages trips it. A few doubling waits outlast that one-second window. The per-minute tier (100
// requests per route, after which the route is refused for a whole minute) cannot be outlasted, so
// the default `maxItems` stops a walk at 90 pages of 200 and leaves the caller's own reads of that
// route part of the budget.
const THROTTLE_RETRIES = 3;

async function retryThrottled<T>(fetchOnce: () => Promise<T>, delayMs: number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchOnce();
    } catch (err) {
      if ((err as { status?: number }).status !== 429 || attempt >= THROTTLE_RETRIES) throw err;
      await new Promise(resolve => setTimeout(resolve, delayMs * 2 ** attempt));
    }
  }
}

/**
 * Walk an offset-paginated list endpoint to completion.
 *
 * Termination is driven by the server's own `total` and by short/empty pages — never by comparing
 * the returned page length against the *requested* size. Endpoints clamp `limit` server-side (audit
 * caps at MAX_AUDIT_PAGE_SIZE), so a `page.length < requested` test reads a clamped first page as
 * "last page" and silently truncates the result.
 *
 * `truncated` is set when the `maxItems` safety cap ended the walk while the server still had rows.
 */
export async function fetchAllPages<T>(
  fetchPage: (limit: number, offset: number) => Promise<Page<T>>,
  { pageSize = 200, maxItems = 18_000, retryDelayMs = 1000 }: FetchAllPagesOptions = {},
): Promise<{ items: T[]; truncated: boolean }> {
  const all: T[] = [];
  let offset = 0;
  for (;;) {
    const { data, total } = await retryThrottled(() => fetchPage(pageSize, offset), retryDelayMs);
    all.push(...data);
    offset += data.length;
    if (data.length === 0 || offset >= total) return { items: all, truncated: false };
    if (all.length >= maxItems) return { items: all, truncated: true };
  }
}
