import {
  BadRequestException,
  HttpException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SsrfBlockedError, withSafeFetch } from '../security/ssrf-guard';
import { urlFetchProxy } from '../security/proxy-dispatcher';
import { createLogger } from '../services/logger.service';

const logger = createLogger('RemoteMedia');

/** Default cap on a server-side media download: 50 MiB (overridable via MEDIA_DOWNLOAD_MAX_BYTES). */
const DEFAULT_MEDIA_MAX_BYTES = 50 * 1024 * 1024;
/** Default timeout for a server-side media download: 30s (overridable via MEDIA_DOWNLOAD_TIMEOUT_MS). */
const DEFAULT_MEDIA_TIMEOUT_MS = 30_000;

/**
 * Read a positive-integer knob. Boot validation rejects a malformed value for every key read here,
 * so the fallback covers unset and empty only: `parseInt` accepts the leading digits of a
 * unit-suffixed value and would silently take `50mb` as 50.
 */
function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Fetch remote media as a Buffer for sending, with an SSRF host guard, a byte cap, and a timeout.
 * The guard runs BEFORE any network call, so an internal/reserved URL throws `SsrfBlockedError`
 * and no outbound socket is opened. It goes through `withSafeFetch`, which pins a direct or SOCKS
 * connection to the vetted IP (an HTTP/HTTPS session proxy resolves the name itself, so nothing is
 * pinned there) and refuses redirects (the guard only validated the original host — a followed 3xx
 * could reach an internal target). The cap is enforced while streaming (Content-Length may be absent
 * or wrong) to bound memory use.
 *
 * Engine-neutral: returns raw bytes + the response content-type, so any engine adapter can use it.
 *
 * A URL that cannot be fetched is the caller's input, not an engine fault: a non-2xx answer, a
 * missing body, a timeout or a failed connection throw `BadRequestException`, and a body over the
 * cap throws `PayloadTooLargeException`. As plain Errors they left every send path as a 500 and
 * counted toward the send-pacing breaker. `SsrfBlockedError` is rethrown unchanged; each caller maps
 * it to its own generic message.
 *
 * Behind a session proxy a failed connection or a timeout before any response is answered 503
 * instead: undici reports a proxy that refuses, cannot be resolved or fails its handshake with the
 * same `fetch failed` as an unreachable target, so the two cannot be told apart, and blaming the
 * caller's URL for an operator's proxy outage would send the client to fix a link that works. Once a
 * response has arrived the target was reached, and its failures stay 400/413.
 *
 * `sessionProxyUrl` is the egress proxy of the session the fetch is attributed to, or undefined for
 * a direct one. It is required rather than optional so a new call site cannot leave a proxied
 * session's fetch going direct by omission; `urlFetchProxy` applies the operator's opt-out.
 */
export async function loadRemoteMediaBuffer(
  url: string,
  sessionProxyUrl: string | undefined,
): Promise<{ data: Buffer; mimetype: string }> {
  const maxBytes = positiveIntFromEnv('MEDIA_DOWNLOAD_MAX_BYTES', DEFAULT_MEDIA_MAX_BYTES);
  const timeoutMs = positiveIntFromEnv('MEDIA_DOWNLOAD_TIMEOUT_MS', DEFAULT_MEDIA_TIMEOUT_MS);

  // Always guarded (media SSRF is independent of the webhook opt-out); withSafeFetch validates the
  // host, pins a direct or SOCKS connection to the vetted IP, and refuses redirects. The streaming cap runs inside
  // the callback so the connection stays open for the body read and is torn down right after.
  const proxyUrl = urlFetchProxy(sessionProxyUrl);
  let responded = false;
  return withSafeFetch(
    url,
    { signal: AbortSignal.timeout(timeoutMs) },
    async response => {
      responded = true;
      if (!response.ok) {
        throw new BadRequestException(`Media fetch failed with status ${response.status}`);
      }

      const declaredLength = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new PayloadTooLargeException(`Media exceeds the ${maxBytes}-byte limit`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new BadRequestException('Media response has no body');
      }

      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = (await reader.read()) as { done: boolean; value: Uint8Array };
        if (done) {
          break;
        }
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new PayloadTooLargeException(`Media exceeds the ${maxBytes}-byte limit`);
        }
        chunks.push(Buffer.from(value));
      }

      const mimetype = (response.headers.get('content-type') ?? '').split(';')[0].trim();
      return { data: Buffer.concat(chunks), mimetype };
    },
    { proxyUrl },
  ).catch((error: unknown) => {
    if (error instanceof HttpException || error instanceof SsrfBlockedError) throw error;
    // Matched by name: the abort reason is a DOMException, which need not share this realm's Error.
    const name = (error as { name?: unknown } | null)?.name;
    const proxyHop = proxyUrl !== undefined && !responded;
    if (name === 'TimeoutError' || name === 'AbortError') {
      if (proxyHop) {
        throw new ServiceUnavailableException(`Media fetch through the session proxy timed out after ${timeoutMs} ms`);
      }
      throw new BadRequestException(`Media fetch timed out after ${timeoutMs} ms`);
    }
    // undici reports a failed connection as TypeError('fetch failed') and a body cut off mid-read
    // as TypeError('terminated'). Their cause can name the resolved address or the proxy, so it is
    // logged here and only a fixed message reaches the caller. Any other TypeError (a bad proxy URL,
    // a fault in this code) is a server fault and passes through.
    if (error instanceof TypeError && (error.message === 'fetch failed' || error.message === 'terminated')) {
      const cause: unknown = error.cause;
      logger.warn('Media fetch failed', { cause: cause instanceof Error ? cause.message : error.message });
      if (proxyHop) throw new ServiceUnavailableException('Media fetch through the session proxy failed');
      throw new BadRequestException('Media fetch failed');
    }
    throw error;
  });
}
