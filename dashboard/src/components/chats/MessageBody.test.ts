// Render test for the fix on rmyndharis/OpenWA#1676: a resolved @mention's push name is
// attacker-controlled (any WhatsApp user sets their own), and linkify-react auto-links a bare word
// with no scheme, so a participant named "localhost" must not become a clickable link. The name is
// wrapped in messageFormatter.ts's MENTION_OPEN/MENTION_CLOSE sentinels and rendered as its own
// <bdi> element, which 'bdi' in MessageBody's ignoreTags keeps out of Linkify's tree walk —
// verified against the actual linkify-react build, not by asserting on our own parser's output.
import '../../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { MENTION_CLOSE, MENTION_OPEN } from '../../utils/messageFormatter.ts';

let rtl: typeof import('@testing-library/react');
let MessageBody: (typeof import('./MessageBody.tsx'))['default'];

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  rtl = await import('@testing-library/react');
  ({ default: MessageBody } = await import('./MessageBody.tsx'));
});

afterEach(() => {
  rtl.cleanup();
});

const wrap = (s: string) => `${MENTION_OPEN}${s}${MENTION_CLOSE}`;

test('a mention-wrapped push name that linkify-react would treat as a bare URL renders with no anchor', () => {
  const { container } = rtl.render(createElement(MessageBody, { text: `hi ${wrap('@localhost')} there` }));
  assert.equal(container.querySelectorAll('a').length, 0, 'no <a> tag anywhere in the rendered message');
  const bdi = container.querySelector('bdi');
  assert.ok(bdi, 'the mention renders as a real <bdi> element');
  assert.equal(bdi?.textContent, '@localhost');
});

test('a mention-wrapped push name immediately followed by more text does not form a link across the boundary', () => {
  // e.g. "@6281112345.So" — the un-isolated case the maintainer's review named explicitly.
  const { container } = rtl.render(createElement(MessageBody, { text: `${wrap('@localhost')}.So there` }));
  assert.equal(container.querySelectorAll('a').length, 0);
});

test('a real URL outside any mention is still linkified (the fix does not disable linking generally)', () => {
  const { container } = rtl.render(createElement(MessageBody, { text: 'see https://example.com/x' }));
  const link = container.querySelector('a');
  assert.ok(link, 'a plain URL still becomes a link');
  assert.equal(link?.getAttribute('href'), 'https://example.com/x');
});

test('an unresolved mention (no matching participant) is still plain "@digits" text, still linkified as before', () => {
  const { container } = rtl.render(createElement(MessageBody, { text: 'hi @166868170059932 there' }));
  assert.equal(container.querySelectorAll('a').length, 0, 'digits alone are not a URL');
  assert.ok(container.textContent?.includes('@166868170059932'));
});
