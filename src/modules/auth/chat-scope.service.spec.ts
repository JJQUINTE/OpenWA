import { ChatScopeService } from './chat-scope.service';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';

const PHONE = '919999999999';
const LID = '555000111';

/** Deterministic persisted-lookup stand-in; the real service reads the lid table on a cache miss. */
function fakeStore(): LidMappingStoreService {
  return {
    resolveLidPersisted: jest.fn((lid: string) => Promise.resolve(lid === LID ? PHONE : null)),
    lidsForPhonePersisted: jest.fn((phone: string) => Promise.resolve(phone === PHONE ? [LID] : [])),
    phonesForLidsPersisted: jest.fn((lids: string[]) =>
      Promise.resolve(Object.fromEntries(lids.map(lid => [lid, lid === LID ? PHONE : null]))),
    ),
    lidsForPhonesPersisted: jest.fn((phones: string[]) =>
      Promise.resolve(Object.fromEntries(phones.map(phone => [phone, phone === PHONE ? [LID] : []]))),
    ),
  } as unknown as LidMappingStoreService;
}

describe('ChatScopeService', () => {
  it('is unrestricted without an allowlist', async () => {
    const svc = new ChatScopeService();
    expect(svc.isRestricted({ allowedChats: null })).toBe(false);
    expect(svc.isRestricted({ allowedChats: [] })).toBe(false);
    expect(svc.scopeFor({ allowedChats: null })).toBeNull();
    expect(await svc.allows({ allowedChats: null }, '123@g.us')).toBe(true);
  });

  it('matches a phone entry to its lid through the persisted directory', async () => {
    const svc = new ChatScopeService(fakeStore());
    expect(svc.isRestricted({ allowedChats: [`${PHONE}@c.us`] })).toBe(true);
    expect(await svc.allows({ allowedChats: [`${PHONE}@c.us`] }, `${LID}@lid`)).toBe(true);
    expect(await svc.allows({ allowedChats: [`${PHONE}@c.us`] }, '888000222@lid')).toBe(false);
  });

  it('does not admit the same-digits @c.us for a @lid entry', async () => {
    const svc = new ChatScopeService(fakeStore());
    expect(await svc.allows({ allowedChats: [`${LID}@lid`] }, `${LID}@c.us`)).toBe(false);
    expect(await svc.allows({ allowedChats: [`${LID}@lid`] }, `${LID}@lid`)).toBe(true);
    expect(await svc.allows({ allowedChats: [`${LID}@lid`] }, `${PHONE}@c.us`)).toBe(true);
  });

  it('filters a list through the batched expansion, passing an unrestricted key through', async () => {
    const svc = new ChatScopeService(fakeStore());
    const rows = [{ id: '123@g.us' }, { id: `${LID}@lid` }, { id: '999@g.us' }];
    expect(await svc.filter({ allowedChats: [`${PHONE}@c.us`] }, rows, r => r.id)).toEqual([{ id: `${LID}@lid` }]);
    expect(await svc.filter({ allowedChats: null }, rows, r => r.id)).toEqual(rows);
  });

  it('degrades to exact dialects when no lid directory is available', async () => {
    const svc = new ChatScopeService();
    expect(await svc.allows({ allowedChats: [`${PHONE}@c.us`] }, `${LID}@lid`)).toBe(false);
    expect(await svc.allows({ allowedChats: [`${PHONE}@c.us`] }, `${PHONE}@c.us`)).toBe(true);
  });
});
