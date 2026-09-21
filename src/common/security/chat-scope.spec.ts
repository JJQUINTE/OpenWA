import {
  buildChatScope,
  chatScopeAllows,
  filterByChatScope,
  isChatScopeRestricted,
  normalizeChatAllowList,
} from './chat-scope';

const PHONE = '919999999999';
const LID = '555000111';
const directory = {
  resolveLid: (lid: string) => (lid === LID ? PHONE : null),
  lidsForPhone: (phone: string) => (phone === PHONE ? [LID] : []),
};

describe('chat-scope', () => {
  it('treats NULL/empty as unrestricted', async () => {
    expect(isChatScopeRestricted(null)).toBe(false);
    expect(isChatScopeRestricted([])).toBe(false);
    expect(await buildChatScope(null)).toBeNull();
    expect(await buildChatScope([])).toBeNull();
    expect(chatScopeAllows(null, '123@g.us')).toBe(true);
  });

  it('admits an allowlisted group and rejects any other', async () => {
    const scope = await buildChatScope(['123@g.us']);
    expect(chatScopeAllows(scope, '123@g.us')).toBe(true);
    expect(chatScopeAllows(scope, '999@g.us')).toBe(false);
    // A group entry must not admit a contact, and vice versa.
    expect(chatScopeAllows(scope, '123@c.us')).toBe(false);
  });

  it('matches a phone entry against the @lid form through the directory', async () => {
    const scope = await buildChatScope([`${PHONE}@c.us`], directory);
    expect(chatScopeAllows(scope, `${PHONE}@c.us`)).toBe(true);
    expect(chatScopeAllows(scope, `${PHONE}@s.whatsapp.net`)).toBe(true);
    expect(chatScopeAllows(scope, `${LID}@lid`)).toBe(true);
    expect(chatScopeAllows(scope, '888000222@lid')).toBe(false);
  });

  it('does NOT let a @lid entry admit the same-digits @c.us chat', async () => {
    const scope = await buildChatScope([`${LID}@lid`], directory);
    expect(chatScopeAllows(scope, `${LID}@lid`)).toBe(true);
    // A lid's digits are not a phone number: the phone form must resolve through the table, and
    // `<lid-digits>@c.us` is a different entity that must stay outside the fence.
    expect(chatScopeAllows(scope, `${LID}@c.us`)).toBe(false);
    expect(chatScopeAllows(scope, `${PHONE}@c.us`)).toBe(true);
  });

  it('leaves an unmapped @lid outside the fence', async () => {
    const scope = await buildChatScope([`${PHONE}@c.us`], directory);
    expect(chatScopeAllows(scope, '777000333@lid')).toBe(false);
  });

  it('accepts a bare phone number and matches its canonical chat', async () => {
    const scope = await buildChatScope([PHONE], directory);
    expect(chatScopeAllows(scope, `${PHONE}@c.us`)).toBe(true);
    expect(chatScopeAllows(scope, `${PHONE}@s.whatsapp.net`)).toBe(true);
    expect(chatScopeAllows(scope, `${LID}@lid`)).toBe(true);
  });

  it('never admits status, channels or broadcast lists', async () => {
    const scope = await buildChatScope(['123@g.us', `${PHONE}@c.us`]);
    expect(chatScopeAllows(scope, 'status@broadcast')).toBe(false);
    expect(chatScopeAllows(scope, '123@newsletter')).toBe(false);
    expect(chatScopeAllows(scope, '123@broadcast')).toBe(false);
  });

  it('filters a list to the fenced chats, leaving an unrestricted key untouched', async () => {
    const rows = [{ id: '123@g.us' }, { id: '999@g.us' }, { id: `${PHONE}@c.us` }];
    expect(filterByChatScope(await buildChatScope(['123@g.us']), rows, r => r.id)).toEqual([{ id: '123@g.us' }]);
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
