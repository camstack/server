/**
 * Per-user persistent AI chats over the `chats` record kind.
 *
 * Row id `${userId}/${conversationId}`. Isolation is structural: every
 * read/write takes `userId`, reads are served by the `user` index, and a row
 * that belongs to someone else is refused.
 */
import { randomUUID } from 'node:crypto'
import type { RecordKindHandle, RecordRow, RecordsAccess } from '@camstack/types'
import { aiRecordKinds } from '../record-kinds.js'
import { readAllRows } from '../record-pages.js'
import {
  type StoredChatMessage,
  type StoredConversation,
  StoredConversationSchema,
} from './chat-schema.js'
import type { TestChatAttachment, TestChatImageRef } from './contract.js'

export type { StoredChatMessage, StoredConversation }

/** Legacy collection name — kept for the adoption mapper / docs. */
export const CHATS_COLLECTION = 'ai:chats'

const TITLE_MAX_CHARS = 80

export function chatsRowId(userId: string, conversationId: string): string {
  return `${userId}/${conversationId}`
}

export function titleFromFirstUserMessage(content: string): string {
  const collapsed = content.trim().replace(/\s+/g, ' ')
  if (collapsed.length <= TITLE_MAX_CHARS) return collapsed
  return collapsed.slice(0, TITLE_MAX_CHARS).trimEnd()
}

export interface ChatSummary {
  readonly id: string
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ChatRetention {
  readonly maxAgeMs?: number
  readonly maxCount?: number
}

function parseConversation(id: string, data: unknown): StoredConversation | null {
  const parsed = StoredConversationSchema.safeParse(data)
  if (!parsed.success) return null
  // The row id is the authority on which conversation this is.
  return { ...parsed.data, id }
}

/** The conversation id inside a `${userId}/${conversationId}` row id. */
function conversationIdOf(rowId: string): string {
  const slash = rowId.indexOf('/')
  return slash >= 0 ? rowId.slice(slash + 1) : rowId
}

export class ChatStore {
  constructor(
    private readonly kind: RecordKindHandle<StoredConversation>,
    private readonly now: () => number = Date.now,
  ) {}

  static of(records: Pick<RecordsAccess, 'kind'>, now: () => number = Date.now): ChatStore {
    return new ChatStore(records.kind(aiRecordKinds.chats), now)
  }

  async create(
    userId: string,
    messages: readonly StoredChatMessage[],
    at: number = this.now(),
  ): Promise<StoredConversation> {
    const id = randomUUID()
    const firstUser = messages.find((m) => m.role === 'user')
    const title = titleFromFirstUserMessage(firstUser?.content ?? '')
    const conversation: StoredConversation = {
      id,
      userId,
      title: title.length > 0 ? title : 'New chat',
      createdAt: at,
      updatedAt: at,
      messages: [...messages],
    }
    await this.kind.put({ id: chatsRowId(userId, id), data: conversation })
    return conversation
  }

  async list(userId: string): Promise<ChatSummary[]> {
    const rows = await this.owned(userId)
    return rows
      .map((c) => ({
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async get(userId: string, conversationId: string): Promise<StoredConversation | null> {
    const match = await this.kind.get(chatsRowId(userId, conversationId))
    if (match === null) return null
    const parsed = parseConversation(conversationId, match.data)
    if (parsed === null || parsed.userId !== userId) return null
    return parsed
  }

  async append(
    userId: string,
    conversationId: string,
    messages: readonly StoredChatMessage[],
    at: number = this.now(),
  ): Promise<StoredConversation | null> {
    const current = await this.get(userId, conversationId)
    if (current === null) return null
    const next: StoredConversation = {
      ...current,
      updatedAt: at,
      messages: [...current.messages, ...messages],
    }
    await this.kind.put({ id: chatsRowId(userId, conversationId), data: next })
    return next
  }

  async prune(userId: string, retention: ChatRetention, now: number = this.now()): Promise<number> {
    const owned = await this.owned(userId)
    return this.pruneRows(owned, retention, now)
  }

  async pruneAll(retention: ChatRetention, now: number = this.now()): Promise<number> {
    const all = await this.allValid()
    return this.pruneRows(all, retention, now)
  }

  private async pruneRows(
    rows: readonly StoredConversation[],
    retention: ChatRetention,
    now: number,
  ): Promise<number> {
    const doomed = new Set<string>()
    const maxAgeMs = retention.maxAgeMs
    if (maxAgeMs !== undefined && maxAgeMs > 0) {
      const cutoff = now - maxAgeMs
      for (const row of rows) {
        if (row.updatedAt < cutoff) doomed.add(chatsRowId(row.userId, row.id))
      }
    }
    const maxCount = retention.maxCount
    if (maxCount !== undefined && maxCount > 0) {
      const byUser = new Map<string, StoredConversation[]>()
      for (const row of rows) {
        if (doomed.has(chatsRowId(row.userId, row.id))) continue
        const list = byUser.get(row.userId) ?? []
        list.push(row)
        byUser.set(row.userId, list)
      }
      for (const group of byUser.values()) {
        const sorted = [...group].sort((a, b) => b.updatedAt - a.updatedAt)
        for (const extra of sorted.slice(maxCount)) {
          doomed.add(chatsRowId(extra.userId, extra.id))
        }
      }
    }
    return this.kind.deleteMany([...doomed])
  }

  private async owned(userId: string): Promise<StoredConversation[]> {
    return this.valid(await readAllRows(this.kind, { where: { userId } }))
  }

  private async allValid(): Promise<StoredConversation[]> {
    return this.valid(await readAllRows(this.kind))
  }

  private valid(rows: readonly RecordRow<StoredConversation>[]): StoredConversation[] {
    const out: StoredConversation[] = []
    for (const row of rows) {
      const parsed = parseConversation(conversationIdOf(row.id), row.data)
      if (parsed !== null) out.push(parsed)
    }
    return out
  }
}

export type { TestChatAttachment, TestChatImageRef }
