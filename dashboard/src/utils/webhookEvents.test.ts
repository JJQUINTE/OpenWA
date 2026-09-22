// The Webhooks page offers availableEventNames as subscription choices and lists each one with a
// description. The page looks the description up with the event name as its fallback, so a missing
// key renders "message.ack  message.ack" and passes every locale parity check. These tests tie the
// list to the gateway's published event enum and every listed event to a description.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { availableEventNames } from './webhookEvents.ts';

const read = (path: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'));

test('the offered events are exactly the events the gateway accepts', () => {
  const contract = read('../../../openapi.json') as {
    components: { schemas: { CreateWebhookDto: { properties: { events: { items: { enum: string[] } } } } } };
  };
  const accepted = contract.components.schemas.CreateWebhookDto.properties.events.items.enum;
  assert.deepEqual([...availableEventNames].sort(), [...accepted].sort());
});

test('every offered event has a description, and no description names an event not offered', () => {
  const en = read('../i18n/locales/en.json') as { webhooks: { eventDescriptions: Record<string, string> } };
  const described = Object.keys(en.webhooks.eventDescriptions);
  // '*' is described under the 'all' key.
  const expected = availableEventNames.map(name => (name === '*' ? 'all' : name));
  assert.deepEqual(described.sort(), [...expected].sort());
});
