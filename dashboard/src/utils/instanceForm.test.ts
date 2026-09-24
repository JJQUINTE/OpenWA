import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidInstanceId, isValidInstanceSecret, parseEditScope, parseInstanceConfig } from './instanceForm.ts';

test('isValidInstanceId accepts the backend charset, rejects the rest', () => {
  assert.equal(isValidInstanceId('acme-support_1'), true);
  assert.equal(isValidInstanceId(''), false);
  assert.equal(isValidInstanceId('has space'), false);
  assert.equal(isValidInstanceId('a'.repeat(65)), false);
  assert.equal(isValidInstanceId('bad:colon'), false);
});

test('isValidInstanceSecret: blank → auto-generate, short → rejected, >=16 → accepted', () => {
  assert.equal(isValidInstanceSecret(''), true);
  assert.equal(isValidInstanceSecret('   '), true); // whitespace-only = blank
  assert.equal(isValidInstanceSecret('too-short'), false);
  assert.equal(isValidInstanceSecret('x'.repeat(15)), false);
  assert.equal(isValidInstanceSecret('x'.repeat(16)), true);
  assert.equal(isValidInstanceSecret('  0123456789abcdef01234567  '), true); // padded value trims to a valid length
});

test('parseInstanceConfig: blank → undefined, object → parsed, invalid → not ok', () => {
  assert.deepEqual(parseInstanceConfig('   '), { ok: true, value: undefined });
  assert.deepEqual(parseInstanceConfig('{"a":1}'), { ok: true, value: { a: 1 } });
  assert.equal(parseInstanceConfig('nope').ok, false);
  assert.equal(parseInstanceConfig('[1,2]').ok, false); // array is not a config object
});

test('parseEditScope: a blank field resets a bound scope to all sessions', () => {
  assert.equal(parseEditScope('sess-a', ' sess-b '), 'sess-b');
  assert.equal(parseEditScope('sess-a', 'sess-a'), 'sess-a');
  assert.equal(parseEditScope(null, 'sess-b'), 'sess-b');
  // Blank on an all-sessions instance: omit, nothing changes.
  assert.equal(parseEditScope(null, '  '), undefined);
  // Blank on a scoped instance: null, which PATCH reads as all sessions (an omitted field would keep it).
  assert.equal(parseEditScope('sess-a', ''), null);
  assert.equal(parseEditScope('*', ''), null);
});
