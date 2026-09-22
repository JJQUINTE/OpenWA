import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendImageStatusDto, SendVideoStatusDto } from './send-media-status.dto';

describe('SendImageStatusDto recipients validation', () => {
  const valid = { image: { url: 'https://example.com/i.png' }, recipients: ['6281@c.us'] };

  it('accepts a non-empty recipients array', async () => {
    const errors = await validate(plainToInstance(SendImageStatusDto, valid));
    expect(errors).toHaveLength(0);
  });

  it('accepts missing recipients (optional — whatsapp-web.js broadcasts without them)', async () => {
    const errors = await validate(plainToInstance(SendImageStatusDto, { image: valid.image }));
    expect(errors).toHaveLength(0);
  });

  it('accepts an empty recipients array', async () => {
    const errors = await validate(plainToInstance(SendImageStatusDto, { image: valid.image, recipients: [] }));
    expect(errors).toHaveLength(0);
  });

  it('rejects non-string entries', async () => {
    const errors = await validate(plainToInstance(SendImageStatusDto, { image: valid.image, recipients: [123] }));
    expect(errors.some(e => e.property === 'recipients')).toBe(true);
  });

  it('rejects more than 256 recipients', async () => {
    const recipients = Array.from({ length: 257 }, (_, i) => `${i}@c.us`);
    const errors = await validate(plainToInstance(SendImageStatusDto, { image: valid.image, recipients }));
    expect(errors.some(e => e.property === 'recipients')).toBe(true);
  });

  it('rejects malformed JIDs', async () => {
    const errors = await validate(
      plainToInstance(SendImageStatusDto, {
        image: valid.image,
        recipients: ['not-a-jid', '123@g.us', '@c.us', 'abc@lid'],
      }),
    );
    expect(errors.some(e => e.property === 'recipients')).toBe(true);
  });

  it('accepts @lid recipients', async () => {
    const errors = await validate(
      plainToInstance(SendImageStatusDto, { image: valid.image, recipients: ['6281@lid'] }),
    );
    expect(errors).toHaveLength(0);
  });
});

describe('SendVideoStatusDto recipients validation', () => {
  const valid = { video: { url: 'https://example.com/v.mp4' }, recipients: ['6281@c.us'] };

  it('accepts a non-empty recipients array', async () => {
    const errors = await validate(plainToInstance(SendVideoStatusDto, valid));
    expect(errors).toHaveLength(0);
  });

  it('accepts missing recipients (optional — whatsapp-web.js broadcasts without them)', async () => {
    const errors = await validate(plainToInstance(SendVideoStatusDto, { video: valid.video }));
    expect(errors).toHaveLength(0);
  });

  it('accepts an empty recipients array', async () => {
    const errors = await validate(plainToInstance(SendVideoStatusDto, { video: valid.video, recipients: [] }));
    expect(errors).toHaveLength(0);
  });

  it('rejects non-string entries', async () => {
    const errors = await validate(plainToInstance(SendVideoStatusDto, { video: valid.video, recipients: [123] }));
    expect(errors.some(e => e.property === 'recipients')).toBe(true);
  });

  it('rejects more than 256 recipients', async () => {
    const recipients = Array.from({ length: 257 }, (_, i) => `${i}@c.us`);
    const errors = await validate(plainToInstance(SendVideoStatusDto, { video: valid.video, recipients }));
    expect(errors.some(e => e.property === 'recipients')).toBe(true);
  });

  it('rejects malformed JIDs', async () => {
    const errors = await validate(
      plainToInstance(SendVideoStatusDto, {
        video: valid.video,
        recipients: ['not-a-jid', '123@g.us', '@c.us', 'abc@lid'],
      }),
    );
    expect(errors.some(e => e.property === 'recipients')).toBe(true);
  });

  it('accepts @lid recipients', async () => {
    const errors = await validate(
      plainToInstance(SendVideoStatusDto, { video: valid.video, recipients: ['6281@lid'] }),
    );
    expect(errors).toHaveLength(0);
  });
});

// Both engines fetch only a string that starts with http(s):// and decode anything else as base64.
describe('status media url', () => {
  it('accepts only an absolute http(s) url', async () => {
    for (const url of ['example.com/a.jpg', 'ftp://example.com/a.jpg']) {
      const errors = await validate(plainToInstance(SendImageStatusDto, { image: { url } }));
      expect(errors.some(e => e.property === 'image')).toBe(true);
    }
    for (const url of [
      'https://example.com/a.jpg',
      'HTTPS://example.com/a.jpg',
      'http://media-store/a.jpg',
      'http://media_server:8080/a.jpg',
      `https://bucket.s3.amazonaws.com/k.mp4?X-Amz-Security-Token=${'a'.repeat(2100)}`,
    ]) {
      expect(await validate(plainToInstance(SendVideoStatusDto, { video: { url } }))).toHaveLength(0);
    }
  });

  it('ignores a url sent next to base64, which wins', async () => {
    const both = { image: { base64: 'AAAA', mimetype: 'image/jpeg', url: 'cdn/banner.jpg' } };
    expect(await validate(plainToInstance(SendImageStatusDto, both))).toHaveLength(0);
    const alone = await validate(plainToInstance(SendImageStatusDto, { image: { url: 'cdn/banner.jpg' } }));
    expect(alone.some(e => e.property === 'image')).toBe(true);
    // A base64 that is only a data-URI prefix strips to nothing, so the url is what would be sent.
    const emptyBase64 = { image: { base64: 'data:image/jpeg;base64,', mimetype: 'image/jpeg', url: 'cdn/banner.jpg' } };
    const refused = await validate(plainToInstance(SendImageStatusDto, emptyBase64));
    expect(refused.some(e => e.property === 'image')).toBe(true);
  });
});
