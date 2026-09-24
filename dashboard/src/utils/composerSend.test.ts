import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quotedIdOf, buildMediaSendPayload, buildOptimisticMetadata } from './composerSend.ts';

/**
 * Replying with an attachment used to drop the quote silently.
 *
 * The composer treated "has an attachment" and "is replying" as mutually exclusive — the media
 * branch never carried the quoted id, and the optimistic bubble's metadata took the same either/or.
 * Because the reply banner is cleared before the send either way, the UI looked exactly like a
 * successful quoted reply. Nothing failed, so nothing surfaced it.
 *
 * These are the two payloads that were wrong, extracted so they can be asserted directly. Rendering
 * the composer would also work — `pages/Chats.test.ts` and two siblings do render real components
 * under jsdom — but that path costs a jsdom install and `createElement` scaffolding (the runner
 * cannot parse JSX, so `.test.tsx` is not an option), and these are pure payload builders with no
 * DOM in them. Most of this project's suites test `utils/` for the same reason.
 */

const REPLY = { id: 'local-1', waMessageId: 'true_628@c.us_3EB0', type: 'text', body: 'the original' };
const ATTACHMENT = { base64: 'AAAA', mimetype: 'image/png', filename: 'a.png' };
// Stands in for the composer's localized labeler.
const label = (type: string) => `[${type === 'image' ? 'Image' : type}]`;

test('quotedIdOf prefers the WhatsApp id over the local one', () => {
  assert.equal(quotedIdOf(REPLY), 'true_628@c.us_3EB0');
});

test('quotedIdOf falls back to the local id before the echo assigns a WA id', () => {
  assert.equal(quotedIdOf({ ...REPLY, waMessageId: undefined }), 'local-1');
});

test('quotedIdOf yields nothing when not replying', () => {
  assert.equal(quotedIdOf(null), undefined);
});

test('a media send while replying carries the quoted id', () => {
  const payload = buildMediaSendPayload(ATTACHMENT, 'look at this', REPLY);

  assert.equal(payload.quotedMessageId, 'true_628@c.us_3EB0');
  // The attachment must survive intact — the quote is added, not substituted.
  assert.equal(payload.base64, 'AAAA');
  assert.equal(payload.mimetype, 'image/png');
  assert.equal(payload.filename, 'a.png');
  assert.equal(payload.caption, 'look at this');
});

// Known-negative control: without it an implementation that always emitted the key would satisfy
// the assertion above while sending `quotedMessageId: undefined` on every ordinary media send.
test('a media send that is not a reply carries no quote key at all', () => {
  const payload = buildMediaSendPayload(ATTACHMENT, 'look at this', null);

  assert.equal('quotedMessageId' in payload, false);
});

test('the optimistic bubble shows BOTH the media and the quote', () => {
  const metadata = buildOptimisticMetadata(ATTACHMENT, REPLY, label);

  assert.equal(metadata?.media?.data, 'AAAA');
  assert.equal(metadata?.quotedMessage?.id, 'true_628@c.us_3EB0');
  assert.equal(metadata?.quotedMessage?.body, 'the original');
});

// A non-text quoted message has no useful body to preview, so the type stands in for it — the
// behaviour the composer already had for text-only replies, preserved now that media can coexist.
test('a quoted non-text message previews as its labelled type', () => {
  const metadata = buildOptimisticMetadata(null, { ...REPLY, type: 'image', body: '' }, label);

  assert.equal(metadata?.quotedMessage?.body, '[Image]');
});

test('no attachment and no reply produces no metadata', () => {
  assert.equal(buildOptimisticMetadata(null, null, label), undefined);
});
