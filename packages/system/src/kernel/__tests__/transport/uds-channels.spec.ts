/**
 * UDS event / log / readiness channels — integration tests.
 *
 * Uses a REAL LocalChildRegistry + LocalChildClient over the real local
 * transport (in-process TCP/UDS). Covers:
 *   (1) child emitEvent → registry onChildEvent
 *   (2) child sendLog   → registry onChildLog
 *   (3) child requestReadinessSnapshot ↔ registry onReadinessSnapshotRequest
 *   (4) registry sendEventToChild / broadcastEventToChildren → child onEvent
 *   (5) events/logs buffered pre-start are flushed after connect
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { LocalChildRegistry } from '../../transport/local-child-registry.js'
import { LocalChildClient } from '../../transport/local-child-client.js'
import type { SystemEvent, IReadinessRegistryRecord } from '@camstack/types'
import type { ChildLogMessage } from '../../transport/child-cap-protocol.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const nid = (): string => `channels-test-${process.pid}-${Math.random().toString(36).slice(2)}`

/** Wait up to `timeoutMs` for `check` to return true, polling every 10 ms. */
async function waitFor(check: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function makeEvent(category = 'test'): SystemEvent {
  return { category, payload: { seq: Math.random() } } as unknown as SystemEvent
}

function makeLogEntry(): Omit<ChildLogMessage, 'kind'> {
  return {
    level: 'info',
    message: 'hello from child',
    addonId: 'test-addon',
    scope: 'test',
    meta: { x: 1 },
  }
}

function makeReadinessRecord(): IReadinessRegistryRecord {
  return {
    capName: 'ptz',
    scope: { kind: 'node', nodeId: 'hub' } as unknown as IReadinessRegistryRecord['scope'],
    state: 'ready',
    generation: 'gen-1',
    epoch: 1,
    lastChange: Date.now(),
    sourceNodeId: 'hub',
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UDS channels — event / log / readiness', () => {
  let registry: LocalChildRegistry | null = null
  const clients: LocalChildClient[] = []

  afterEach(async () => {
    for (const c of clients) await c.close().catch(() => {})
    clients.length = 0
    await registry?.close().catch(() => {})
    registry = null
  })

  // ── (1) emitEvent ──────────────────────────────────────────────────────────

  it('(1) child emitEvent → registry onChildEvent receives the right childId + event', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))

    const received: Array<{ childId: string; event: SystemEvent }> = []
    registry.onChildEvent((childId, event) => received.push({ childId, event }))

    await registry.start()

    const child = new LocalChildClient({
      nodeId,
      childId: 'emitter',
      caps: [],
      dispatch: async () => null,
    })
    clients.push(child)
    await child.start()

    const evt = makeEvent('camera.motion')
    child.emitEvent(evt)

    await waitFor(() => received.length >= 1)
    expect(received).toHaveLength(1)
    expect(received[0]!.childId).toBe('emitter')
    expect(received[0]!.event).toEqual(evt)
  })

  // ── (2) sendLog ────────────────────────────────────────────────────────────

  it('(2) child sendLog → registry onChildLog receives the right childId + entry', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))

    const received: Array<{ childId: string; entry: ChildLogMessage }> = []
    registry.onChildLog((childId, entry) => received.push({ childId, entry }))

    await registry.start()

    const child = new LocalChildClient({
      nodeId,
      childId: 'logger-child',
      caps: [],
      dispatch: async () => null,
    })
    clients.push(child)
    await child.start()

    const logEntry = makeLogEntry()
    child.sendLog(logEntry)

    await waitFor(() => received.length >= 1)
    expect(received).toHaveLength(1)
    expect(received[0]!.childId).toBe('logger-child')
    expect(received[0]!.entry.kind).toBe('log')
    expect(received[0]!.entry.level).toBe('info')
    expect(received[0]!.entry.message).toBe('hello from child')
    expect(received[0]!.entry.addonId).toBe('test-addon')
  })

  // ── (3) requestReadinessSnapshot ───────────────────────────────────────────

  it('(3) child requestReadinessSnapshot resolves to the records returned by the registry handler', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))

    const record = makeReadinessRecord()
    registry.onReadinessSnapshotRequest(() => [record])

    await registry.start()

    const child = new LocalChildClient({
      nodeId,
      childId: 'snapshot-child',
      caps: [],
      dispatch: async () => null,
    })
    clients.push(child)
    await child.start()

    const records = await child.requestReadinessSnapshot()
    expect(records).toHaveLength(1)
    expect(records[0]!.capName).toBe('ptz')
    expect(records[0]!.state).toBe('ready')
  })

  it('(3b) requestReadinessSnapshot returns empty array when no handler registered', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const child = new LocalChildClient({
      nodeId,
      childId: 'snapshot-child-2',
      caps: [],
      dispatch: async () => null,
    })
    clients.push(child)
    await child.start()

    const records = await child.requestReadinessSnapshot()
    expect(records).toEqual([])
  })

  it('(3c) requestReadinessSnapshot before start throws', async () => {
    const child = new LocalChildClient({
      nodeId: nid(),
      childId: 'early',
      caps: [],
      dispatch: async () => null,
    })
    await expect(child.requestReadinessSnapshot()).rejects.toThrow(/start/)
  })

  // ── (4) sendEventToChild / broadcastEventToChildren ───────────────────────

  it('(4a) registry sendEventToChild → child onEvent receives the event', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const received: SystemEvent[] = []
    const child = new LocalChildClient({
      nodeId,
      childId: 'listener',
      caps: [],
      dispatch: async () => null,
    })
    child.onEvent((evt) => received.push(evt))
    clients.push(child)
    await child.start()

    const evt = makeEvent('hub.restart')
    registry.sendEventToChild('listener', evt, 'hub-node')

    await waitFor(() => received.length >= 1)
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(evt)
  })

  it('(4b) registry broadcastEventToChildren delivers to all children except the excepted one', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const receivedA: SystemEvent[] = []
    const receivedB: SystemEvent[] = []

    const childA = new LocalChildClient({
      nodeId,
      childId: 'child-a',
      caps: [],
      dispatch: async () => null,
    })
    childA.onEvent((evt) => receivedA.push(evt))
    clients.push(childA)
    await childA.start()

    const childB = new LocalChildClient({
      nodeId,
      childId: 'child-b',
      caps: [],
      dispatch: async () => null,
    })
    childB.onEvent((evt) => receivedB.push(evt))
    clients.push(childB)
    await childB.start()

    const evt = makeEvent('broadcast.test')
    // Broadcast excepting child-a — only child-b should receive it.
    registry.broadcastEventToChildren(evt, 'hub-node', 'child-a')

    await waitFor(() => receivedB.length >= 1)
    await new Promise((r) => setTimeout(r, 30)) // give child-a a chance to receive (it should NOT)

    expect(receivedB).toHaveLength(1)
    expect(receivedB[0]).toEqual(evt)
    expect(receivedA).toHaveLength(0)
  })

  it('(4c) registry broadcastEventToChildren with no exceptChildId delivers to all', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const receivedA: SystemEvent[] = []
    const receivedB: SystemEvent[] = []

    const childA = new LocalChildClient({
      nodeId,
      childId: 'ca',
      caps: [],
      dispatch: async () => null,
    })
    childA.onEvent((evt) => receivedA.push(evt))
    clients.push(childA)
    await childA.start()

    const childB = new LocalChildClient({
      nodeId,
      childId: 'cb',
      caps: [],
      dispatch: async () => null,
    })
    childB.onEvent((evt) => receivedB.push(evt))
    clients.push(childB)
    await childB.start()

    const evt = makeEvent('all.event')
    registry.broadcastEventToChildren(evt, 'hub-node')

    await waitFor(() => receivedA.length >= 1 && receivedB.length >= 1)
    expect(receivedA).toHaveLength(1)
    expect(receivedB).toHaveLength(1)
  })

  // ── (5) pre-start buffering ────────────────────────────────────────────────

  it('(5a) events emitted before start() are buffered and flushed after connect', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))

    const received: Array<{ childId: string; event: SystemEvent }> = []
    registry.onChildEvent((childId, event) => received.push({ childId, event }))

    await registry.start()

    const child = new LocalChildClient({
      nodeId,
      childId: 'buffer-test',
      caps: [],
      dispatch: async () => null,
    })
    clients.push(child)

    // Emit BEFORE start()
    const evt1 = makeEvent('pre.start.1')
    const evt2 = makeEvent('pre.start.2')
    child.emitEvent(evt1)
    child.emitEvent(evt2)

    // Nothing received yet — channel not open
    expect(received).toHaveLength(0)

    await child.start()

    await waitFor(() => received.length >= 2)
    expect(received).toHaveLength(2)
    expect(received.map((r) => r.event)).toEqual([evt1, evt2])
    expect(received.every((r) => r.childId === 'buffer-test')).toBe(true)
  })

  it('(5b) logs emitted before start() are buffered and flushed after connect', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))

    const received: Array<{ childId: string; entry: ChildLogMessage }> = []
    registry.onChildLog((childId, entry) => received.push({ childId, entry }))

    await registry.start()

    const child = new LocalChildClient({
      nodeId,
      childId: 'log-buffer-test',
      caps: [],
      dispatch: async () => null,
    })
    clients.push(child)

    // Log BEFORE start()
    child.sendLog({ level: 'info', message: 'buffered-1', addonId: 'x' })
    child.sendLog({ level: 'error', message: 'buffered-2', addonId: 'x' })

    expect(received).toHaveLength(0)

    await child.start()

    await waitFor(() => received.length >= 2)
    expect(received).toHaveLength(2)
    expect(received[0]!.entry.message).toBe('buffered-1')
    expect(received[1]!.entry.message).toBe('buffered-2')
  })

  // ── (6) isConnected lifecycle ─────────────────────────────────────────────

  it('(6) isConnected is false before start() and true after start() resolves', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const child = new LocalChildClient({
      nodeId,
      childId: 'connected-check',
      caps: [],
      dispatch: async () => null,
    })
    clients.push(child)

    expect(child.isConnected).toBe(false)

    await child.start()

    expect(child.isConnected).toBe(true)
  })

  // ── (7) sendEventToChild no-op for missing child ──────────────────────────

  it('(7) registry.sendEventToChild for a nonexistent childId does not throw', () => {
    const nodeId = nid()
    const reg = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    registry = reg
    // No start() needed — registry.children is empty; the method must silently no-op.
    const evt = makeEvent('noop.test')
    expect(() => reg.sendEventToChild('nonexistent-child', evt, 'hub')).not.toThrow()
  })
})
