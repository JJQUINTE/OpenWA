// Render test for the chat thread's write actions. The gateway answers reply, react, delete and a
// prompt-button tap only for an operator key, so a read-only key must not be offered them. It also
// checks the thread, not just the helpers, resolves an @mention in a body and in a quote.
import '../../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, createRef } from 'react';
import type { Chat } from '../../services/api.ts';
import type { ChatMessageView } from '../../utils/chatMessages.ts';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let ChatThread: typeof import('./ChatThread.tsx').default;
let RoleProvider: typeof import('../RoleProvider.tsx').RoleProvider;

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../RoleProvider.tsx'));
  ({ default: ChatThread } = await import('./ChatThread.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  window.sessionStorage.removeItem('openwa_user_role');
});

const CHAT: Chat = {
  id: '15551234567@c.us',
  name: 'Alice',
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp: 1_700_000_000,
  archived: false,
  pinned: false,
  muted: false,
};

const PROMPT: ChatMessageView = {
  id: 'db-1',
  waMessageId: 'wamid.1',
  chatId: CHAT.id,
  from: CHAT.id,
  to: 'me',
  body: 'Confirm?',
  type: 'text',
  direction: 'incoming',
  status: 'delivered',
  timestamp: 1_700_000_000,
  createdAt: new Date(1_700_000_000_000).toISOString(),
  metadata: { buttons: [{ id: 'y', text: 'Yes' }] },
};

function renderThread(
  role: string,
  messages: ChatMessageView[] = [PROMPT],
  activeChat: Chat = CHAT,
): { clicks: string[]; container: HTMLElement } {
  window.sessionStorage.setItem('openwa_user_role', role);
  const clicks: string[] = [];
  const noop = () => {};
  const { container } = rtl.render(
    createElement(
      RoleProvider,
      null,
      createElement(ChatThread, {
        sessionId: 's1',
        activeChat,
        messages,
        loadingMessages: false,
        messagesError: false,
        messagesContainerRef: createRef<HTMLDivElement>(),
        hasMoreMessages: false,
        loadingOlderMessages: false,
        onLoadOlderMessages: noop,
        onMediaLoad: noop,
        measureMedia: noop,
        onOpenImage: noop,
        onReply: noop,
        onReact: noop,
        onDelete: noop,
        onClickButton: async (_message, button) => {
          clicks.push(button.id);
        },
      }),
    ),
  );
  return { clicks, container };
}

test('a read-only key sees prompt choices disabled and no reply, react or delete actions', () => {
  const { clicks, container } = renderThread('viewer');
  const yes = rtl.screen.getByRole('button', { name: 'Yes' });
  assert.equal(yes.matches(':disabled'), true);
  rtl.fireEvent.click(yes);
  assert.deepEqual(clicks, []);
  assert.ok(!container.querySelector('.message-actions-menu'));
});

test('an operator key can tap a prompt choice and gets the message actions', async () => {
  const { clicks, container } = renderThread('operator');
  const yes = rtl.screen.getByRole('button', { name: 'Yes' });
  assert.equal(yes.matches(':disabled'), false);
  rtl.fireEvent.click(yes);
  await rtl.waitFor(() => assert.deepEqual(clicks, ['y']));
  assert.ok(container.querySelector('.message-actions-menu'));
});

test('an optimistic bubble with no WhatsApp id yet offers no reply, react or delete', () => {
  // Every action addresses the message by its WhatsApp id; a pending or failed placeholder only has
  // its local temp_ id, which the gateway can never resolve.
  for (const status of ['pending', 'failed'] as const) {
    const { container } = renderThread('operator', [
      { ...PROMPT, id: 'temp_1', waMessageId: undefined, direction: 'outgoing', status, metadata: undefined },
    ]);
    assert.ok(!container.querySelector('.message-actions-menu'), `a ${status} placeholder offered actions`);
    rtl.cleanup();
  }
});

test('an @mention of a participant who posted in the thread shows their first name, in the body and the quote', () => {
  const GROUP: Chat = { ...CHAT, id: '120363000000000000@g.us', name: 'Team', isGroup: true, kind: 'group' };
  const fromBob: ChatMessageView = {
    ...PROMPT,
    id: 'db-bob',
    waMessageId: 'wamid.bob',
    chatId: GROUP.id,
    from: GROUP.id,
    author: '15551230000@c.us',
    chatName: 'Bob Smith',
    body: 'hello',
    metadata: undefined,
  };
  const mentioning: ChatMessageView = {
    ...fromBob,
    id: 'db-mention',
    waMessageId: 'wamid.mention',
    author: '15559990000@c.us',
    chatName: 'Ann',
    body: 'thanks @15551230000',
    timestamp: 1_700_000_001,
    metadata: { quotedMessage: { id: 'wamid.bob', body: 'ping @15551230000' } },
  };
  const { container } = renderThread('viewer', [fromBob, mentioning], GROUP);
  const body = [...container.querySelectorAll('.message-text')].find(el => el.textContent?.startsWith('thanks'));
  assert.equal(body?.querySelector('bdi')?.textContent, '@Bob');
  assert.equal(container.querySelector('.quote-body bdi')?.textContent, '@Bob');
});
