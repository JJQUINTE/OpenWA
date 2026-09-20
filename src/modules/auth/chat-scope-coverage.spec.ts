// Structural guard for the chat-scope class of bug: an API key restricted with `allowedChats` must
// not reach a chat outside its fence.
//
// There are two enforcement shapes, and this spec pins both:
//
//   1. PATH — a handler with a `:chatId` / `:groupId` / `:contactId` route param is fenced by the
//      ApiKeyGuard (api-key.guard.ts), the same way `allowedSessions` fences a `:sessionId`.
//   2. QUERY / BODY — a chat id that travels in `?chatId=` or in the request body cannot be seen by
//      the guard's route-param fence. The guard reads `body.chatId` (every send DTO names it that),
//      and handlers that take `@Query('chatId')` must scope through ChatScopeService.
//
// This spec fails when a handler takes a chat id in the query or body and is neither covered by the
// guard's body rule nor known to this file — so a later endpoint cannot bypass the fence silently.
// Known-uncovered handlers are listed in ALLOWLIST with the reason they are not yet fenced; each
// entry is work still owed, and the list is expected to shrink to empty.
import { readdirSync, readFileSync } from 'fs';
import { basename, join, sep } from 'path';

/**
 * Route params the ApiKeyGuard fences as chat ids. Kept in sync with the guard by the assertion
 * below, so narrowing the guard cannot silently drop a param class.
 */
const GUARD_CHAT_PARAMS = ['chatId', 'groupId', 'contactId'];

/**
 * Handlers that take an in-body or in-query chat id and are not yet fenced, awaiting the follow-up
 * slices of the chat-scope feature. Key format: `<controller file basename> :: <handler name>`.
 * Every entry needs a reason. This list is expected to shrink to empty.
 */
const ALLOWLIST = new Map<string, string>([
  ['message.controller.ts :: getMessages', 'GET /messages without chatId: require chatId or filter the page'],
  ['message.controller.ts :: sendBulk', 'bulk send: each items[].chatId must be checked'],
  ['message.controller.ts :: forward', 'forward target travels as `to`, not chatId'],
]);

/**
 * Request DTOs that carry a chat id, mapped to how the id is named. `chatId` is fenced centrally by
 * the ApiKeyGuard's body rule; any other chat-targeting property (e.g. forward's `to`) is not, so a
 * `@Body()` of that shape is an offender until a handler checks it or it is allowlisted.
 */
function chatBearingDtoClasses(dir: string): Map<string, 'chatId' | 'other'> {
  const out = new Map<string, 'chatId' | 'other'>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) continue;
      const source = readFileSync(full, 'utf8');
      // Split on class boundaries so a chatId in one class does not mark an earlier one.
      for (const chunk of source.split(/export\s+class\s+/).slice(1)) {
        const name = /^([A-Za-z0-9_]+)/.exec(chunk)?.[1];
        if (!name) continue;
        if (/\bchatId[!?]?\s*:/.test(chunk)) out.set(name, 'chatId');
        else if (/\b(?:to|recipient)[!?]?\s*:/.test(chunk)) out.set(name, 'other');
      }
    }
  };
  walk(dir);
  return out;
}

