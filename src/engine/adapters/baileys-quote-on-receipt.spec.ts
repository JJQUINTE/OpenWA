import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { DataSource, Repository } from 'typeorm';
import { BaileysEvents, type BaileysEventsHost } from './baileys-events';
import { BaileysMessaging } from './baileys-messaging';
import { BaileysMessageStoreService } from './baileys-message-store.service';
import { BaileysStoredMessage } from './baileys-stored-message.entity';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { createLogger } from '../../common/services/logger.service';
import { Session, SessionStatus } from '../../modules/session/entities/session.entity';
import type { IncomingMessage } from '../interfaces/whatsapp-engine.interface';

const CHAT = '628111@s.whatsapp.net';
const inbound = (id: string): WAMessage => ({
  key: { id, remoteJid: CHAT, fromMe: false },
  messageTimestamp: 1_700_000_000,
  message: { conversation: 'hi' },
});

/**
 * Real events, real messaging, real store on in-memory SQLite. A consumer that quotes a message the
 * moment it is announced (a quick-reply plugin on message:received) used to lose the race against the
 * store write and fail with `Message <id> not found`.
 */
describe('quoting a Baileys message the moment it is announced', () => {
  let ds: DataSource;
  let repo: Repository<BaileysStoredMessage>;
  let store: BaileysMessageStoreService;
  let release: () => void;
  const ticks = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
  };

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [BaileysStoredMessage, Session],
      synchronize: true,
    });
    await ds.initialize();
    repo = ds.getRepository(BaileysStoredMessage);
    store = new BaileysMessageStoreService(repo);
    await ds
      .getRepository(Session)
      .save(ds.getRepository(Session).create({ id: 's1', name: 's1', status: SessionStatus.READY, config: {} }));
    // Hold the first upsert: the database round trip the consumer lands inside.
    const gate = new Promise<void>(resolve => (release = resolve));
    const real = repo.upsert.bind(repo);
    jest.spyOn(repo, 'upsert').mockImplementationOnce(async (...args: Parameters<typeof real>) => {
      await gate;
      return real(...args);
    });
  });

  afterEach(async () => {
    await ticks(); // let the reply's own fire-and-forget store write land before the database closes
    jest.restoreAllMocks();
    await ds.destroy();
  });

  const build = (
    onMessage: (m: IncomingMessage) => void,
  ): { events: BaileysEvents; messaging: BaileysMessaging; sock: { sendMessage: jest.Mock } } => {
    const sock = {
      sendMessage: jest
        .fn()
        .mockResolvedValue({ key: { id: 'R1', remoteJid: CHAT, fromMe: true }, messageTimestamp: 1 }),
    };
    const host = {
      getSocket: () => sock as unknown as WASocket,
      getSocketOrNull: () => sock as unknown as WASocket,
      logger: createLogger('baileys-quote-on-receipt.spec'),
      toNeutralJid: (j: string) => j,
      toEngineJid: (j: string) => j,
      normalizedSelfJid: () => '628177@s.whatsapp.net',
      loadLib: () =>
        Promise.resolve({
          normalizeMessageContent: (c: unknown) => c,
          getContentType: (c: Record<string, unknown> | undefined) => Object.keys(c ?? {})[0],
          proto: { Message: { ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } } },
        } as never),
      getFetchDispatcher: () => undefined,
      inboundLimiter: new ConcurrencyLimiter(4),
      recordKeyLidMappings: () => undefined,
      recordMessage: () => undefined,
      recordMessageEdit: () => undefined,
      putStoredMessage: (m: WAMessage) => store.put('s1', m),
      getStoredMessage: (id: string) => store.getMessage('s1', id),
      consumeOwnSend: () => false,
      rememberOwnSend: () => undefined,
      recordLidMapping: () => undefined,
      getOnMessage: () => onMessage,
      getOnMessageCreate: () => undefined,
      ensureReady: () => undefined,
      sessionProxyUrl: () => undefined,
      getEphemeralExpiration: () => undefined,
      toUnixSeconds: () => 1,
    };
    const events = new BaileysEvents(host as unknown as BaileysEventsHost);
    const messaging = new BaileysMessaging({
      ...host,
      mapMessage: (...a: Parameters<BaileysEvents['mapMessage']>) => events.mapMessage(...a),
    });
    return { events, messaging, sock };
  };

  it('lets an onMessage consumer quote the message it was just handed', async () => {
    let reply: Promise<unknown> | undefined;
    const { events, messaging, sock } = build(m => {
      reply = messaging.replyToMessage(m.chatId, m.id, 'ok');
    });
    events.handleMessagesUpsert({ messages: [inbound('QUOTE-ME')], type: 'notify' });
    await ticks();
    expect(reply).toBeDefined();
    release();
    await expect(reply).resolves.toMatchObject({ id: 'R1' });
    const [, , options] = sock.sendMessage.mock.calls[0] as [unknown, unknown, { quoted?: WAMessage }];
    expect(options.quoted?.key.id).toBe('QUOTE-ME');
  });

  it('drops a re-delivery that arrives while the first copy is still being stored', async () => {
    const heard = jest.fn();
    const { events } = build(heard);
    events.handleMessagesUpsert({ messages: [inbound('TWICE')], type: 'notify' });
    await ticks();
    events.handleMessagesUpsert({ messages: [inbound('TWICE')], type: 'notify' });
    await ticks();
    release();
    await ticks();
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
