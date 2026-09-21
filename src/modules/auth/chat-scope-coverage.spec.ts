// Structural guard for the chat-scope class of bug: a key restricted with `allowedChats` must not
// reach a chat outside its fence.
//
// The guard is DEFAULT DENY (api-key.guard.ts): a chat-restricted key is refused with 403 on every
// handler that is not marked @ChatScoped, so surfaces with no chat dimension (webhooks, automation
// rules, status, key management, channels) and every route added later stay closed without being
// enumerated. A marked handler must then be fenceable — the guard inspects the chat id it carries
// (a `:chatId` / `:groupId` / `:contactId` path param, `?chatId=`, or the `chatId` / `fromChatId` /
// `toChatId` / `messages[].chatId` body fields), OR the handler filters its list result through
// ChatScopeService.
//
// This spec fails when a marked handler is neither fenceable nor filters, so marking a handler can
// never quietly become a bypass.
import { readdirSync, readFileSync } from 'fs';
import { basename, join, sep } from 'path';

/** Route params the ApiKeyGuard treats as a chat id. Asserted against the guard's own source below. */
export const GUARD_CHAT_ROUTE_PARAMS = ['chatId', 'groupId', 'contactId'];
/** Body fields the ApiKeyGuard treats as a chat id (bulk send nests `chatId` inside `messages[]`). */
export const GUARD_BODY_CHAT_FIELDS = ['chatId', 'fromChatId', 'toChatId'];

/** Request DTO classes carrying a guard-fenced chat field. */
function chatBearingDtoClasses(dir: string): Set<string> {
  const out = new Set<string>();
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
        const field = GUARD_BODY_CHAT_FIELDS.some(f => new RegExp(`\\b${f}[!?]?\\s*:`).test(chunk));
        // Bulk send carries its recipients in an array field; the guard iterates it.
        const bulkArray = /\bmessages[!?]?\s*:\s*[\w.]*\[\]/.test(chunk);
        if (field || bulkArray) out.add(name);
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Return @ChatScoped handlers in `source` that are neither fenceable by the guard nor filter through
 * ChatScopeService — i.e. marked handlers a chat-restricted key could reach for any chat.
 */
export function markedHandlersWithoutChatFence(source: string, chatDtos: Set<string>): string[] {
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
    const hasBodyChat = bodyDto !== undefined && chatDtos.has(bodyDto);
    // A list handler names no chat, so it must filter its result through ChatScopeService instead.
    const filtersChatScope = /\bchatScope\b/.test(body);
    if (!hasPathChat && !hasQueryChat && !hasBodyChat && !filtersChatScope) offenders.push(name);
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

  it('flags a marked handler with no chat id and no filtering', () => {
    const vulnerable = `
  @ChatScoped()
  @Post('everything')
  async sendThing(@Body() dto: ThingDto): Promise<unknown> {
    return this.svc.send(dto);
  }
`;
    expect(markedHandlersWithoutChatFence(vulnerable, new Set())).toEqual(['sendThing']);
  });

  it('clears a marked handler with a path chat, a query chat, a body chat, or a filter', () => {
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
    expect(markedHandlersWithoutChatFence(fenced, new Set(['SendThingDto']))).toEqual([]);
  });

  it('no marked controller handler is unfenced, and the scan is not vacuous', () => {
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
      for (const handler of markedHandlersWithoutChatFence(source, chatDtos)) {
        offenders.push(`${posixPath.replace(/.*\/src\//, 'src/')} :: ${fileName} :: ${handler}`);
      }
    }
    // Non-vacuity: a scan that found no marked handlers would pass for the wrong reason.
    expect(marked).toBeGreaterThan(30);
    expect(offenders).toEqual([]);
  });
});
