import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ApiKeyRole } from '../entities/api-key.entity';
import { Request } from 'express';
import { ApiKey } from '../entities/api-key.entity';

export const REQUIRED_ROLE_KEY = 'requiredRole';
export const PUBLIC_KEY = 'isPublic';
export const SESSION_SCOPED_KEY = 'sessionScoped';
export const UNSCOPED_KEY = 'requireUnscopedKey';
export const CHAT_SCOPED_KEY = 'chatScoped';

/**
 * Mark a route as requiring a specific role
 * @example @RequireRole(ApiKeyRole.ADMIN)
 */
export const RequireRole = (role: ApiKeyRole) => SetMetadata(REQUIRED_ROLE_KEY, role);

/**
 * Mark a controller (or route) whose `:id` route param denotes a WhatsApp session id, so the
 * ApiKeyGuard enforces a key's `allowedSessions` scope against it. Without this, `:id` is treated
 * as an opaque resource id (e.g. an API-key or plugin id) and is NOT used for session scoping —
 * preventing the guard from spuriously denying a session-restricted key on unrelated routes.
 * @example @SessionScoped() @Controller('sessions')
 */
export const SessionScoped = () => SetMetadata(SESSION_SCOPED_KEY, true);

/**
 * Mark a route as public (no API key required)
 * @example @Public()
 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/**
 * Mark a controller (or route) as off-limits to session-scoped API keys, regardless of role. The
 * ApiKeyGuard session fence can only compare against a session id carried in the route params, so
 * surfaces with no session dimension at all (e.g. API-key lifecycle management) would otherwise be
 * fully reachable by a scoped key — letting it mint or widen credentials beyond its own confinement.
 * @example @RequireUnscopedKey() @Controller('auth/api-keys')
 */
export const RequireUnscopedKey = () => SetMetadata(UNSCOPED_KEY, true);

/**
 * Mark a handler (or controller) a chat-restricted key — one carrying `allowedChats` — may reach.
 *
 * This is an ALLOWLIST, not a restriction: a chat-restricted key is refused with 403 on every route
 * that is NOT marked, so surfaces with no chat dimension (webhooks, automation rules, status, key
 * management, channels) — and every route added later — stay closed without having to enumerate
 * them. A handler is safe to mark in one of three ways:
 *
 * - **fenced by path, body or query** — it names a chat the ApiKeyGuard inspects (`:chatId` /
 *   `:groupId` / `:contactId`, `?chatId=`, or the `chatId` / `fromChatId` / `toChatId` /
 *   `messages[].chatId` body fields);
 * - **filtered** — it lists chats instead of naming one, and filters the result through
 *   ChatScopeService;
 * - **chat-agnostic** — it names no chat at all, so the mark itself is the assertion that it cannot
 *   reach one. This is the one category the structural coverage spec cannot derive (a webhook with
 *   `events: ['*']` also names no chat), so the mark is a deliberate operator decision.
 *
 * @example @ChatScoped() @Get(':chatId')
 */
export const ChatScoped = () => SetMetadata(CHAT_SCOPED_KEY, true);

/**
 * Get the current API key from request
 * @example @CurrentApiKey() apiKey: ApiKey
 */
export const CurrentApiKey = createParamDecorator((data: unknown, ctx: ExecutionContext): ApiKey | undefined => {
  const request = ctx.switchToHttp().getRequest<Request & { apiKey?: ApiKey }>();
  return request.apiKey;
});
