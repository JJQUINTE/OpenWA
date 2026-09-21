import { fetch as undiciFetch } from 'undici';
import { loadRemoteMediaBuffer } from './load-remote-media';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { SsrfBlockedError } from '../security/ssrf-guard';
import { countsTowardSendBreaker } from '../../modules/message/send-pacing.service';

// Media download goes through undici's fetch (via the SSRF-pinning helper); mock it, not global fetch.
jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { __esModule: true, ...actual, fetch: jest.fn() };
});

describe('loadRemoteMediaBuffer', () => {
  afterEach(() => {
    (undiciFetch as jest.Mock).mockReset();
    delete process.env.MEDIA_DOWNLOAD_MAX_BYTES;
  });

  // Build a Response-like with a single-chunk body stream.
  const fakeResponse = (bytes: number[], headers: Record<string, string>) => ({
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body: {
      getReader: () => {
        let done = false;
        return {
          read: () =>
            done
              ? Promise.resolve({ done: true, value: undefined })
              : ((done = true), Promise.resolve({ done: false, value: new Uint8Array(bytes) })),
          cancel: () => Promise.resolve(),
        };
      },
      cancel: () => Promise.resolve(),
    },
  });

  it('blocks an internal URL via the SSRF guard before any fetch', async () => {
    const fetchMock = undiciFetch as jest.Mock;
    await expect(loadRemoteMediaBuffer('http://127.0.0.1/x.png', undefined)).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches a public URL and returns the bytes + content-type', async () => {
    const fetchMock = undiciFetch as jest.Mock;
    fetchMock.mockResolvedValue(fakeResponse([1, 2, 3], { 'content-type': 'image/png', 'content-length': '3' }));
    const res = await loadRemoteMediaBuffer('http://8.8.8.8/x.png', undefined);
    expect(res.mimetype).toBe('image/png');
    expect(Array.from(res.data)).toEqual([1, 2, 3]);
    // Never follow redirects (a 3xx could reach an internal host the guard never validated).
    expect(fetchMock).toHaveBeenCalledWith('http://8.8.8.8/x.png', expect.objectContaining({ redirect: 'manual' }));
  });

  it('rejects a body that exceeds the byte cap', async () => {
    process.env.MEDIA_DOWNLOAD_MAX_BYTES = '2';
    (undiciFetch as jest.Mock).mockResolvedValue(fakeResponse([1, 2, 3], { 'content-type': 'image/png' }));
    await expect(loadRemoteMediaBuffer('http://8.8.8.8/x.png', undefined)).rejects.toThrow(/exceeds/i);
  });

  /**
   * A URL that cannot be fetched is a fault in the caller's input. As a plain Error it left every
   * send path as a 500 and counted toward the send-pacing breaker, so a client with a dead link
   * could trip the breaker on a healthy session.
   */
  describe('maps a failed fetch to a client error', () => {
    const failureOf = async (): Promise<unknown> =>
      loadRemoteMediaBuffer('http://8.8.8.8/x.png', undefined).then(
        () => undefined,
        (error: unknown) => error,
      );

    it('answers 400 for a non-2xx response', async () => {
      (undiciFetch as jest.Mock).mockResolvedValue({ ...fakeResponse([], {}), ok: false, status: 404 });
      const error = await failureOf();
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toBe('Media fetch failed with status 404');
      expect(countsTowardSendBreaker(error)).toBe(false);
    });

    it('answers 413 for a declared or streamed size over the cap', async () => {
      process.env.MEDIA_DOWNLOAD_MAX_BYTES = '2';
      (undiciFetch as jest.Mock).mockResolvedValue(fakeResponse([1], { 'content-length': '3' }));
      const declared = await failureOf();
      expect(declared).toBeInstanceOf(PayloadTooLargeException);
      expect(countsTowardSendBreaker(declared)).toBe(false);

      (undiciFetch as jest.Mock).mockResolvedValue(fakeResponse([1, 2, 3], {}));
      expect(await failureOf()).toBeInstanceOf(PayloadTooLargeException);
    });

    it('answers 400 for a response without a body', async () => {
      (undiciFetch as jest.Mock).mockResolvedValue({ ...fakeResponse([], {}), body: null });
      expect(await failureOf()).toBeInstanceOf(BadRequestException);
    });

    it('answers 400 for a timeout', async () => {
      (undiciFetch as jest.Mock).mockRejectedValue(new DOMException('aborted', 'TimeoutError'));
      const error = await failureOf();
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toMatch(/^Media fetch timed out after \d+ ms$/);
    });

    it('answers 400 for a failed connection without echoing its cause', async () => {
      (undiciFetch as jest.Mock).mockRejectedValue(
        new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 10.0.0.5:443') }),
      );
      const error = await failureOf();
      expect(error).toBeInstanceOf(BadRequestException);
      expect(JSON.stringify((error as BadRequestException).getResponse())).not.toContain('10.0.0.5');
      expect(countsTowardSendBreaker(error)).toBe(false);
    });

    it('answers 400 for a body cut off mid-read', async () => {
      const reader = { read: () => Promise.reject(new TypeError('terminated')), cancel: () => Promise.resolve() };
      const response = fakeResponse([], {});
      (undiciFetch as jest.Mock).mockResolvedValue({
        ...response,
        body: { ...response.body, getReader: () => reader },
      });
      expect(await failureOf()).toBeInstanceOf(BadRequestException);
    });

    // A malformed proxy URL or a fault in this code is a server fault: it stays a 500.
    it('leaves any other TypeError unchanged', async () => {
      const invalid = new TypeError('Invalid URL');
      (undiciFetch as jest.Mock).mockRejectedValue(invalid);
      expect(await failureOf()).toBe(invalid);
    });

    it('leaves any other error unchanged', async () => {
      const boom = new Error('Unsupported proxy protocol: gopher:');
      (undiciFetch as jest.Mock).mockRejectedValue(boom);
      expect(await failureOf()).toBe(boom);
    });
  });
});
