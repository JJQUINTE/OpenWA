// Structural guard for the chat-scope class of bug: a key restricted with `allowedChats` must not
// reach a chat outside its fence.
//
// The guard is DEFAULT DENY (api-key.guard.ts): a chat-restricted key is refused with 403 on every
// handler that is not marked @ChatScoped, so surfaces with no chat dimension (webhooks, automation
// rules, status, key management, channels) and every route added later stay closed without being
// enumerated.
//
// Marking a handler is the operator's assertion that it is safe for such a key, and it is safe in
// one of three ways:
//
//   1. fenced — it names a chat the guard inspects (a `:chatId` / `:groupId` / `:contactId` path
//      param, `?chatId=`, or the `chatId` / `fromChatId` / `toChatId` / `messages[].chatId` body
//      fields);
//   2. filtered — it lists chats and filters them through ChatScopeService;
//   3. chat-agnostic — it names no chat at all.
//
// This spec fails when a marked handler reaches chats by a field the guard does NOT read (a
// `recipients[]`, `participants[]`, `channelId`, …) while naming no guard-visible chat — the class of
// route the design calls out (status posts, group creation). A chat-agnostic handler is accepted: the
// mark is the assertion, and the spec cannot derive it, since a webhook with `events: ['*']` also
// names no chat.
import { readdirSync, readFileSync } from 'fs';
import { basename, join, sep } from 'path';

/** Route params the ApiKeyGuard treats as a chat id. Asserted against the guard's own source below. */
export const GUARD_CHAT_ROUTE_PARAMS = ['chatId', 'groupId', 'contactId'];
/** Body fields the ApiKeyGuard treats as a chat id (bulk send nests `chatId` inside `messages[]`). */
export const GUARD_BODY_CHAT_FIELDS = ['chatId', 'fromChatId', 'toChatId'];
/** Chat-targeting field names the guard does NOT read — reaching a chat through one is the hazard. */
const UNFENCED_CHAT_FIELDS = ['recipients', 'participants', 'channelId', 'chatIds', 'groupIds', 'contactIds'];

const GUARD_FIELD_RE = new RegExp(`\\b(?:${GUARD_BODY_CHAT_FIELDS.join('|')})[!?]?\\s*:`);
const UNFENCED_FIELD_RE = new RegExp(`\\b(?:${UNFENCED_CHAT_FIELDS.join('|')})[!?]?\\s*:`);
const BULK_ARRAY_RE = /\bmessages[!?]?\s*:\s*[\w.]*\[\]/;

/**
 * Request DTO classes that carry a chat id, classified by whether the guard fences the field it
 * carries. `guard` wins over `other`: a DTO the guard can fence is safe to mark.
 */
