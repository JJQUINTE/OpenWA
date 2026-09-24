import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { workerConnectionOptions } from '../modules/queue/redis-connection';

describe('loadEnvironment', () => {
  let envBackup: NodeJS.ProcessEnv;
  const tempDirs: string[] = [];

  // Create an isolated working directory, write the given files into it (paths relative to the dir),
  // and point process.cwd() at it. The loader reads `.env` / `data/.env.generated` from process.cwd(),
  // so this drives it without touching the real project tree.
  const makeTempCwd = (files: Record<string, string>): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-loadenv-'));
    tempDirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    jest.spyOn(process, 'cwd').mockReturnValue(dir);
    return dir;
  };

  // The loader runs as a side effect on import; resetModules forces a fresh evaluation each call so a
  // test's mocked cwd/env is in effect when it runs (the spec never imports it statically, so it never
  // runs against the real project tree).
  // require() (not dynamic import()) so the relative specifier doesn't trip TS2835 under
  // moduleResolution:nodenext; jest.resetModules() above still forces a fresh module evaluation.
  const runLoader = (): void => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./load-env');
  };

  beforeEach(() => {
    envBackup = { ...process.env };
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envBackup)) delete process.env[key];
    }
    Object.assign(process.env, envBackup);
    jest.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads REDIS_HOST from a .env file so it reaches the webhook worker connection', () => {
    delete process.env.REDIS_HOST;
    makeTempCwd({ '.env': 'REDIS_HOST=redis.internal\n', 'data/.env.generated': '' });

    runLoader();

    expect(process.env.REDIS_HOST).toBe('redis.internal');
    expect(workerConnectionOptions().host).toBe('redis.internal');
  });

  it('lets a real process env value win over the .env file (precedence preserved)', () => {
    process.env.REDIS_HOST = 'host-from-process-env';
    makeTempCwd({
      '.env': 'REDIS_HOST=host-from-dotenv\n',
      'data/.env.generated': 'REDIS_HOST=host-from-generated\n',
    });

    runLoader();

    expect(process.env.REDIS_HOST).toBe('host-from-process-env');
    expect(workerConnectionOptions().host).toBe('host-from-process-env');
  });

  // Older .env templates shipped DATABASE_SSL=false, and compose forwards it, so it silently outranks
  // TLS turned on in the dashboard. The override stands, but the boot log names both values.
  it('warns when a pinned database TLS setting differs from the one saved in the dashboard', () => {
    delete process.env.DATABASE_SSL;
    process.env.DATABASE_SSL_REJECT_UNAUTHORIZED = 'true';
    makeTempCwd({
      '.env': 'DATABASE_SSL=false\n',
      'data/.env.generated': 'DATABASE_SSL=true\nDATABASE_SSL_REJECT_UNAUTHORIZED=false\n',
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    runLoader();

    expect(process.env.DATABASE_SSL).toBe('false');
    expect(warn.mock.calls.map(([line]) => line as string)).toEqual([
      expect.stringMatching(/DATABASE_SSL=false .*DATABASE_SSL=true /),
      expect.stringMatching(/DATABASE_SSL_REJECT_UNAUTHORIZED=true .*DATABASE_SSL_REJECT_UNAUTHORIZED=false /),
    ]);
  });

  it('stays quiet when the pinned TLS setting matches the saved one or nothing pins it', () => {
    process.env.DATABASE_SSL = 'true';
    delete process.env.DATABASE_SSL_REJECT_UNAUTHORIZED;
    makeTempCwd({ 'data/.env.generated': 'DATABASE_SSL=true\nDATABASE_SSL_REJECT_UNAUTHORIZED=false\n' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    runLoader();

    expect(process.env.DATABASE_SSL_REJECT_UNAUTHORIZED).toBe('false');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('main.ts bootstrap order', () => {
  // The webhook Worker's @Processor connection/concurrency are read at module-import time. main.ts must
  // import the env loader FIRST so .env / .env.generated are populated before the module graph (which
  // includes that decorator) is evaluated — otherwise the worker freezes a pre-dotenv localhost Redis.
  // ES imports are hoisted, so this is an ordering invariant that a future reorder could silently break.
  it('imports ./config/load-env as its very first import', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../main.ts'), 'utf8');
    const firstImport = source.split('\n').find(line => /^\s*import\b/.test(line));

    expect(firstImport).toContain('./config/load-env');
  });
});
