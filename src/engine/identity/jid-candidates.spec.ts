import { resolveJidCandidates } from './jid-candidates';

const PHONE = '919999999999';
const LID = '555000111';
const directory = {
  resolveLid: (lid: string) => (lid === LID ? PHONE : null),
  lidsForPhone: (phone: string) => (phone === PHONE ? [LID] : []),
};

describe('resolveJidCandidates', () => {
  it('expands a phone into both user dialects and every lid mapped to it', async () => {
    const out = await resolveJidCandidates(`${PHONE}@c.us`, directory);
    expect(out).toEqual(expect.arrayContaining([`${PHONE}@c.us`, `${PHONE}@s.whatsapp.net`, `${LID}@lid`]));
  });

  it('expands a lid into its phone and never into the same-digits @c.us', async () => {
    const out = await resolveJidCandidates(`${LID}@lid`, directory);
    expect(out).toContain(`${LID}@lid`);
    expect(out).toContain(`${PHONE}@c.us`);
    expect(out).not.toContain(`${LID}@c.us`);
  });

  it('fails closed on a group, status or channel id (literal only)', async () => {
    expect(await resolveJidCandidates('123@g.us', directory)).toEqual(['123@g.us']);
    expect(await resolveJidCandidates('status@broadcast', directory)).toEqual(['status@broadcast']);
    expect(await resolveJidCandidates('123@newsletter', directory)).toEqual(['123@newsletter']);
  });

  it('qualifies a bare number', async () => {
    const out = await resolveJidCandidates(PHONE, directory);
    expect(out).toContain(`${PHONE}@c.us`);
    expect(out).toContain(`${LID}@lid`);
  });

  it('works without a directory (dialects only)', async () => {
    expect(await resolveJidCandidates(`${PHONE}@c.us`)).toEqual([`${PHONE}@c.us`, `${PHONE}@s.whatsapp.net`]);
    expect(await resolveJidCandidates(`${LID}@lid`)).toEqual([`${LID}@lid`]);
  });
});
