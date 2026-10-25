/**
 * The messages SOURCE for a test-chat turn: in-page transcript (throwaway)
 * versus stored history (persistent). The NDJSON transport is unchanged.
 */
import {
  TEST_CHAT_MAX_MESSAGES,
  type TestChatAttachment,
  type TestChatRequest,
} from './contract.js'
import type { ChatStore, StoredChatMessage, StoredConversation } from './chat-store.js'

export type ResolveStreamMessagesResult =
  | {
      readonly ok: true
      readonly conversationId: string | null
      readonly messages: TestChatRequest['messages']
    }
  | { readonly ok: false; readonly status: number; readonly error: string }

function asWireMessages(messages: readonly StoredChatMessage[]): TestChatRequest['messages'] {
  return messages.map((m) => ({ role: m.role, content: m.content }))
}

function isPersistent(request: TestChatRequest): boolean {
  return request.persist === true
}

export async function resolveStreamMessages(
  store: ChatStore,
  userId: string,
  request: TestChatRequest,
): Promise<ResolveStreamMessagesResult> {
  if (!isPersistent(request) || request.conversationId === undefined) {
    return {
      ok: true,
      conversationId: request.conversationId ?? null,
      messages: request.messages,
    }
  }
  const existing = await store.get(userId, request.conversationId)
  if (existing === null) {
    return { ok: false, status: 404, error: 'conversation not found' }
  }
  const history = asWireMessages(existing.messages)
  const combined = [...history, ...request.messages]
  const messages =
    combined.length > TEST_CHAT_MAX_MESSAGES ? combined.slice(-TEST_CHAT_MAX_MESSAGES) : combined
  return { ok: true, conversationId: existing.id, messages }
}

export interface TurnCommit {
  readonly assistantContent: string
  readonly mediaSent: TestChatAttachment | null
  readonly thumbnailBase64: string | undefined
}

function userTurnsToStore(request: TestChatRequest, commit: TurnCommit): StoredChatMessage[] {
  const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')
  const user: StoredChatMessage = {
    role: 'user',
    content: lastUser?.content ?? '',
    ...(commit.mediaSent !== null ? { mediaSent: commit.mediaSent } : {}),
    ...(commit.thumbnailBase64 !== undefined ? { thumbnailBase64: commit.thumbnailBase64 } : {}),
    ...(request.attachment !== undefined ? { attachment: request.attachment } : {}),
  }
  const assistant: StoredChatMessage = {
    role: 'assistant',
    content: commit.assistantContent,
  }
  return [user, assistant]
}

export async function commitPersistentTurn(
  store: ChatStore,
  userId: string,
  request: TestChatRequest,
  commit: TurnCommit,
): Promise<StoredConversation | null> {
  if (!isPersistent(request)) return null
  const turns = userTurnsToStore(request, commit)
  if (request.conversationId !== undefined) {
    return store.append(userId, request.conversationId, turns)
  }
  return store.create(userId, turns)
}
