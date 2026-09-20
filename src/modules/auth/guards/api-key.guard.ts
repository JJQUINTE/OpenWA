import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { AuthService } from '../auth.service';
import { ChatScopeService } from '../chat-scope.service';
import { ApiKeyRole } from '../entities/api-key.entity';
import { REQUIRED_ROLE_KEY, PUBLIC_KEY, SESSION_SCOPED_KEY, UNSCOPED_KEY } from '../decorators/auth.decorators';
import { resolveClientIp } from '../../../common/utils/ip';
import { setRequestActor } from '../../../common/services/request-context';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../audit/entities/audit-log.entity';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    private readonly chatScope: ChatScopeService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [context.getHandler(), context.getClass()]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    try {
      return await this.authorize(request, context);
    } catch (err) {
      // Record rejected/denied authentication attempts so the audit log has a forensic trail for
      // credential probing. Fire-and-forget: audit logging is best-effort and must never turn a
      // 401/403 into a failure of the guard itself.
      if (err instanceof UnauthorizedException || err instanceof ForbiddenException) {
        // Stamp at least the IP so the failed-auth audit row below is attributable even though the
        // key was never resolved. setRequestActor is a no-op outside a request scope.
        setRequestActor({ ipAddress: this.getClientIp(request) });
        void this.auditService.logWarn(AuditAction.API_KEY_AUTH_FAILED, {
          ipAddress: this.getClientIp(request),
          method: request.method,
          path: request.path,
          errorMessage: err.message,
        });
      }
      throw err;
    }
  }

  private async authorize(request: Request, context: ExecutionContext): Promise<boolean> {
    const apiKeyHeader = this.extractApiKey(request);

    if (!apiKeyHeader) {
      throw new UnauthorizedException('API key is required');
    }

    const requiredRole = this.reflector.getAllAndOverride<ApiKeyRole>(REQUIRED_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Resolve the session id used for the key's allowedSessions scope. `:sessionId` is always a
    // session; the bare `:id` param is only a session on controllers marked @SessionScoped (i.e.
    // SessionController) — on other routes `:id` is an unrelated resource id (API key, plugin, …)
    // and must NOT be fed to the allowedSessions check, which would spuriously deny a scoped key.
    const sessionScoped = this.reflector.getAllAndOverride<boolean>(SESSION_SCOPED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const sessionId = (request.params['sessionId'] || (sessionScoped ? request.params['id'] : undefined)) as
      string | undefined;
    const clientIp = this.getClientIp(request);

    // Validate API key
    const apiKey = await this.authService.validateApiKey(apiKeyHeader, clientIp, sessionId);

    // Stamp the resolved actor into the per-request async context so downstream audit log writes —
    // which fire from services deep in the call stack without DI access to the key — can attribute
    // the action to this key + IP. Without this every audit row's apiKey/ipAddress column is blank
    // because call sites pass only { sessionId } etc.
    //
    // Stamped HERE, the moment the key is known, rather than after the authorization checks below:
    // both of those throw, and the catch that audits the denial cannot see `apiKey` (it is a const
    // inside this method). Stamping afterwards meant every 403 the guard raised was recorded against
    // an IP alone — behind NAT or a proxy without TRUSTED_PROXIES that IP is common to every tenant,
    // so the operator could see that a key had been denied but not which one to revoke.
    setRequestActor({ apiKeyId: apiKey.id, apiKeyName: apiKey.name, ipAddress: clientIp });

    if (requiredRole && !this.authService.hasPermission(apiKey, requiredRole)) {
      throw new ForbiddenException(`Insufficient permissions. Required: ${requiredRole}`);
    }

    // Chat fence. Routes that name a chat in the path — `:chatId`, `:groupId`, `:contactId` — are
    // rejected when the chat is outside the key's `allowedChats`, exactly as a session outside
    // `allowedSessions` is rejected inside validateApiKey. An unrestricted key (no allowlist) admits
    // every chat, so the model stays fail-open. List routes (`/chats`, `/contacts`, `/groups`, …) and
    // sends whose target travels in the body carry no such param; they scope themselves through
    // ChatScopeService, which is what the structural coverage spec enforces.
    const scopedChatId = (request.params['chatId'] || request.params['groupId'] || request.params['contactId']) as
      string | undefined;
    if (scopedChatId && !this.chatScope.allows(apiKey, scopedChatId)) {
      throw new ForbiddenException('API key not authorized for this chat');
    }

    // Body fence. Sends carry their target chat in the body, not the path (`POST /messages` and the
    // other write routes). Every send DTO names it `chatId`, so one check here fences the whole send
    // surface instead of one per handler — and a handler cannot forget it. Remaining body shapes
    // (bulk `items[].chatId`, forward `to`) are enumerated by the structural coverage spec.
    const body: unknown = request.body;
    const bodyChatId = body !== null && typeof body === 'object' ? (body as { chatId?: unknown }).chatId : undefined;
    if (typeof bodyChatId === 'string' && bodyChatId && !this.chatScope.allows(apiKey, bodyChatId)) {
      throw new ForbiddenException('API key not authorized for this chat');
    }

    // Routes marked @RequireUnscopedKey carry no session dimension, so the allowedSessions check
    // above can never bite on them. A session-scoped key reaching such a surface (e.g. API-key
    // lifecycle management) could mint or widen credentials beyond its own confinement — reject it
    // outright, whatever its role. The denial is audited by the caller's catch block.
    const requireUnscoped = this.reflector.getAllAndOverride<boolean>(UNSCOPED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requireUnscoped && (apiKey.allowedSessions?.length ?? 0) > 0) {
      throw new ForbiddenException('Session-scoped API keys are not permitted on this route');
    }

    // Attach API key to request for use in controllers
    (request as Request & { apiKey: typeof apiKey }).apiKey = apiKey;
    // Expose the trusted-proxy-aware client IP so controllers (e.g. the audit trail on key lifecycle
    // ops) reuse the already-resolved value instead of re-deriving it.
    (request as Request & { clientIp?: string }).clientIp = clientIp;

    return true;
  }

  private extractApiKey(request: Request): string | undefined {
    // Support both X-API-Key header and Authorization Bearer
    const xApiKey = request.headers['x-api-key'] as string;
    if (xApiKey) return xApiKey;

    const authHeader = request.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    return undefined;
  }

  /**
   * Resolve the real client IP used for the API key's allowedIps whitelist.
   *
   * X-Forwarded-For is client-controllable, so it is only honored when the
   * request actually arrives from a configured trusted proxy (TRUSTED_PROXIES).
   * With no trusted proxies configured, the header is ignored entirely and the
   * direct socket address is used — preventing IP-whitelist spoofing.
   */
  private getClientIp(request: Request): string {
    const trustedProxies = this.configService.get<string[]>('security.trustedProxies') ?? [];
    return resolveClientIp(request, trustedProxies);
  }
}
