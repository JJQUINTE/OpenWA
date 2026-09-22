import { isChatId } from './is-chat-id.validator';

describe('isChatId', () => {
  it('accepts well-formed group, contact and lid ids', () => {
    expect(isChatId('120363000000000000@g.us')).toBe(true);
    expect(isChatId('1234567890-1234567890@g.us')).toBe(true);
    expect(isChatId('919999999999@c.us')).toBe(true);
    expect(isChatId('919999999999@s.whatsapp.net')).toBe(true);
    expect(isChatId('555000111@lid')).toBe(true);
    expect(isChatId('919999999999')).toBe(true);
  });

  it('rejects the simple-array footguns (empty, comma, surrounding whitespace)', () => {
    expect(isChatId('')).toBe(false);
    expect(isChatId('   ')).toBe(false);
    expect(isChatId(' 919999999999@c.us')).toBe(false);
    expect(isChatId('919999999999@c.us ')).toBe(false);
    expect(isChatId('919999999999@c.us,555@lid')).toBe(false);
  });

  it('rejects non-chat ids and special channels', () => {
    expect(isChatId('not-a-jid')).toBe(false);
    expect(isChatId('status@broadcast')).toBe(false);
    expect(isChatId('123@newsletter')).toBe(false);
    expect(isChatId('123@broadcast')).toBe(false);
    expect(isChatId('abc@c.us')).toBe(false);
    expect(isChatId(42)).toBe(false);
  });
});
