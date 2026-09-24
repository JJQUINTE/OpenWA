import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerceFieldInput, emptyForField, fillClearedFields } from './pluginConfigForm.ts';
import type { PluginConfigField } from '../services/api';

const num: PluginConfigField = { type: 'number' };
const str: PluginConfigField = { type: 'string' };

test('coerceFieldInput: a cleared number field becomes undefined (never an empty string)', () => {
  assert.equal(coerceFieldInput(num, ''), undefined);
});

test('coerceFieldInput: a non-empty number is coerced to a Number', () => {
  assert.equal(coerceFieldInput(num, '42'), 42);
});

test('coerceFieldInput: a string field passes the raw value through unchanged', () => {
  assert.equal(coerceFieldInput(str, ''), '');
  assert.equal(coerceFieldInput(str, 'hi'), 'hi');
});

test('emptyForField: a number field seeds to undefined, not an empty string', () => {
  assert.equal(emptyForField(num), undefined);
});

test('emptyForField: a string field seeds to an empty string', () => {
  assert.equal(emptyForField(str), '');
});

// The save merges over the stored config and JSON drops an undefined key, so simply omitting a
// cleared field would keep its old value.
test('fillClearedFields: a cleared field saves its default, or null when it had a value and has none', () => {
  const properties: Record<string, PluginConfigField> = {
    cooldownSec: { type: 'number', default: 60 },
    timeoutMs: { type: 'number' },
    retries: { type: 'number' },
    name: str,
  };
  const values = { cooldownSec: undefined, timeoutMs: undefined, retries: undefined, name: 'bot' };
  const stored = { cooldownSec: 30, timeoutMs: 5000, name: 'bot' };

  assert.deepEqual(fillClearedFields(values, stored, properties), {
    cooldownSec: 60,
    timeoutMs: null,
    retries: undefined, // never stored: nothing to clear, so nothing is written
    name: 'bot',
  });
});
