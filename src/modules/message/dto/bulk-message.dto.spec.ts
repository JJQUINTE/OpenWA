import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendBulkMessageDto } from './bulk-message.dto';

// Mirror the global ValidationPipe (main.ts): whitelist + forbidNonWhitelisted strip/reject unknown
// props. Before the nested media objects were typed DTOs they were bare object literals, so these
// options could not reach inside a media object — junk in `content.image` passed straight through
// and was persisted verbatim.
const validateBulk = (obj: unknown) =>
  validate(plainToInstance(SendBulkMessageDto, obj), { whitelist: true, forbidNonWhitelisted: true });

const imageItem = (image: unknown) => ({
  messages: [{ chatId: 'c@c.us', type: 'image', content: { image } }],
});

describe('SendBulkMessageDto nested media validation', () => {
  it('accepts a well-formed base64 media object', async () => {
    expect(await validateBulk(imageItem({ base64: 'AAAA', mimetype: 'image/png' }))).toHaveLength(0);
  });

  it('rejects an unknown property inside a media object', async () => {
    expect((await validateBulk(imageItem({ base64: 'AAAA', evil: 'x' }))).length).toBeGreaterThan(0);
  });

  it('rejects a non-string base64 inside a media object', async () => {
    expect((await validateBulk(imageItem({ base64: 12345 }))).length).toBeGreaterThan(0);
  });
});

const textItem = (text: string, extra: Record<string, unknown> = {}) => ({
  messages: [{ chatId: 'c@c.us', type: 'text', content: { text }, ...extra }],
});

describe('SendBulkMessageDto content length + variables validation', () => {
  it('accepts text at the 4096 cap and rejects beyond it (parity with single-send)', async () => {
    expect(await validateBulk(textItem('a'.repeat(4096)))).toHaveLength(0);
    expect((await validateBulk(textItem('a'.repeat(4097)))).length).toBeGreaterThan(0);
  });

  it('accepts an object variables map and rejects a non-object', async () => {
    expect(await validateBulk(textItem('hi', { variables: { name: 'Alice' } }))).toHaveLength(0);
    expect((await validateBulk(textItem('hi', { variables: 'oops' }))).length).toBeGreaterThan(0);
    expect((await validateBulk(textItem('hi', { variables: [1, 2, 3] }))).length).toBeGreaterThan(0);
  });
});

describe('SendBulkMessageDto recipient', () => {
  it('rejects an empty chatId', async () => {
    expect((await validateBulk(textItem('hi'))).length).toBe(0);
    const errors = await validateBulk({ messages: [{ chatId: '', type: 'text', content: { text: 'hi' } }] });
    expect(errors.length).toBeGreaterThan(0);
  });
});

// The url scheme is checked by the service after `variables` are applied, because a placeholder may
// stand for the whole URL; the DTO only requires a string.
describe('SendBulkMessageDto media url', () => {
  it('leaves a templated url to the per-item check', async () => {
    expect(await validateBulk(imageItem({ url: '{{imageUrl}}' }))).toHaveLength(0);
    expect(await validateBulk(imageItem({ url: 'https://{{host}}/a.jpg' }))).toHaveLength(0);
  });

  it('rejects a non-string url even next to base64', async () => {
    expect((await validateBulk(imageItem({ base64: 'AAAA', url: 123 }))).length).toBeGreaterThan(0);
  });
});
