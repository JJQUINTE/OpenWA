import { buildChatScope, chatScopeAllows, filterByChatScope, isChatScopeRestricted } from './chat-scope';

const PHONE = '919999999999';
const LID = '555000111';
const directory = {
  resolveLid: (jid: string) => (jid.startsWith(`${LID}@lid`) ? PHONE : null),
  lidsForPhone: (phone: string) => (phone === PHONE ? [LID] : []),
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

  it('matches a phone entry against the @lid form through the directory', () => {
    const scope = buildChatScope([`${PHONE}@c.us`], directory);
    expect(chatScopeAllows(scope, `${PHONE}@c.us`)).toBe(true);
    expect(chatScopeAllows(scope, `${LID}@lid`)).toBe(true);
    expect(chatScopeAllows(scope, '888000222@lid')).toBe(false);
  });

  it('matches a @lid entry against the phone form through the directory', () => {
    const scope = buildChatScope([`${LID}@lid`], directory);
    expect(chatScopeAllows(scope, `${LID}@lid`)).toBe(true);
    expect(chatScopeAllows(scope, `${PHONE}@c.us`)).toBe(true);
  });

  it('leaves an unmapped @lid outside the fence', () => {
    const scope = buildChatScope([`${PHONE}@c.us`], directory);
    expect(chatScopeAllows(scope, '777000333@lid')).toBe(false);
  });

  it('accepts a bare phone number as a contact entry', () => {
    const scope = buildChatScope([PHONE], directory);
    expect(chatScopeAllows(scope, `${PHONE}@c.us`)).toBe(true);
    expect(chatScopeAllows(scope, `${LID}@lid`)).toBe(true);
  });

  it('normalizes the @s.whatsapp.net dialect to the same contact', () => {
    const scope = buildChatScope([`${PHONE}@s.whatsapp.net`]);
    expect(chatScopeAllows(scope, `${PHONE}@c.us`)).toBe(true);
  });

  it('never admits status, channels or broadcast lists', () => {
    const scope = buildChatScope(['123@g.us', `${PHONE}@c.us`]);
    expect(chatScopeAllows(scope, 'status@broadcast')).toBe(false);
    expect(chatScopeAllows(scope, '123@newsletter')).toBe(false);
    expect(chatScopeAllows(scope, '123@broadcast')).toBe(false);
  });

  it('filters a list to the fenced chats, leaving an unrestricted key untouched', () => {
    const rows = [{ id: '123@g.us' }, { id: '999@g.us' }, { id: `${PHONE}@c.us` }];
    expect(filterByChatScope(buildChatScope(['123@g.us']), rows, r => r.id)).toEqual([{ id: '123@g.us' }]);
    expect(filterByChatScope(null, rows, r => r.id)).toEqual(rows);
  });
});
