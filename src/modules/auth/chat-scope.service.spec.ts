import { ChatScopeService } from './chat-scope.service';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';

const PHONE = '919999999999';
const LID = '555000111';

/** Deterministic persisted-lookup stand-in; the real service reads the lid table on a cache miss. */
function fakeStore(): LidMappingStoreService {
  return {
    resolveLidPersisted: jest.fn((lid: string) => Promise.resolve(lid === LID ? PHONE : null)),
    lidsForPhonePersisted: jest.fn((phone: string) => Promise.resolve(phone === PHONE ? [LID] : [])),
  } as unknown as LidMappingStoreService;
}

describe('ChatScopeService', () => {
  it('is unrestricted without an allowlist', async () => {
    const svc = new ChatScopeService();
    expect(svc.isRestricted({ allowedChats: null })).toBe(false);
    expect(svc.isRestricted({ allowedChats: [] })).toBe(false);
    expect(await svc.scopeFor({ allowedChats: null })).toBeNull();
    expect(await svc.allows({ allowedChats: null }, '123@g.us')).toBe(true);
  });

  it('matches a phone entry to its lid through the persisted directory', async () => {
    const store = fakeStore();
    const svc = new ChatScopeService(store);
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

  it('filters a list, passing an unrestricted key through', async () => {
    const svc = new ChatScopeService(fakeStore());
    const rows = [{ id: '123@g.us' }, { id: '999@g.us' }];
    expect(await svc.filter({ allowedChats: ['123@g.us'] }, rows, r => r.id)).toEqual([{ id: '123@g.us' }]);
    expect(await svc.filter({ allowedChats: null }, rows, r => r.id)).toEqual(rows);
  });

  it('degrades to exact dialects when no lid directory is available', async () => {
    const svc = new ChatScopeService();
    expect(await svc.allows({ allowedChats: [`${PHONE}@c.us`] }, `${LID}@lid`)).toBe(false);
    expect(await svc.allows({ allowedChats: [`${PHONE}@c.us`] }, `${PHONE}@c.us`)).toBe(true);
  });
});
