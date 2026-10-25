/**
 * Per-user persistent AI chats. Isolation is the product: a conversation is
 * never shared, and user A listing/getting must not see user B's rows even
 * when they guess the id.
 */
import { describe, expect, it } from 'vitest'
import {
  ChatStore,
  chatsRowId,
  titleFromFirstUserMessage,
  type StoredChatMessage,
} from '../test-chat/chat-store.js'
import { makeAiRecords, type FakeRecords } from './support/fake-records.js'

const DAY = 24 * 60 * 60 * 1000

function userMsg(content: string, extra: Partial<StoredChatMessage> = {}): StoredChatMessage {
  return { role: 'user', content, ...extra }
}

function assistantMsg(content: string, extra: Partial<StoredChatMessage> = {}): StoredChatMessage {
  return { role: 'assistant', content, ...extra }
}

async function storeAt(now: number): Promise<ChatStore> {
  return (await worldAt(now)).chats
}

async function worldAt(now: number): Promise<{ chats: ChatStore; world: FakeRecords }> {
  const world = await makeAiRecords()
  return { chats: ChatStore.of(world.records, () => now), world }
}

describe('ChatStore — per-user isolation', () => {
  it('create/list/get are scoped to the owning userId', async () => {
    const chats = await storeAt(1_000)
    const alice = await chats.create('alice', [userMsg('hello from A')])
    await chats.create('bob', [userMsg('hello from B')])

    const listed = await chats.list('alice')
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe(alice.id)
    expect(listed[0]?.title).toMatch(/hello from A/)

    expect(await chats.get('alice', alice.id)).toMatchObject({
      id: alice.id,
      userId: 'alice',
    })
    expect(await chats.get('bob', alice.id)).toBeNull()
    expect(await chats.list('bob').then((rows) => rows.map((r) => r.id))).not.toContain(alice.id)
  })

  it('user A cannot resume user B even with a guessed row id', async () => {
    const chats = await storeAt(1_000)
    const bob = await chats.create('bob', [userMsg('secret')])
    expect(await chats.get('alice', bob.id)).toBeNull()
    expect(await chats.append('alice', bob.id, [userMsg('poke')])).toBeNull()
  })

  it('row ids are namespaced ai:chats/<userId>/<conversationId>', async () => {
    expect(chatsRowId('u1', 'c1')).toBe('u1/c1')
    const { chats, world } = await worldAt(1_000)
    const created = await chats.create('u1', [userMsg('hi')])
    const ids = [...(world.tables.get('chats')?.keys() ?? [])]
    expect(ids).toEqual([`u1/${created.id}`])
  })

  it('a user list is served by the declared user index, never by a full scan', async () => {
    const { chats, world } = await worldAt(1_000)
    await chats.create('alice', [userMsg('a')])
    await chats.create('bob', [userMsg('b')])
    expect((await chats.list('alice')).length).toBe(1)
    expect([...(world.queriedFields.get('chats') ?? [])]).toEqual(['userId'])
  })
})

describe('ChatStore — title from the first user message', () => {
  it('derives the title from the first user turn', async () => {
    const chats = await storeAt(1_000)
    const created = await chats.create('u', [
      userMsg('  What is parked in the driveway?  '),
      assistantMsg('a van'),
    ])
    expect(created.title).toBe('What is parked in the driveway?')
    expect(titleFromFirstUserMessage('   ping\n\nmore   ')).toBe('ping more')
  })

  it('does not retitle on later turns', async () => {
    const chats = await storeAt(1_000)
    const created = await chats.create('u', [userMsg('original title')])
    const updated = await chats.append('u', created.id, [
      assistantMsg('ok'),
      userMsg('a much longer follow-up that must not become the title'),
    ])
    expect(updated?.title).toBe('original title')
  })
})

describe('ChatStore — mediaSent round-trip', () => {
  it('persists mediaSent on the message and returns it on resume', async () => {
    const chats = await storeAt(1_000)
    const mediaSent = {
      kind: 'snapshot' as const,
      mimeType: 'image/jpeg',
      sizeBytes: 1200,
      thumbnailBase64: 'QUJD',
    }
    const created = await chats.create('u', [
      userMsg('what is this?', {
        mediaSent,
        attachment: { kind: 'snapshot', deviceId: 102 },
      }),
    ])
    const resumed = await chats.get('u', created.id)
    expect(resumed?.messages[0]?.mediaSent).toEqual(mediaSent)
    expect(resumed?.messages[0]?.attachment).toEqual({ kind: 'snapshot', deviceId: 102 })
  })
})

describe('ChatStore — retention prune', () => {
  it('drops chats older than maxAgeMs', async () => {
    const now = 10 * DAY
    const chats = await storeAt(now)
    await chats.create('u', [userMsg('old')], now - 5 * DAY)
    await chats.create('u', [userMsg('fresh')], now - DAY)
    expect(await chats.prune('u', { maxAgeMs: 2 * DAY })).toBe(1)
    const listed = await chats.list('u')
    expect(listed).toHaveLength(1)
    expect(listed[0]?.title).toBe('fresh')
  })

  it('keeps only the newest maxCount chats per user', async () => {
    const chats = await storeAt(1_000)
    await chats.create('u', [userMsg('one')], 1)
    await chats.create('u', [userMsg('two')], 2)
    await chats.create('u', [userMsg('three')], 3)
    expect(await chats.prune('u', { maxCount: 2 })).toBe(1)
    expect((await chats.list('u')).map((c) => c.title)).toEqual(['three', 'two'])
  })

  it('pruneAll walks every user', async () => {
    const now = 10 * DAY
    const chats = await storeAt(now)
    await chats.create('alice', [userMsg('stale')], now - 5 * DAY)
    await chats.create('bob', [userMsg('kept')], now)
    expect(await chats.pruneAll({ maxAgeMs: 2 * DAY })).toBe(1)
    expect(await chats.list('alice')).toEqual([])
    expect(await chats.list('bob')).toHaveLength(1)
  })
})
