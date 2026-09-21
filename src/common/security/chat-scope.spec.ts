import {
  buildChatScope,
  buildExpandedChatScope,
  chatIdAllowed,
  chatScopeAllows,
  filterByChatScope,
  isChatScopeRestricted,
  normalizeChatAllowList,
} from './chat-scope';

const PHONE = '919999999999';
const LID = '555000111';
const single = {
  resolveLid: (lid: string) => Promise.resolve(lid === LID ? PHONE : null),
  lidsForPhone: (phone: string) => Promise.resolve(phone === PHONE ? [LID] : []),
};
const batch = {
  phonesForLids: (lids: string[]) =>
    Promise.resolve(Object.fromEntries(lids.map(lid => [lid, lid === LID ? PHONE : null]))),
  lidsForPhones: (phones: string[]) =>
    Promise.resolve(Object.fromEntries(phones.map(phone => [phone, phone === PHONE ? [LID] : []]))),
};

describe('chat-scope', () => {
  it('treats NULL/empty as unrestricted', () => {
    expect(isChatScopeRestricted(null)).toBe(false);
    expect(isChatScopeRestricted([])).toBe(false);
    expect(buildChatScope(null)).toBeNull();
    expect(buildChatScope([])).toBeNull();
    expect(chatScopeAllows(null, '123@g.us')).toBe(true);
  });

  it('admits an allowlisted group and rejects any other', () => {
    const scope = buildChatScope(['123@g.us']);
    expect(chatScopeAllows(scope, '123@g.us')).toBe(true);
    expect(chatScopeAllows(scope, '999@g.us')).toBe(false);
    // A group entry must not admit a contact, and vice versa.
    expect(chatScopeAllows(scope, '123@c.us')).toBe(false);
  });

  it('matches a phone entry against the @lid form through the directory', async () => {
    const scope = buildChatScope([`${PHONE}@c.us`]);
    expect(await chatIdAllowed(scope, `${PHONE}@c.us`, single)).toBe(true);
    expect(await chatIdAllowed(scope, `${PHONE}@s.whatsapp.net`, single)).toBe(true);
    expect(await chatIdAllowed(scope, `${LID}@lid`, single)).toBe(true);
    expect(await chatIdAllowed(scope, '888000222@lid', single)).toBe(false);
  });

  it('does NOT let a phone entry admit the @lid with the same digits', async () => {
    const scope = buildChatScope([`${PHONE}@c.us`]);
    // A lid's digits are not a phone number: `<phone>@lid` is a different entity unless the table
    // maps it, and this lid is not mapped to this phone.
    expect(await chatIdAllowed(scope, `${PHONE}@lid`, single)).toBe(false);
  });

  it('does NOT let a @lid entry admit the same-digits @c.us chat', async () => {
    const scope = buildChatScope([`${LID}@lid`]);
    expect(await chatIdAllowed(scope, `${LID}@lid`, single)).toBe(true);
    expect(await chatIdAllowed(scope, `${LID}@c.us`, single)).toBe(false);
    expect(await chatIdAllowed(scope, `${PHONE}@c.us`, single)).toBe(true);
  });

  it('leaves an unmapped @lid outside the fence', async () => {
    const scope = buildChatScope([`${PHONE}@c.us`]);
    expect(await chatIdAllowed(scope, '777000333@lid', single)).toBe(false);
  });

  it('accepts a bare phone number and matches its canonical chat', async () => {
    const scope = buildChatScope([PHONE]);
    expect(chatScopeAllows(scope, `${PHONE}@c.us`)).toBe(true);
    expect(chatScopeAllows(scope, `${PHONE}@s.whatsapp.net`)).toBe(true);
    expect(await chatIdAllowed(scope, `${LID}@lid`, single)).toBe(true);
  });

  it('a phone entry does not admit the same-digits @lid in the expanded filter scope either', async () => {
    const scope = await buildExpandedChatScope([`${PHONE}@c.us`], batch);
    expect(chatScopeAllows(scope, `${PHONE}@lid`)).toBe(false);
    const rows = [{ id: `${PHONE}@lid` }, { id: `${PHONE}@c.us` }];
    expect(filterByChatScope(scope, rows, r => r.id)).toEqual([{ id: `${PHONE}@c.us` }]);
  });

  it('never admits status, channels or broadcast lists', () => {
    const scope = buildChatScope(['123@g.us', `${PHONE}@c.us`]);
    expect(chatScopeAllows(scope, 'status@broadcast')).toBe(false);
    expect(chatScopeAllows(scope, '123@newsletter')).toBe(false);
    expect(chatScopeAllows(scope, '123@broadcast')).toBe(false);
  });

  it('expands the allowlist once for a list filter (batched directory)', async () => {
    const phoneScope = await buildExpandedChatScope([`${PHONE}@c.us`], batch);
    expect(chatScopeAllows(phoneScope, `${LID}@lid`)).toBe(true);
    const lidScope = await buildExpandedChatScope([`${LID}@lid`], batch);
    expect(chatScopeAllows(lidScope, `${PHONE}@c.us`)).toBe(true);
    // The literal scope is returned unchanged without a directory.
    expect(await buildExpandedChatScope([`${LID}@lid`])).toEqual(buildChatScope([`${LID}@lid`]));
  });

  it('filters a list to the fenced chats, leaving an unrestricted key untouched', async () => {
    const rows = [{ id: '123@g.us' }, { id: '999@g.us' }, { id: `${PHONE}@c.us` }];
    const scope = await buildExpandedChatScope(['123@g.us'], batch);
    expect(filterByChatScope(scope, rows, r => r.id)).toEqual([{ id: '123@g.us' }]);
    expect(filterByChatScope(null, rows, r => r.id)).toEqual(rows);
  });
});

describe('normalizeChatAllowList', () => {
  it('qualifies a bare number to @c.us and de-duplicates', () => {
    expect(normalizeChatAllowList([PHONE])).toEqual([`${PHONE}@c.us`]);
    expect(normalizeChatAllowList([PHONE, `${PHONE}@c.us`])).toEqual([`${PHONE}@c.us`]);
  });

  it('trims, drops empties, and keeps NULL for "unrestricted"', () => {
    expect(normalizeChatAllowList([' 123@g.us ', ''])).toEqual(['123@g.us']);
    expect(normalizeChatAllowList([])).toBeNull();
    expect(normalizeChatAllowList(null)).toBeNull();
  });
});
