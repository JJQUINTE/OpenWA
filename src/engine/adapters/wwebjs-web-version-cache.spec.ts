import { Client } from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';

/**
 * The web version cache handed to the whatsapp-web.js Client. Unpinned, the library's default is a
 * local cache written to a cwd-relative directory after the link; in the container that directory
 * is not writable, the write throws before `ready`, and the session never becomes ready.
 */
describe('whatsapp-web.js web version cache', () => {
  let clientInitSpy: jest.SpyInstance;
  let savedWebVersion: string | undefined;

  const launchedCacheOption = async (webVersion: string): Promise<unknown> => {
    process.env.WWEBJS_WEB_VERSION = webVersion;
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 'sess-web-version-cache',
      sessionDataPath: './data/sessions',
      puppeteer: {},
    });
    await adapter.initialize({});
    return (adapter as unknown as { client: { options: { webVersionCache: unknown } } }).client.options.webVersionCache;
  };

  beforeEach(() => {
    savedWebVersion = process.env.WWEBJS_WEB_VERSION;
    // Build the real Client, whose options are merged over the library defaults, but launch no browser.
    clientInitSpy = jest
      .spyOn(Client.prototype as unknown as { initialize: () => Promise<void> }, 'initialize')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    clientInitSpy.mockRestore();
    if (savedWebVersion === undefined) {
      delete process.env.WWEBJS_WEB_VERSION;
    } else {
      process.env.WWEBJS_WEB_VERSION = savedWebVersion;
    }
  });

  it('caches nothing to disk when no build is pinned', async () => {
    expect(await launchedCacheOption('off')).toEqual({ type: 'none' });
  });

  it('keeps the remote cache for a pinned build', async () => {
    expect(await launchedCacheOption('2.3000.1000000000')).toMatchObject({ type: 'remote' });
  });
});