export function chatBearingDtoClasses(dir: string): Map<string, 'guard' | 'other'> {
  const out = new Map<string, 'guard' | 'other'>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) continue;
      // Split on class boundaries so a field in one class does not mark an earlier one.
      for (const chunk of readFileSync(full, 'utf8')
        .split(/export\s+class\s+/)
        .slice(1)) {
        const name = /^([A-Za-z0-9_]+)/.exec(chunk)?.[1];
        if (!name) continue;
        if (GUARD_FIELD_RE.test(chunk) || BULK_ARRAY_RE.test(chunk)) out.set(name, 'guard');
        else if (UNFENCED_FIELD_RE.test(chunk)) out.set(name, 'other');
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Return @ChatScoped handlers in `source` that reach chats through a field the guard does not read
 * while naming no guard-visible chat — marked handlers a chat-restricted key could use to reach any
 * chat. A marked handler that names a guard-visible chat is fenced by the guard; one that names no
 * chat at all is chat-agnostic and accepted (the mark is the assertion).
 */
export function markedHandlersReachingUnfencedChats(
  source: string,
  chatDtos: Map<string, 'guard' | 'other'>,
): string[] {
  const offenders: string[] = [];
  const handlerRe = /((?:^ {2}@[\s\S]*?)?)^ {2}(?:async\s+)?([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\)\s*[:{]/gm;
  const matches: { name: string; from: number; decorators: string }[] = [];
  for (let m = handlerRe.exec(source); m !== null; m = handlerRe.exec(source)) {
    matches.push({ name: m[2], from: m.index, decorators: m[1] ?? '' });
  }
  for (let i = 0; i < matches.length; i++) {
    const { name, from, decorators } = matches[i];
    if (!/@ChatScoped\(\)/.test(decorators)) continue;
    const body = source.slice(from, matches[i + 1]?.from ?? source.length);
    const hasPathChat = new RegExp(`@Param\\(\\s*['"](?:${GUARD_CHAT_ROUTE_PARAMS.join('|')})['"]\\s*\\)`).test(body);
    const hasQueryChat = /@Query\(\s*['"]chatId['"]\s*\)/.test(body);
    const bodyDto = /@Body\(\)\s*[A-Za-z0-9_]+\s*:\s*([A-Za-z0-9_]+)/.exec(body)?.[1];
    const hasGuardBodyChat = bodyDto !== undefined && chatDtos.get(bodyDto) === 'guard';
    // A chat-agnostic handler names no chat: accepted, the mark is the assertion.
    const namesGuardChat = hasPathChat || hasQueryChat || hasGuardBodyChat;
    const unfencedQuery = new RegExp(`@Query\\(\\s*['"](?:${UNFENCED_CHAT_FIELDS.join('|')})['"]\\s*\\)`).test(body);
    const unfencedBody = bodyDto !== undefined && chatDtos.get(bodyDto) === 'other';
    const filtersChatScope = /\bchatScope\b/.test(body);
    if (!namesGuardChat && (unfencedQuery || unfencedBody) && !filtersChatScope) offenders.push(name);
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

describe('a chat-restricted key can only reach a handler fenced to its allowedChats', () => {
  it('the guard denies by default and fences every chat id it can see', () => {
    const guard = readFileSync(join(__dirname, 'guards', 'api-key.guard.ts'), 'utf8');
    // Default deny: unmarked route with a restricted key ⇒ 403.
    expect(guard).toContain('CHAT_SCOPED_KEY');
    expect(guard).toContain('API key is restricted to selected chats');
    // The fence reads the route params, the query, and the body fields.
    for (const param of GUARD_CHAT_ROUTE_PARAMS) expect(guard).toContain(`'${param}'`);
    for (const field of GUARD_BODY_CHAT_FIELDS) expect(guard).toContain(`'${field}'`);
    expect(guard).toContain("['chatId']");
    expect(guard).toContain('messages');
  });

  it('flags a marked handler that reaches chats by a field the guard does not read', () => {
    const vulnerable = `
  @ChatScoped()
  @Post('status')
  async postStatus(@Body() dto: SendStatusDto): Promise<unknown> {
    return this.svc.post(dto);
  }
`;
    expect(markedHandlersReachingUnfencedChats(vulnerable, new Map([['SendStatusDto', 'other']]))).toEqual([
      'postStatus',
    ]);
  });

  it('clears a marked chat-agnostic handler (it names no chat — the mark is the assertion)', () => {
    const agnostic = `
  @ChatScoped()
  @Get('profile')
  async profile(@Param('sessionId') sessionId: string): Promise<unknown> {
    return this.svc.profile(sessionId);
  }
`;
    expect(markedHandlersReachingUnfencedChats(agnostic, new Map())).toEqual([]);
  });

  it('clears a marked handler fenced by a path chat, a query chat, a body chat, or a filter', () => {
    const fenced = `
  @ChatScoped()
  @Get(':chatId')
  async getOne(@Param('chatId') chatId: string): Promise<unknown> {
    return this.svc.get(chatId);
  }

  @ChatScoped()
  @Get()
  async list(@Query('chatId') chatId?: string): Promise<unknown> {
    return this.svc.list(chatId);
  }

  @ChatScoped()
  @Post()
  async send(@Body() dto: SendThingDto): Promise<unknown> {
    return this.svc.send(dto);
  }

  @ChatScoped()
  @Get('chats')
  async chats(@CurrentApiKey() apiKey: ApiKey): Promise<unknown> {
    return this.chatScope.filter(apiKey, await this.svc.chats(), c => c.id);
  }
`;
    expect(markedHandlersReachingUnfencedChats(fenced, new Map([['SendThingDto', 'guard']]))).toEqual([]);
  });

  it('clears a marked group route: the :groupId in the path fences the participants it carries', () => {
    const group = `
  @ChatScoped()
  @Post(':groupId/participants')
  async addParticipants(@Param('groupId') groupId: string, @Body() dto: AddParticipantsDto): Promise<unknown> {
    return this.svc.add(groupId, dto);
  }
`;
    expect(markedHandlersReachingUnfencedChats(group, new Map([['AddParticipantsDto', 'other']]))).toEqual([]);
  });

  it('no marked controller handler reaches an unfenced chat, and the scan is not vacuous', () => {
    const modulesDir = join(__dirname, '..');
    const chatDtos = chatBearingDtoClasses(modulesDir);
    expect(chatDtos.size).toBeGreaterThan(0); // the DTO scan must not silently collapse
    const files = listControllerFiles(modulesDir);
    expect(files.length).toBeGreaterThan(10);
    let marked = 0;
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      marked += [...source.matchAll(/^ {2}@ChatScoped\(\)$/gm)].length;
      const fileName = basename(file);
      const posixPath = file.split(sep).join('/');
      for (const handler of markedHandlersReachingUnfencedChats(source, chatDtos)) {
        offenders.push(`${posixPath.replace(/.*\/src\//, 'src/')} :: ${fileName} :: ${handler}`);
      }
    }
    // Non-vacuity: a scan that found no marked handlers would pass for the wrong reason.
    expect(marked).toBeGreaterThan(30);
    expect(offenders).toEqual([]);
  });
});
