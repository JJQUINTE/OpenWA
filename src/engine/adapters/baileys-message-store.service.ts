import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type * as BaileysLib from '@whiskeysockets/baileys';
import type { WAMessage } from '@whiskeysockets/baileys';
import { BaileysStoredMessage } from './baileys-stored-message.entity';
import { BaileysMessageStore } from '../types/baileys.types';
import { createLogger } from '../../common/services/logger.service';

function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * True when a write failed because the parent `sessions` row is absent (a foreign-key violation),
 * as opposed to any other persistence error. Covers SQLite (`SQLITE_CONSTRAINT[_FOREIGNKEY]`) and
 * Postgres (`23503`). TypeORM wraps the driver error in a QueryFailedError, so check both the
 * wrapper and `driverError`.
 */
function isMissingParentSessionError(err: unknown): boolean {
  const e = err as { code?: string; driverError?: { code?: string }; message?: string };
  const code = e?.driverError?.code ?? e?.code;
  if (code === '23503') {
    return true; // Postgres foreign_key_violation
  }
  const message = e?.message ?? '';
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
    return code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || /FOREIGN KEY/i.test(message);
  }
  return /FOREIGN KEY constraint failed/i.test(message);
}

@Injectable()
export class BaileysMessageStoreService implements BaileysMessageStore {
  private readonly logger = createLogger('BaileysMessageStore');
  /** Sessions already warned about a missing parent row — keeps the orphan log to once per session. */
  private readonly orphanWarnedSessions = new Set<string>();
  /**
   * Writes still in flight, by `${sessionId}:${waMessageId}`. A message is announced while its write
   * is still running, and whoever hears about it may look it up at once (a quoted reply, a reaction,
   * a read receipt). A read of an id held here waits for that write instead of reporting the message
   * missing. An entry lives exactly as long as its write, so the map only ever holds writes in flight.
   */
  private readonly pendingWrites = new Map<string, Promise<void>>();

  /** Lazily loaded @whiskeysockets/baileys module (ESM-only; loaded on first use, not at boot). */
  private baileysLib?: typeof BaileysLib;

  private async loadLib(): Promise<typeof BaileysLib> {
    return (this.baileysLib ??= await import('@whiskeysockets/baileys'));
  }

  constructor(
    @InjectRepository(BaileysStoredMessage, 'data')
    private readonly repo: Repository<BaileysStoredMessage>,
  ) {}

  async put(sessionId: string, msg: WAMessage): Promise<void> {
    const waMessageId = msg.key?.id;
    if (!waMessageId) {
      return;
    }
    // Registered before the first await, so a read issued any time after put() is called sees this write.
    const key = `${sessionId}:${waMessageId}`;
    const write = this.write(sessionId, waMessageId, msg);
    this.pendingWrites.set(key, write);
    try {
      await write;
    } finally {
      // A later put of the same id replaced the entry and owns it now.
      if (this.pendingWrites.get(key) === write) this.pendingWrites.delete(key);
    }
  }

  private async write(sessionId: string, waMessageId: string, msg: WAMessage): Promise<void> {
    const { BufferJSON } = await this.loadLib();
    const serializedMessage = JSON.stringify(msg, BufferJSON.replacer);
    // Idempotent: the same message arrives from the send return AND the messages.upsert echo.
    // createdAt is set explicitly so the stored value carries millisecond precision — matching the
    // :createdAt bound param used in enforceLimit(). Without this, SQLite's datetime('now') stores
    // second-precision (e.g. '…:11') while the JS Date bound serializes as '…:11.000', and SQLite
    // string-compares '…:11' < '…:11.000' = TRUE, causing every same-second row to be over-evicted
    // and the store to be wiped to ~0.
    try {
      await this.repo.upsert({ sessionId, waMessageId, serializedMessage, createdAt: new Date() }, [
        'sessionId',
        'waMessageId',
      ]);
    } catch (err) {
      if (isMissingParentSessionError(err)) {
        // Orphaned adapter: the sessions row was deleted/recreated (reconnect churn) while this
        // adapter kept emitting messages.upsert. There is no valid parent to store under, so drop
        // the write instead of throwing the FK error on every message (#319). Warn once per session
        // so the orphan stays visible without per-message log noise.
        if (!this.orphanWarnedSessions.has(sessionId)) {
          this.orphanWarnedSessions.add(sessionId);
          this.logger.warn(
            `No parent session row for "${sessionId}" — skipping Baileys message store (orphaned/recreated session). ` +
              `reply/forward/react/delete-by-id will be unavailable for messages received under this id.`,
          );
        }
        return;
      }
      throw err; // a genuine persistence failure — let the adapter's catch surface it
    }
    await this.enforceLimit(sessionId);
  }

  async getMessage(sessionId: string, messageId: string): Promise<WAMessage | null> {
    // Baileys retry/poll paths can hand over a key with no id; treat that as not-found rather than
    // letting an undefined criterion reach the ORM (TypeORM 1.x throws; 0.3 matched an arbitrary row).
    if (!messageId) return null;
    await this.settled(sessionId, messageId);
    const row = await this.repo.findOne({ where: { sessionId, waMessageId: messageId } });
    if (!row) {
      return null;
    }
    const { BufferJSON } = await this.loadLib();
    return JSON.parse(row.serializedMessage, BufferJSON.reviver) as WAMessage;
  }

  async getMessages(sessionId: string, messageIds: string[]): Promise<WAMessage[]> {
    // One query for the whole batch: the read-receipt path resolves up to a hundred ids at a time,
    // and a findOne apiece would be a hundred sequential round trips for a single request.
    const ids = messageIds.filter(Boolean);
    if (ids.length === 0) {
      return [];
    }
    await Promise.all(ids.map(id => this.settled(sessionId, id)));
    const rows = await this.repo.find({ where: { sessionId, waMessageId: In(ids) } });
    if (rows.length === 0) {
      return [];
    }
    const { BufferJSON } = await this.loadLib();
    return rows.map(row => JSON.parse(row.serializedMessage, BufferJSON.reviver) as WAMessage);
  }

  /** Wait out an in-flight write of this id. A failed write is the writer's to report; the read goes ahead. */
  private async settled(sessionId: string, messageId: string): Promise<void> {
    await this.pendingWrites.get(`${sessionId}:${messageId}`)?.catch(() => undefined);
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.repo.delete({ sessionId });
  }

  /** Per-session row cap: keep the newest N, delete the rest. Deterministic via (createdAt, id). */
  private async enforceLimit(sessionId: string): Promise<void> {
    const limit = positiveIntFromEnv('BAILEYS_MESSAGE_STORE_LIMIT', 5000);
    const cutoff = await this.repo.find({
      where: { sessionId },
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: limit,
      take: 1,
      select: { id: true, createdAt: true },
    });
    if (cutoff.length === 0) {
      return; // under the cap — nothing to evict
    }
    const { id, createdAt } = cutoff[0];
    await this.repo
      .createQueryBuilder()
      .delete()
      .where('sessionId = :sessionId', { sessionId })
      .andWhere('(createdAt < :createdAt OR (createdAt = :createdAt AND id <= :id))', { createdAt, id })
      .execute();
  }
}
