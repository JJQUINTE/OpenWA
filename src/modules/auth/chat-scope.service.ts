import { Injectable, Optional } from '@nestjs/common';
import { ApiKey } from './entities/api-key.entity';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import {
  ChatScope,
  ChatScopeDirectory,
  buildChatScope,
  chatScopeAllows,
  filterByChatScope,
  isChatScopeRestricted,
} from '../../common/security/chat-scope';

/**
 * Compiles an API key's `allowedChats` into an enforceable {@link ChatScope} and answers membership,
 * wiring the shared lid<->phone directory so a phone entry matches its `@lid` form and vice versa.
 *
 * Provided by the global AuthModule so both the ApiKeyGuard (route-param fence) and the feature
 * controllers/services (list filtering and body-chat sends) share one definition of "inside the
 * fence". A missing lid directory degrades to exact-dialect matching only, which fails CLOSED for an
 * unmapped `@lid` — the documented behaviour.
 */
@Injectable()
export class ChatScopeService {
  constructor(
    // Exported by the global EngineModule. Optional so the auth surface still boots in a unit test
    // (or a stripped build) without the engine: the fence then matches dialects exactly.
    @Optional()
    private readonly lidStore?: LidMappingStoreService,
  ) {}

  /** True when the key carries a non-empty allowlist and is therefore fenced. */
  isRestricted(apiKey?: Pick<ApiKey, 'allowedChats'> | null): boolean {
    return isChatScopeRestricted(apiKey?.allowedChats);
  }

  /** The compiled scope for a key, or `null` when unrestricted. */
  scopeFor(apiKey?: Pick<ApiKey, 'allowedChats'> | null): ChatScope | null {
    return buildChatScope(apiKey?.allowedChats ?? null, this.directory());
  }

  /** Whether `chatId` is inside the key's fence (an unrestricted key admits every chat). */
  allows(apiKey: Pick<ApiKey, 'allowedChats'> | null | undefined, chatId: string): boolean {
    return chatScopeAllows(this.scopeFor(apiKey), chatId);
  }

  /** The subset of `items` whose chat id is inside the key's fence (unrestricted ⇒ unchanged). */
  filter<T>(
    apiKey: Pick<ApiKey, 'allowedChats'> | null | undefined,
    items: readonly T[],
    chatIdOf: (item: T) => string | null | undefined,
  ): T[] {
    return filterByChatScope(this.scopeFor(apiKey), items, chatIdOf);
  }

  private directory(): ChatScopeDirectory | undefined {
    const store = this.lidStore;
    if (!store) return undefined;
    return {
      resolveLid: jid => store.resolveLid(jid),
      lidsForPhone: phone => store.lidsForPhone(phone),
    };
  }
}
