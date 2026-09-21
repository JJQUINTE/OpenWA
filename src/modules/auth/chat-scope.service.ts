import { Injectable, Optional } from '@nestjs/common';
import { ApiKey } from './entities/api-key.entity';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { ContactDirectory } from '../../engine/identity/jid-candidates';
import {
  ChatScope,
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
 * controllers/services (list filtering) share one definition of "inside the fence". The directory
 * reads the persisted lid table, not the evictable in-memory mirror, so the answer is deterministic.
 * A missing directory degrades to exact-dialect matching only, which fails CLOSED for an unmapped
 * `@lid` — the documented behaviour.
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
  scopeFor(apiKey?: Pick<ApiKey, 'allowedChats'> | null): Promise<ChatScope | null> {
    return buildChatScope(apiKey?.allowedChats ?? null, this.directory());
  }

  /** Whether `chatId` is inside the key's fence (an unrestricted key admits every chat). */
  async allows(apiKey: Pick<ApiKey, 'allowedChats'> | null | undefined, chatId: string): Promise<boolean> {
    return chatScopeAllows(await this.scopeFor(apiKey), chatId);
  }

  /** The subset of `items` whose chat id is inside the key's fence (unrestricted ⇒ unchanged). */
  async filter<T>(
    apiKey: Pick<ApiKey, 'allowedChats'> | null | undefined,
    items: readonly T[],
    chatIdOf: (item: T) => string | null | undefined,
  ): Promise<T[]> {
    return filterByChatScope(await this.scopeFor(apiKey), items, chatIdOf);
  }

  private directory(): ContactDirectory | undefined {
    const store = this.lidStore;
    if (!store) return undefined;
    return {
      resolveLid: userPart => store.resolveLidPersisted(userPart),
      lidsForPhone: phone => store.lidsForPhonePersisted(phone),
    };
  }
}
