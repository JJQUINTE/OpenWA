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

test('parseEditScope: a bound scope cannot be blanked, since the API would keep it', () => {
  assert.deepEqual(parseEditScope('sess-a', ' sess-b '), { ok: true, value: 'sess-b' });
  assert.deepEqual(parseEditScope('sess-a', 'sess-a'), { ok: true, value: 'sess-a' });
  assert.deepEqual(parseEditScope(null, 'sess-b'), { ok: true, value: 'sess-b' });
  // Blank on an all-sessions instance: omit, nothing changes.
  assert.deepEqual(parseEditScope(null, '  '), { ok: true, value: undefined });
  assert.deepEqual(parseEditScope('*', ''), { ok: true, value: undefined });
  // Blank on a bound instance: an omitted field leaves the binding in place, so refuse it.
  assert.equal(parseEditScope('sess-a', '').ok, false);
});
