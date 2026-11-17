/**
 * The bounded re-import of a board's key after the board REJECTED the one it
 * has (`encryption-key-invalid`): the key was rotated in the builder, so read
 * it again from the key sources, once.
 *
 * Bound: at most one fetch per board between two successful connects. The
 * gate is in-memory state (`spent`), set before the read and cleared only by a
 * connect, so a fetch that fails, returns the same key, or returns a key the
 * board rejects again never leads to another fetch. No polling, no timer.
 *
 * A failed read changes nothing (D49): {@link importBoardKeys} never writes
 * without a key it actually read, so the existing key stays.
 */
import type { IScopedLogger } from '@camstack/types'
import type { EspFailureReason } from './esphome-link.js'
import {
  importBoardKeys,
  type BoardKeyImportResult,
  type KeyImportBoards,
  type KeySourceClient,
} from './esphome-key-import.js'

export interface KeyRotationDeps {
  readonly boards: KeyImportBoards
  readonly keySources: () => KeySourceClient
  readonly logger: IScopedLogger
  /** The device that stands for the board (its container), for the log tag. */
  readonly deviceIdFor: (boardId: string) => number | undefined
}

type LogTags = { readonly tags?: { readonly deviceId: number } }

export class EspKeyRotation {
  /** Boards that already fetched since their last connect. */
  private readonly spent = new Set<string>()

  constructor(private readonly deps: KeyRotationDeps) {}

  /** A board connected: its next rejection may fetch again. */
  onConnected(boardId: string): void {
    this.spent.delete(boardId)
  }

  /**
   * A board stopped on a permanent failure. Fetches its key once when the
   * reason is a rejected key; resolves to the import outcome, or `null` when
   * nothing was fetched or the fetch threw.
   */
  async onPermanentFailure(
    boardId: string,
    reason: EspFailureReason,
  ): Promise<BoardKeyImportResult | null> {
    if (reason !== 'encryption-key-invalid') return null
    const tags = this.tagsFor(boardId)
    if (this.spent.has(boardId)) {
      this.deps.logger.info('key rotation: key rejected again, already fetched since last connect', {
        ...tags,
        meta: { boardId },
      })
      return null
    }
    this.spent.add(boardId)
    this.deps.logger.info('key rotation: board rejected its key, fetching it once', {
      ...tags,
      meta: { boardId },
    })
    try {
      const [result] = await importBoardKeys({
        boards: this.deps.boards,
        keySources: this.deps.keySources(),
        logger: this.deps.logger,
        boardId,
      })
      if (result === undefined) {
        this.deps.logger.warn('key rotation: board is not configured, nothing fetched', {
          ...tags,
          meta: { boardId },
        })
        return null
      }
      this.deps.logger.info('key rotation: done', {
        ...tags,
        meta: {
          boardId,
          outcome: result.outcome,
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
        },
      })
      return result
    } catch (err: unknown) {
      this.deps.logger.warn('key rotation: fetching the key failed', {
        ...tags,
        meta: { boardId, error: err instanceof Error ? err.message : 'unknown' },
      })
      return null
    }
  }

  private tagsFor(boardId: string): LogTags {
    const deviceId = this.deps.deviceIdFor(boardId)
    return deviceId !== undefined ? { tags: { deviceId } } : {}
  }
}
