import type { HookEvent } from './hook.interfaces';

const isPlainObject = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A message:received / message:sent result the projector can store and dispatch: it keeps `id` and `chatId`. */
export function isMessagePayload(data: unknown): boolean {
  const candidate = data as { id?: unknown; chatId?: unknown } | null;
  return isPlainObject(candidate) && typeof candidate!.id === 'string' && typeof candidate!.chatId === 'string';
}

/** A webhook:before result whose `payload` can replace the one being sent. */
export function isWebhookBeforeResult(data: unknown): boolean {
  return isPlainObject(data) && isPlainObject((data as { payload?: unknown }).payload);
}

/**
 * The handler results each event can use. A chain skips a result that fails its check and keeps the
 * last usable value, so an earlier handler's rewrite (a redaction) survives a later handler returning
 * `null`: HookManager applies it between plugins, the sandbox worker between one plugin's handlers.
 */
export const HOOK_RESULT_ACCEPT: Partial<Record<HookEvent, (data: unknown) => boolean>> = {
  'message:received': isMessagePayload,
  'message:sent': isMessagePayload,
  'webhook:before': isWebhookBeforeResult,
};
