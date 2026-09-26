/**
 * The credential of an `Authorization: Bearer <token>` header, or `undefined` for any other shape.
 * The scheme is matched case-insensitively (RFC 7235 section 2.1), so every surface that reads the
 * header accepts the same spellings.
 */
export function bearerToken(header: string | undefined): string | undefined {
  return header ? /^bearer\s+(\S+)\s*$/i.exec(header)?.[1] : undefined;
}
