export const INSTANCE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidInstanceId(id: string): boolean {
  return INSTANCE_ID_PATTERN.test(id);
}

type ParseResult = { ok: true; value: Record<string, unknown> | undefined } | { ok: false };

/** Blank → auto-generate (server-side). Otherwise must be a real secret (>= 16 chars), mirroring the server DTO. */
export function isValidInstanceSecret(raw: string): boolean {
  return raw.trim() === '' || raw.trim().length >= 16;
}

/** Blank → no config (undefined). Otherwise must parse to a plain JSON object. */
export function parseInstanceConfig(raw: string): ParseResult {
  if (raw.trim() === '') return { ok: true, value: undefined };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

type ScopeResult = { ok: true; value: string | undefined } | { ok: false };

/**
 * The edit form's session scope. Blank → omit (leave the scope unchanged), which is right for an
 * all-sessions instance. A bound scope cannot be blanked: PATCH reads an omitted field as unchanged
 * and rejects '', so the save would keep the old binding while reporting success.
 */
export function parseEditScope(current: string | null, raw: string): ScopeResult {
  const value = raw.trim();
  if (value) return { ok: true, value };
  return current && current !== '*' ? { ok: false } : { ok: true, value: undefined };
}
