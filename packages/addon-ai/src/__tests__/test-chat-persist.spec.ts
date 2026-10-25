/**
 * Persistent vs throwaway test-chat: the messages SOURCE, not a new transport.
 *
 * Throwaway is today's behaviour — the in-page transcript is the only history
 * and the store is never touched. Persistent prepends the stored `messages`
 * array (the AI SDK is stateless; we own history) and writes the turn after
 * a successful `done`.
 */
import { describe, expect, it } from 'vitest'
import { TestChatRequestSchema } from '../test-chat/contract.js'
import { ChatStore } from '../test-chat/chat-store.js'
import { commitPersistentTurn, resolveStreamMessages } from '../test-chat/persist.js'
import { makeAiRecords } from './support/fake-records.js'

async function chats(): Promise<ChatStore> {
  return ChatStore.of((await makeAiRecords()).records, () => 1_000)
}

function request(over: Record<string, unknown> = {}) {
  return TestChatRequestSchema.parse({
    profileId: 'p1',
    messages: [{ role: 'user', content: 'ping' }],
    ...over,
  })
}

describe('resolveStreamMessages', () => {
  it('throwaway (persist omitted) uses the request messages and does not create a chat', async () => {
    const store = await chats()
    const resolved = await resolveStreamMessages(store, 'alice', request())
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.conversationId).toBeNull()
    expect(resolved.messages).toEqual([{ role: 'user', content: 'ping' }])
    expect(await store.list('alice')).toEqual([])
  })

  it('persist without conversationId starts a new chat after the turn, not before', async () => {
    const store = await chats()
    const resolved = await resolveStreamMessages(store, 'alice', request({ persist: true }))
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.conversationId).toBeNull()
    expect(resolved.messages).toEqual([{ role: 'user', content: 'ping' }])
    expect(await store.list('alice')).toEqual([])
  })

  it('persist + conversationId prepends stored history to the new user turn', async () => {
    const store = await chats()
    const created = await store.create('alice', [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])
    const resolved = await resolveStreamMessages(
      store,
      'alice',
      request({
        persist: true,
        conversationId: created.id,
        messages: [{ role: 'user', content: 'what next?' }],
      }),
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.conversationId).toBe(created.id)
    expect(resolved.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'what next?' },
    ])
  })

  it('user A cannot resume user B', async () => {
    const store = await chats()
    const bob = await store.create('bob', [{ role: 'user', content: 'secret' }])
    const resolved = await resolveStreamMessages(
      store,
      'alice',
      request({ persist: true, conversationId: bob.id }),
    )
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.status).toBe(404)
  })
})

describe('commitPersistentTurn', () => {
  it('throwaway writes nothing', async () => {
    const store = await chats()
    await commitPersistentTurn(store, 'alice', request(), {
      assistantContent: 'pong',
      mediaSent: null,
      thumbnailBase64: undefined,
    })
    expect(await store.list('alice')).toEqual([])
  })

  it('persist creates a chat titled from the first user message', async () => {
    const store = await chats()
    const committed = await commitPersistentTurn(
      store,
      'alice',
      request({ persist: true, messages: [{ role: 'user', content: 'What is this?' }] }),
      { assistantContent: 'a van', mediaSent: null, thumbnailBase64: undefined },
    )
    expect(committed?.title).toBe('What is this?')
    const listed = await store.list('alice')
    expect(listed).toHaveLength(1)
    const full = await store.get('alice', listed[0]!.id)
    expect(full?.messages).toEqual([
      { role: 'user', content: 'What is this?' },
      { role: 'assistant', content: 'a van' },
    ])
  })

  it('persist round-trips mediaSent onto the user turn that carried the picture', async () => {
    const store = await chats()
    const mediaSent = {
      kind: 'snapshot' as const,
      mimeType: 'image/jpeg',
      sizeBytes: 12,
      thumbnailBase64: 'QUJD',
    }
    const committed = await commitPersistentTurn(
      store,
      'alice',
      request({
        persist: true,
        attachment: { kind: 'snapshot', deviceId: 102 },
        messages: [{ role: 'user', content: 'describe' }],
      }),
      { assistantContent: 'a van', mediaSent, thumbnailBase64: 'QUJD' },
    )
    const user = committed?.messages.find((m) => m.role === 'user')
    expect(user?.mediaSent).toEqual(mediaSent)
    expect(user?.attachment).toEqual({ kind: 'snapshot', deviceId: 102 })
  })

  it('appending to an existing conversation does not rewrite the title', async () => {
    const store = await chats()
    const created = await store.create('alice', [{ role: 'user', content: 'first' }])
    const committed = await commitPersistentTurn(
      store,
      'alice',
      request({
        persist: true,
        conversationId: created.id,
        messages: [{ role: 'user', content: 'second' }],
      }),
      { assistantContent: 'ok', mediaSent: null, thumbnailBase64: undefined },
    )
    expect(committed?.title).toBe('first')
    expect(committed?.messages.map((m) => m.content)).toEqual(['first', 'second', 'ok'])
  })
})
