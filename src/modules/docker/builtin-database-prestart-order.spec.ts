import * as fs from 'fs';
import * as path from 'path';

/**
 * The data connection dials PostgreSQL inside NestFactory.create, so a stopped built-in database has
 * to be started before that call or the boot crash-loops. The helper's own tests cannot see where
 * main.ts calls it: deleting the call, dropping its `await`, or moving it after NestFactory.create
 * would leave them green. This spec pins the order in main.ts.
 */

function prestartPrecedesCreate(mainSrc: string): boolean {
  const prestart = mainSrc.search(/^\s*await prestartBuiltinDatabase\(\);/m);
  const create = mainSrc.search(/await NestFactory\.create\(/);
  return prestart !== -1 && create !== -1 && prestart < create;
}

describe('built-in database prestart order in main.ts', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'main.ts'), 'utf8');

  it('awaits prestartBuiltinDatabase before NestFactory.create', () => {
    expect(prestartPrecedesCreate(mainSrc)).toBe(true);
  });

  it('the check fails when the call is missing, not awaited, or after create', () => {
    const create = 'const app = await NestFactory.create(AppModule);';
    expect(prestartPrecedesCreate(`  await prestartBuiltinDatabase();\n  ${create}`)).toBe(true);
    expect(prestartPrecedesCreate(`  ${create}`)).toBe(false);
    expect(prestartPrecedesCreate(`  void prestartBuiltinDatabase();\n  ${create}`)).toBe(false);
    expect(prestartPrecedesCreate(`  // await prestartBuiltinDatabase();\n  ${create}`)).toBe(false);
    expect(prestartPrecedesCreate(`  ${create}\n  await prestartBuiltinDatabase();`)).toBe(false);
  });
});
