import { NotImplementedException } from '@nestjs/common';
import type { Client } from 'whatsapp-web.js';
import { WwebjsMessaging } from './wwebjs-messaging';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';

/**
 * whatsapp-web.js returns null from sendMessage, without touching the page, for some content shapes
 * on a channel or a status/broadcast recipient (Client.js sendMessage). Read as a result, that null
 * is a 500 saying the message may have gone out, which the send breaker counts. These pin the 501
 * the adapter answers instead, before the library is called at all. It is a plain 501 rather than
 * EngineNotSupportedError: the methods are supported, only these recipients are refused, and that
 * class marks a whole method unavailable in the capability matrix.
 */

const logger = createLogger('wwebjs-send-shape-refusal.spec');

function makeMessaging(): { messaging: WwebjsMessaging; client: { sendMessage: jest.Mock } } {
  const client = {
    sendMessage: jest.fn().mockResolvedValue({ id: { _serialized: 'M1' }, timestamp: 1 }),
  };
  const host = {
    ensureReady: jest.fn(),
    ensureNotChannelRecipient: jest.fn(),
    getClient: () => client as unknown as Client,
    logger,
    config: {},
    getNumberId: jest.fn(),
    reportIfPageTransportError: jest.fn(),
  } as unknown as WwebjsEngineHost;
  return { messaging: new WwebjsMessaging(host), client };
}

const IMAGE = {
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  mimetype: 'image/png',
};
const QUOTED = 'true_628111@c.us_3EB0ABCD';
const CHANNEL = '120363000000000000@newsletter';
const STATUS = 'status@broadcast';
const LIST = '1700000000@broadcast';

type Send = (m: WwebjsMessaging, to: string) => Promise<unknown>;
const location: Send = (m, to) => m.sendLocationMessage(to, { latitude: 1, longitude: 2 });
const contact: Send = (m, to) => m.sendContactMessage(to, { name: 'Alice', number: '628999' });
const poll: Send = (m, to) => m.sendPollMessage(to, { name: 'Q', options: ['a', 'b'] });
const sticker: Send = (m, to) => m.sendStickerMessage(to, IMAGE);
const quotedText: Send = (m, to) => m.sendTextMessage(to, 'hi', undefined, { quotedMessageId: QUOTED });
const quotedImage: Send = (m, to) => m.sendImageMessage(to, { ...IMAGE, quotedMessageId: QUOTED });

describe('WwebjsMessaging: a send whatsapp-web.js drops for the recipient', () => {
  it.each([
    ['location', CHANNEL, location],
    ['contact card', CHANNEL, contact],
    ['quoted text', CHANNEL, quotedText],
    ['quoted image', CHANNEL, quotedImage],
    ['location', STATUS, location],
    ['contact card', STATUS, contact],
    ['poll', STATUS, poll],
    ['sticker', STATUS, sticker],
    ['quoted text', STATUS, quotedText],
    ['location', LIST, location],
    ['contact card', LIST, contact],
    ['poll', LIST, poll],
    ['sticker', LIST, sticker],
    ['quoted image', LIST, quotedImage],
  ])('refuses a %s to %s with a 501 and never calls the library', async (_shape, to, send) => {
    const { messaging, client } = makeMessaging();

    const err = (await send(messaging, to).catch((e: unknown) => e)) as NotImplementedException;

    expect(err).toBeInstanceOf(NotImplementedException);
    expect(err.getStatus()).toBe(501);
    expect(err.message).toContain('nothing was sent');
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses a reply to a channel before looking the quoted message up', async () => {
    const { messaging, client } = makeMessaging();
    const getChatById = jest.fn();
    Object.assign(client, { getChatById });

    await expect(messaging.replyToMessage(CHANNEL, QUOTED, 'hi')).rejects.toBeInstanceOf(NotImplementedException);
    expect(getChatById).not.toHaveBeenCalled();
  });

  // Known-negative control: the shapes the library does send there must still reach it, or the guard
  // would be refusing working sends.
  it.each([
    ['poll', CHANNEL, poll],
    ['plain text', STATUS, (m: WwebjsMessaging, to: string) => m.sendTextMessage(to, 'hi')],
    ['plain image', LIST, (m: WwebjsMessaging, to: string) => m.sendImageMessage(to, IMAGE)],
    ['location', '628111@c.us', location],
    ['quoted text', '120363000000000000@g.us', quotedText],
  ])('still sends a %s to %s', async (_shape, to, send) => {
    const { messaging, client } = makeMessaging();

    await send(messaging, to);

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });
});
