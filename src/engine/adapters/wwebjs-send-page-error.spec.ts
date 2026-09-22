import * as path from 'path';
import { CAPTURED_PAGE_ERROR_PREFIX, WwebjsLifecycle } from './wwebjs-lifecycle';

/**
 * A send failure scripts/patch-wwebjs-send-error.js captured inside the page quotes WhatsApp Web's
 * own text, and the dead-page classifier reads error text. Without the exemption, a refusal whose
 * summary happened to say "connection closed" would tear down a session whose page had just proved
 * it was alive by running the catch. The patcher's own spec (node:test) covers what the page code
 * builds; this one covers how the gateway reads it.
 */

// The patcher is plain CommonJS under scripts/, loaded by path as engine-patch-status.spec.ts does.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const patcher = require(path.join(__dirname, '..', '..', '..', 'scripts', 'patch-wwebjs-send-error.js')) as {
  PREFIX: string;
};

const isPageTransportError = (error: unknown): boolean =>
  WwebjsLifecycle.prototype.isPageTransportError.call({}, error);

/** A captured error as puppeteer hands it over: a plain Error whose message is the prefix and the JSON. */
const captured = (info: Record<string, string>): Error => new Error(CAPTURED_PAGE_ERROR_PREFIX + JSON.stringify(info));

describe('a send failure captured inside the page', () => {
  it('uses the prefix the patcher builds it with', () => {
    // The patcher cannot import the TS constant (it runs at install time), so the two copies are
    // pinned here instead: a drifted prefix would silently switch the exemption below off.
    expect(patcher.PREFIX).toBe(CAPTURED_PAGE_ERROR_PREFIX);
  });

  it('is never read as a dead page, whatever WhatsApp Web text it quotes', () => {
    for (const quoted of ['connection closed', 'Target closed', 'Protocol error', 'Session closed']) {
      expect(isPageTransportError(captured({ ctor: 't', name: 't', message: quoted }))).toBe(false);
    }
  });

  it('leaves the same words a death when they are not a capture', () => {
    // Non-vacuity: the quoted text above is exactly what the pattern matches on its own, so the
    // exemption, and not the words, is what answers false there.
    expect(isPageTransportError(new Error('connection closed'))).toBe(true);
    expect(isPageTransportError(new Error('Protocol error (Runtime.callFunctionOn): Target closed'))).toBe(true);
    // A prefix that is not at the start is not a capture either.
    expect(isPageTransportError(new Error(`Session closed; ${CAPTURED_PAGE_ERROR_PREFIX}{}`))).toBe(true);
  });
});
