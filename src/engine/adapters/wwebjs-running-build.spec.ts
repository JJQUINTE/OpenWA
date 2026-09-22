import { reportRunningWebBuild } from './wwebjs-running-build';

/**
 * A whatsapp-web.js pin holds only for a page load that goes through the library's request
 * interceptor, so the build a session runs can differ from the one it asked for while the startup
 * log names the pin. This probe reads the build the page reports and says which one it is, warning
 * only when a comparison is actually possible and fails.
 */
describe('reportRunningWebBuild', () => {
  const makeLogger = (): { log: jest.Mock; warn: jest.Mock } => ({ log: jest.fn(), warn: jest.fn() });
  const globals = globalThis as unknown as { window?: unknown };

  /** A page whose evaluate runs the real page-side probe against the given `window`. */
  const pageWithWindow = (pageWindow: unknown): { evaluate: <T>(fn: () => T) => Promise<T> } => ({
    evaluate: <T>(fn: () => T): Promise<T> => {
      globals.window = pageWindow;
      try {
        return Promise.resolve(fn());
      } finally {
        delete globals.window;
      }
    },
  });

  it('logs the running build at info when it matches the pin once the suffix is dropped', async () => {
    const logger = makeLogger();
    const page = pageWithWindow({ Debug: { VERSION: '2.3000.1047868043' } });
    await reportRunningWebBuild(page, logger as never, 'sess-1', '2.3000.1047868043-alpha');
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect((logger.log.mock.calls[0] as [string, Record<string, unknown>])[1]).toEqual({
      sessionId: 'sess-1',
      action: 'web_version_running',
      runningVersion: '2.3000.1047868043',
      pinnedVersion: '2.3000.1047868043-alpha',
    });
  });

  it('warns, naming both builds, when the page runs another build than the pinned one', async () => {
    const logger = makeLogger();
    const page = pageWithWindow({ Debug: { VERSION: '2.3000.1047868043' } });
    await reportRunningWebBuild(page, logger as never, 'sess-1', '2.3000.1047787617-alpha');
    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message, context] = logger.warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain('2.3000.1047868043');
    expect(message).toContain('2.3000.1047787617-alpha');
    expect(message).toContain('the pin did not take effect for this page load');
    expect(context).toEqual({
      sessionId: 'sess-1',
      action: 'web_version_pin_not_applied',
      runningVersion: '2.3000.1047868043',
      pinnedVersion: '2.3000.1047787617-alpha',
    });
  });

  it('logs the running build at info when no pin was requested', async () => {
    const logger = makeLogger();
    const page = pageWithWindow({ Debug: { VERSION: '2.3000.1047868043' } });
    await reportRunningWebBuild(page, logger as never, 'sess-1', undefined);
    expect(logger.warn).not.toHaveBeenCalled();
    expect((logger.log.mock.calls[0] as [string, Record<string, unknown>])[1]).toMatchObject({
      action: 'web_version_running',
      runningVersion: '2.3000.1047868043',
      pinnedVersion: null,
    });
  });

  // A pin that is not a build number cannot be compared, so it is no evidence of a mismatch.
  it('does not warn about a pin that carries no numeric build', async () => {
    const logger = makeLogger();
    const page = pageWithWindow({ Debug: { VERSION: '2.3000.1047868043' } });
    await reportRunningWebBuild(page, logger as never, 'sess-1', 'nightly');
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledTimes(1);
  });

  // An unreadable build is not a different build: none of these may produce a mismatch warning.
  it.each([
    ['the page has no window.Debug', {}],
    ['window.Debug has no VERSION', { Debug: {} }],
    ['VERSION is not a string', { Debug: { VERSION: 2.3 } }],
    ['VERSION is empty', { Debug: { VERSION: '' } }],
  ])('stays silent when %s', async (_label, pageWindow) => {
    const logger = makeLogger();
    await reportRunningWebBuild(pageWithWindow(pageWindow), logger as never, 'sess-1', '2.3000.1047787617-alpha');
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('never throws when the page is gone or the read fails', async () => {
    const logger = makeLogger();
    await reportRunningWebBuild(undefined, logger as never, 'sess-1', '2.3000.1047787617-alpha');
    const dead = { evaluate: jest.fn().mockRejectedValue(new Error('Execution context was destroyed')) };
    await expect(
      reportRunningWebBuild(dead, logger as never, 'sess-1', '2.3000.1047787617-alpha'),
    ).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });
});
