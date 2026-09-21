import { parseWaId } from './wa-id';

/**
 * Engine-neutral expansion of a WhatsApp JID into every form of the same entity (shared by the
 * message chat filter and the API-key chat scope, so the two cannot disagree about identity).
 *
 * - a `<phone>@c.us` / `@s.whatsapp.net` input yields the literal, both user dialects, and every lid
 *   the directory maps to that phone;
 * - a `<lid>@lid` input yields the literal and the phone it resolves to (in both user dialects). It
 *   deliberately does NOT mint `<lid-digits>@c.us`: a lid's digits are not a phone number, and
 *   treating them as one would let `555000111@lid` match a `555000111@c.us` chat.
 * - a group / status / newsletter / broadcast id has exactly one stored form, so it yields only the
 *   literal (expanding a group's digits into the user dialects could match an unrelated person).
 *
 * The last rule is why a non-user kind returns just the input: it fails closed on the literal id.
 */
export interface ContactDirectory {
  /** The phone digits a lid's user-part resolves to, or null/undefined when unmapped. */
  resolveLid(lid: string): string | null | undefined | Promise<string | null | undefined>;
  /** The lid user-parts currently mapped to a phone's digits. */
  lidsForPhone(phone: string): string[] | Promise<string[]>;
}

export async function resolveJidCandidates(value: string, directory?: ContactDirectory): Promise<string[]> {
  const parsed = parseWaId(value);
  if (parsed.kind !== 'user' && parsed.kind !== 'lid' && parsed.kind !== 'unknown') {
    return [value];
  }
  if (parsed.kind === 'lid') {
    const candidates = new Set<string>([value]);
    const resolved = await directory?.resolveLid(parsed.userPart);
    if (resolved) {
      candidates.add(`${resolved}@c.us`);
      candidates.add(`${resolved}@s.whatsapp.net`);
    }
    return [...candidates];
  }
  const phone = parsed.userPart;
  const candidates = new Set<string>([value, `${phone}@c.us`, `${phone}@s.whatsapp.net`]);
  for (const lid of (await directory?.lidsForPhone(phone)) ?? []) {
    candidates.add(`${lid}@lid`);
  }
  return [...candidates];
}
