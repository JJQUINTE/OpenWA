/**
 * Resolve the effective chat filter for a scoped read or send, mirroring `session-scope.ts`.
 *
 * An API key's `allowedChats` is a curated allowlist of chat ids — groups, and/or individual
 * contacts — independent of `allowedSessions`. A key with no allowlist (NULL/empty) is unrestricted;
 * with one, it may only read or send to chats inside the fence.
 *
 * Matching is not a string comparison. WhatsApp addresses the same contact through several dialects
 * (`<phone>@c.us`, `<lid>@lid`, and their `@s.whatsapp.net` twin), so an allowlist entry written as
 * a phone must also match the contact's `@lid` form, and vice versa. That cross-mapping is supplied
 * by the caller as a {@link ChatScopeDirectory} backed by the shared lid<->phone table. An
 * unmapped `@lid` stays outside the fence: absent a mapping there is no way to prove it is the
 * allowlisted contact, so it is not admitted.
 *
 * The comparison key is the *user-part* (domain + device suffix stripped). Contacts and groups are
 * kept in separate sets so a group id can never match a contact entry.
 */

/** Lid<->phone lookups, backed by the persisted lid mapping table. Both are pure reads. */
export interface ChatScopeDirectory {
  /** The phone digits a `<lid>@lid` resolves to, or null when it is unmapped. */
  resolveLid(jid: string): string | null;
  /** The <lid> user-parts currently mapped to a phone's digits. */
  lidsForPhone(phone: string): string[];
}

/** A compiled allowlist: user-parts to admit, split by whether they name a group or a contact. */
export interface ChatScope {
  contacts: Set<string>;
  groups: Set<string>;
}

/** A bare phone number (MSISDN digits) — accepted as a convenience in place of `<phone>@c.us`. */
const BARE_NUMBER = /^\d{5,}$/;

/** The user-part of a JID: domain and multi-device suffix stripped (`628:12@s.whatsapp.net` -> `628`). */
function userPart(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

/** The domain of a JID, lowercased, or `''` when it has none. */
function domainOf(jid: string): string {
  const at = jid.lastIndexOf('@');
  return at === -1 ? '' : jid.slice(at + 1).toLowerCase();
}

/** True when the key carries a non-empty allowlist, i.e. is actually fenced. */
export function isChatScopeRestricted(allowedChats: string[] | null | undefined): boolean {
  return (allowedChats?.length ?? 0) > 0;
}

/**
 * Compile an `allowedChats` allowlist into a {@link ChatScope}, or `null` for "unrestricted"
 * (NULL/empty). Contact entries are expanded with their cross-dialect forms through `directory`: a
 * phone entry gains its known lids (and a `@lid` entry its phone), so either form matches the other
 * later.
 */
export function buildChatScope(
  allowedChats: string[] | null | undefined,
  directory?: ChatScopeDirectory,
): ChatScope | null {
  if (!isChatScopeRestricted(allowedChats)) return null;
  const contacts = new Set<string>();
  const groups = new Set<string>();
  for (const raw of allowedChats as string[]) {
    const entry = raw.trim();
    if (!entry) continue;
    const domain = domainOf(entry);
    const user = userPart(entry);
    if (domain === 'g.us') {
      groups.add(user);
      continue;
    }
    if (domain && domain !== 'c.us' && domain !== 's.whatsapp.net' && domain !== 'lid') {
      // status@broadcast, newsletters, broadcast lists and anything unrecognized are not chattable
      // contacts; admit nothing for them.
      continue;
    }
    if (!BARE_NUMBER.test(user)) continue;
    contacts.add(user);
    if (domain === 'c.us' || domain === 's.whatsapp.net') {
      for (const lid of directory?.lidsForPhone(user) ?? []) contacts.add(userPart(lid));
    } else if (domain === 'lid') {
      const phone = directory?.resolveLid(entry);
      if (phone) contacts.add(userPart(phone));
    } else {
      // Bare number: cross-map to its lids as well.
      for (const lid of directory?.lidsForPhone(user) ?? []) contacts.add(userPart(lid));
    }
  }
  return { contacts, groups };
}

/**
 * Whether `chatId` falls inside `scope`. A `null` scope is unrestricted and admits everything; a
 * scoped one admits a group only by group id and a contact only by a user-part in the contact set
 * (phone or mapped lid). Special channels and unknown ids never match a contact entry.
 */
export function chatScopeAllows(scope: ChatScope | null, chatId: string): boolean {
  if (scope === null) return true;
  const domain = domainOf(chatId);
  const user = userPart(chatId);
  if (domain === 'g.us') return scope.groups.has(user);
  if (domain === 'c.us' || domain === 's.whatsapp.net' || domain === 'lid') return scope.contacts.has(user);
  return false;
}

/**
 * Filter `items` down to the chats a scope admits, keyed by `chatIdOf`. A `null` scope returns the
 * list unchanged. List endpoints (`/chats`, `/contacts`, `/groups`, `/search`, …) use this instead
 * of rejecting, because they have no single chat in the path to refuse.
 */
export function filterByChatScope<T>(
  scope: ChatScope | null,
  items: readonly T[],
  chatIdOf: (item: T) => string | null | undefined,
): T[] {
  if (scope === null) return [...items];
  return items.filter(item => {
    const id = chatIdOf(item);
    return id != null && chatScopeAllows(scope, id);
  });
}
