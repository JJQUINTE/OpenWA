/**
 * Resolve the effective chat filter for a scoped read or send, mirroring `session-scope.ts`.
 *
 * An API key's `allowedChats` is a curated allowlist of chat ids — groups, and/or individual
 * contacts — independent of `allowedSessions`. A key with no allowlist (NULL/empty) is unrestricted;
 * with one, it may reach only the chats inside the fence.
 *
 * Matching is expansion, not string comparison: each allowlist entry is expanded by
 * {@link resolveJidCandidates} into every JID that refers to the same entity (both user dialects,
 * the lid form of a phone and vice versa, through the directory), and an incoming chat id is
 * reduced to its own address forms before membership. That keeps a lid's digits from being read as
 * a phone: `555000111@lid` admits `555000111@lid` and, once mapped, its phone — never
 * `555000111@c.us`.
 *
 * The directory for the authorization path must be the persisted lookup, not the evictable cache,
 * so the same key and chat cannot pass or fail depending on cache residency.
 */
import { parseWaId } from '../../engine/identity/wa-id';
import { ContactDirectory, resolveJidCandidates } from '../../engine/identity/jid-candidates';

/** A compiled allowlist: the exact JIDs a key may reach (an entry expands to several). */
export interface ChatScope {
  allowed: Set<string>;
}

/** A bare phone number (MSISDN digits) — accepted as a convenience in place of `<phone>@c.us`. */
const BARE_NUMBER = /^\d{5,}$/;

/** True when the key carries a non-empty allowlist, i.e. is actually fenced. */
export function isChatScopeRestricted(allowedChats: string[] | null | undefined): boolean {
  return (allowedChats?.length ?? 0) > 0;
}

/**
 * Canonicalize an `allowedChats` list for storage: trim, drop empties, and qualify a bare phone
 * number to `<digits>@c.us` so a saved entry is the same shape as the chats it must match. Mirrors
 * `normalizeScopeList`'s NULL-not-`[]` contract.
 */
export function normalizeChatAllowList(list: string[] | null | undefined): string[] | null {
  if (list == null) return null;
  const cleaned = list.map(entry => entry.trim()).filter(entry => entry.length > 0);
  const qualified = [...new Set(cleaned.map(entry => (BARE_NUMBER.test(entry) ? `${entry}@c.us` : entry)))];
  return qualified.length > 0 ? qualified : null;
}

/**
 * Compile an `allowedChats` allowlist into a {@link ChatScope}, or `null` for "unrestricted"
 * (NULL/empty). Each entry expands through `directory` — see {@link resolveJidCandidates}.
 */
export async function buildChatScope(
  allowedChats: string[] | null | undefined,
  directory?: ContactDirectory,
): Promise<ChatScope | null> {
  if (!isChatScopeRestricted(allowedChats)) return null;
  const allowed = new Set<string>();
  for (const raw of allowedChats as string[]) {
    const entry = raw.trim();
    if (!entry) continue;
    for (const jid of await resolveJidCandidates(entry, directory)) allowed.add(jid);
  }
  return { allowed };
}

/**
 * The stored address forms of an incoming chat id. A user id has two dialects; a lid and a group
 * each have one; a status/channel/broadcast/unknown id has none and so never matches a contact
 * entry (it is not a chattable contact).
 */
function addressForms(chatId: string): string[] {
  const parsed = parseWaId(chatId);
  switch (parsed.kind) {
    case 'user':
      return [`${parsed.userPart}@c.us`, `${parsed.userPart}@s.whatsapp.net`];
    case 'lid':
      return [`${parsed.userPart}@lid`];
    case 'group':
      return [`${parsed.userPart}@g.us`];
    default:
      return [];
  }
}

/**
 * Whether `chatId` falls inside `scope`. A `null` scope is unrestricted and admits everything.
 */
export function chatScopeAllows(scope: ChatScope | null, chatId: string): boolean {
  if (scope === null) return true;
  return addressForms(chatId).some(form => scope.allowed.has(form));
}

/**
 * Filter `items` down to the chats a scope admits, keyed by `chatIdOf`. A `null` scope returns the
 * list unchanged. List endpoints use this instead of rejecting, because they have no single chat in
 * the path to refuse.
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