/** Return handlers that take a chat id in the query or body but do not use ChatScopeService. */
export function handlersMissingChatScope(source: string, chatDtos: Map<string, 'chatId' | 'other'>): string[] {
  const offenders: string[] = [];
  // Two-space indentation is the controller convention; requiring it keeps a deeper call inside a
  // method body (`      this.svc.get(`) from being mistaken for a handler declaration.
  const handlerRe = /((?:^ {2}@[\s\S]*?)?)^ {2}(?:async\s+)?([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\)\s*[:{]/gm;
  const matches: { name: string; from: number }[] = [];
  for (let m = handlerRe.exec(source); m !== null; m = handlerRe.exec(source)) {
    matches.push({ name: m[2], from: m.index });
  }
  for (let i = 0; i < matches.length; i++) {
    const { name, from } = matches[i];
    const to = matches[i + 1]?.from ?? source.length;
    const body = source.slice(from, to);
    if (name === 'constructor') continue;
    // Guard-covered path param: the guard fences it, nothing to do here.
    if (new RegExp(`@Param\\(\\s*['"](?:${GUARD_CHAT_PARAMS.join('|')})['"]\\s*\\)`).test(body)) continue;
    const takesChatIdQuery = /@Query\(\s*['"]chatId['"]\s*\)/.test(body);
    const bodyDto = /@Body\(\)\s*[A-Za-z0-9_]+\s*:\s*([A-Za-z0-9_]+)/.exec(body)?.[1];
    // A `chatId` body is fenced by the guard; any other chat-targeting body field is not.
    const takesUnfencedChatBody = bodyDto !== undefined && chatDtos.get(bodyDto) === 'other';
    if (!takesChatIdQuery && !takesUnfencedChatBody) continue;
    if (/chatScope/.test(body)) continue;
    offenders.push(name);
  }
  return offenders;
}

function listControllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listControllerFiles(full));
    else if (entry.name.endsWith('.controller.ts') && !entry.name.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

describe('chat-scoped keys cannot reach chats outside their allowedChats', () => {
  it('the guard fences both the path chat params and body.chatId', () => {
    const guard = readFileSync(join(__dirname, 'guards', 'api-key.guard.ts'), 'utf8');
    for (const param of GUARD_CHAT_PARAMS) {
      expect(guard).toContain(`request.params['${param}']`);
    }
    expect(guard).toMatch(/bodyChatId/);
  });

  it('flags a handler that reads @Query(chatId) without ChatScopeService', () => {
    const vulnerable = `
  async getThing(
    @Query('chatId') chatId?: string,
  ): Promise<unknown> {
    return this.svc.get(chatId);
  }
`;
    expect(handlersMissingChatScope(vulnerable, new Map())).toEqual(['getThing']);
  });

  it('clears a chatId body (the guard fences it) but flags another chat-targeting body field', () => {
    const source = `
  async sendThing(
    @Body() dto: SendThingDto,
  ): Promise<unknown> {
    return this.svc.send(dto);
  }
`;
    expect(handlersMissingChatScope(source, new Map([['SendThingDto', 'chatId']]))).toEqual([]);
    expect(handlersMissingChatScope(source, new Map([['SendThingDto', 'other']]))).toEqual(['sendThing']);
  });

  it('clears a path-param handler (the guard fences it) and a handler using chatScope', () => {
    const fenced = `
  async getThing(
    @Param('chatId') chatId: string,
  ): Promise<unknown> {
    return this.svc.get(chatId);
  }

  async sendThing(
    @CurrentApiKey() apiKey: ApiKey,
    @Body() dto: SendThingDto,
  ): Promise<unknown> {
    if (!this.chatScope.allows(apiKey, dto.chatId)) throw new ForbiddenException();
    return this.svc.send(dto);
  }
`;
    expect(handlersMissingChatScope(fenced, new Map([['SendThingDto', 'other']]))).toEqual([]);
  });

  it('no real controller takes a chat id without a fence or an allowlisted reason', () => {
    const modulesDir = join(__dirname, '..');
    const chatDtos = chatBearingDtoClasses(join(modulesDir));
    expect(chatDtos.size).toBeGreaterThan(0); // the DTO scan must not silently collapse
    const offenders: string[] = [];
    for (const file of listControllerFiles(modulesDir)) {
      const fileName = basename(file);
      const posixPath = file.split(sep).join('/');
      for (const handler of handlersMissingChatScope(readFileSync(file, 'utf8'), chatDtos)) {
        if (ALLOWLIST.has(`${fileName} :: ${handler}`)) continue;
        offenders.push(`${posixPath.replace(/.*\/src\//, 'src/')} :: ${handler}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
