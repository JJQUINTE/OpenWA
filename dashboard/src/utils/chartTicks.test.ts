// Pinned to a zone east of UTC so the hour conversion is visible. Node reads TZ when it next needs
// the zone, and nothing in this file has touched a Date yet.
process.env.TZ = 'Asia/Jakarta';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTick } from './chartTicks.ts';

test('an hour bucket is shown in the local zone', () => {
  assert.equal(formatTick('2026-06-24 02:00:00', '24h'), '09:00');
  // Past local midnight the hour still lands right; the day is not part of the label.
  assert.equal(formatTick('2026-06-24 20:00:00', '24h'), '03:00');
});

test('a day bucket keeps its UTC month and day', () => {
  assert.equal(formatTick('2026-06-24', '7d'), '06-24');
  assert.equal(formatTick('2026-06-24', '30d'), '06-24');
});

test('a bucket that does not parse falls back to its text', () => {
  assert.equal(formatTick('2026-13-45 14:00:00', '24h'), '14:00');
});
