import { createBaileysLogger } from './baileys-logger';
describe('createBaileysLogger redacts credentials the library hands it', () => {
  const captureLine = (write: (obj: unknown, msg?: string) => void, payload: unknown): Record<string, unknown> => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (chunk: string): boolean => {
      written.push(chunk);
      return true;
    };
    try {
      write(payload);
    } finally {
      (process.stdout as { write: unknown }).write = original;
    }
    return JSON.parse(written.join('')) as Record<string, unknown>;
  };

  it('replaces a proxy password carried by a socks connect error', () => {
    const previous = process.env.BAILEYS_LOG_LEVEL;
    process.env.BAILEYS_LOG_LEVEL = 'debug';
    try {
      const logger = createBaileysLogger();
      const line = captureLine(logger.error, {
        err: { options: { proxy: { host: 'p', port: 1080, userId: 'u', password: 'hunter2' } } },
      });
      expect(JSON.stringify(line)).not.toContain('hunter2');
      expect(JSON.stringify(line)).toContain('[redacted]');
      expect(JSON.stringify(line)).toContain('"host":"p"');
    } finally {
      process.env.BAILEYS_LOG_LEVEL = previous;
    }
  });

  it("keeps an error's message and stack, nested or passed alone, and still redacts its props", () => {
    const previous = process.env.BAILEYS_LOG_LEVEL;
    process.env.BAILEYS_LOG_LEVEL = 'debug';
    try {
      const logger = createBaileysLogger();
      const err = Object.assign(new Error('Socks5 proxy rejected connection'), {
        options: { proxy: { host: 'p', password: 'hunter2' } },
      });
      for (const payload of [{ err }, err]) {
        const line = JSON.stringify(captureLine(logger.error, payload));
        expect(line).toContain('"message":"Socks5 proxy rejected connection"');
        expect(line).toContain('baileys-logger.spec.ts');
        expect(line).not.toContain('hunter2');
        expect(line).toContain('"host":"p"');
      }
    } finally {
      process.env.BAILEYS_LOG_LEVEL = previous;
    }
  });
});
