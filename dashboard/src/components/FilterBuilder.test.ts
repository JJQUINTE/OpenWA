// The enum filters offer message types and chat kinds as tags. The values sent are the API's keys;
// the tags must read as words.
import '../test-helpers/register-hooks.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

let rtl: typeof import('@testing-library/react');
let FilterBuilder: (typeof import('./FilterBuilder.tsx'))['FilterBuilder'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ FilterBuilder } = await import('./FilterBuilder.tsx'));
});

after(() => rtl.cleanup());

test('enum tags name message types and chat kinds in words', () => {
  const { container } = rtl.render(
    createElement(FilterBuilder, {
      filters: {
        conditions: [
          { field: 'type', operator: 'is', value: [] },
          { field: 'kind', operator: 'is', value: [] },
        ],
      },
      onChange: () => {},
      chats: [],
    }),
  );

  const [types, kinds] = Array.from(container.querySelectorAll('.filter-enum')).map(row =>
    Array.from(row.querySelectorAll('.enum-tag')).map(tag => tag.textContent),
  );
  assert.ok(types.includes('Voice message'), `message type tags: ${types.join(', ')}`);
  assert.ok(types.includes('Hidden message'), `message type tags: ${types.join(', ')}`);
  // The unclassified bucket is not "any message" (the reply banner's wording for it).
  assert.ok(types.includes('Unknown type'), `message type tags: ${types.join(', ')}`);
  assert.ok(!types.includes('Message'), `message type tags: ${types.join(', ')}`);
  assert.deepEqual(kinds, ['Individual', 'Group', 'Channel', 'Status', 'Broadcast', 'Unknown']);
});
