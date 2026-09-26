/**
 * Payload builders for the chat composer's send path.
 *
 * These live here rather than inline in `ChatComposer` because the composer treated "has an
 * attachment" and "is replying" as mutually exclusive, and the resulting bug — replying with an
 * attachment silently dropped the quote — had no assertion anywhere. As pure payload builders they
 * are cheaper to test here than through a rendered composer, which is the shape most of this
 * project's suites already take.
 */

/** The subset of a message the composer needs in order to quote it. */
export interface QuotableMessage {
  id: string;
  waMessageId?: string | null;
  type?: string;
  body?: string;
}

/** The subset of a staged attachment the composer needs in order to send it. */
export interface ComposerAttachment {
  base64: string;
  mimetype: string;
  filename?: string;
}

export interface OptimisticMetadata {
  media?: { mimetype: string; filename?: string; data: string };
  quotedMessage?: { id: string; body: string };
}

/**
 * The id to quote. The WhatsApp id wins, but a message that has only just been sent optimistically
 * has no WA id yet, so the local id is the fallback — replying to your own just-sent message is an
 * ordinary thing to do and must not silently lose its quote.
 */
export function quotedIdOf(replyingTo: QuotableMessage | null | undefined): string | undefined {
  if (!replyingTo) return undefined;
  return replyingTo.waMessageId || replyingTo.id;
}

/**
 * Body text for the quoted-message preview. A non-text message has no meaningful body to show, so
 * its type stands in, worded by `typeLabel` so it matches the composer's own reply banner.
 */
function quotedPreviewBody(replyingTo: QuotableMessage, typeLabel: (type: string) => string): string {
  return replyingTo.type && replyingTo.type !== 'text' ? typeLabel(replyingTo.type) : (replyingTo.body ?? '');
}

/**
 * Body for a media send. The quote key is omitted entirely rather than set to `undefined` when the
 * composer is not replying: the API rejects unknown/empty fields, and an always-present key would
 * also make every ordinary media send look like a failed reply in a request log.
 */
export function buildMediaSendPayload(
  attachment: ComposerAttachment,
  caption: string | undefined,
  replyingTo: QuotableMessage | null | undefined,
): { base64: string; mimetype: string; filename?: string; caption?: string; quotedMessageId?: string } {
  const quotedMessageId = quotedIdOf(replyingTo);
  return {
    base64: attachment.base64,
    mimetype: attachment.mimetype,
    filename: attachment.filename,
    caption,
    ...(quotedMessageId ? { quotedMessageId } : {}),
  };
}

/**
 * Metadata for the optimistic bubble. Media and quote are independent: an attachment sent as a
 * reply has both, which is precisely the combination the previous either/or could not express.
 */
export function buildOptimisticMetadata(
  attachment: ComposerAttachment | null | undefined,
  replyingTo: QuotableMessage | null | undefined,
  typeLabel: (type: string) => string,
): OptimisticMetadata | undefined {
  if (!attachment && !replyingTo) return undefined;
  return {
    ...(attachment
      ? { media: { mimetype: attachment.mimetype, filename: attachment.filename, data: attachment.base64 } }
      : {}),
    ...(replyingTo
      ? { quotedMessage: { id: quotedIdOf(replyingTo)!, body: quotedPreviewBody(replyingTo, typeLabel) } }
      : {}),
  };
}
