// i18n keys for enum values the API sends as raw keys.

/**
 * The key naming a message type where the type is a category: a chart slice, a webhook filter
 * value. `unknown` there is an unclassified type, so it cannot use chats.messageType.unknown, the
 * reply banner's generic "Message", which would read as "any message".
 */
export const messageTypeLabelKey = (type: string): string =>
  type === 'unknown' ? 'chats.messageType.unknownType' : `chats.messageType.${type}`;
