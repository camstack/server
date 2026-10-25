import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createUdsLogger, createUdsLoggerWithControl } from '../../transport/uds-logger.js'
import type { UdsLogSink } from '../../transport/uds-logger.js'
import type { ChildLogMessage } from '../../transport/child-cap-protocol.js'

// ── Fake UdsLogSink ──────────────────────────────────────────────────────────
//
// Typed via the minimal interface — no casts. LocalChildClient satisfies it
// structurally; tests verify behaviour without spinning a real UDS socket.
// `isConnected` is intentionally absent from UdsLogSink (Fix 4) — the fake
// omits it too. Tests that exercise pre-connect paths pass `connected` only
// for local bookkeeping, not via the interface.

function makeSink(): { sink: UdsLogSink; sendLog: ReturnType<typeof vi.fn> } {
  const sendLog = vi.fn<(entry: Omit<ChildLogMessage, 'kind'>) => void>()
  const sink: UdsLogSink = { sendLog }
  return { sink, sendLog }
}

/** Default nodeId used across tests — mirrors the hub/addon pattern. */
const TEST_NODE_ID = 'hub/addon-x'
/** agentId derived from TEST_NODE_ID */
const TEST_AGENT_ID = 'hub'

describe('createUdsLogger', () => {
  let sendLog: ReturnType<typeof vi.fn>
  let sink: UdsLogSink

  beforeEach(() => {
    const fake = makeSink()
    sink = fake.sink
    sendLog = fake.sendLog
  })

  // ── 1. Basic level dispatch ────────────────────────────────────────────────

  it('info: calls sendLog with correct shape', () => {
    const logger = createUdsLogger(sink, 'addon-x', TEST_NODE_ID)
    logger.info('hi', { tags: { k: 'v' } })

    expect(sendLog).toHaveBeenCalledOnce()
    const entry = sendLog.mock.calls[0]![0] as Omit<ChildLogMessage, 'kind'>
    expect(entry.level).toBe('info')
    expect(entry.message).toBe('hi')
    expect(entry.addonId).toBe('addon-x')
    expect(entry.tags).toMatchObject({ k: 'v' })
    // `kind` must NOT appear — we pass Omit<ChildLogMessage,'kind'>
    expect('kind' in entry).toBe(false)
  })

  it('debug maps to level=debug', () => {
    const logger = createUdsLogger(sink, 'addon-x', TEST_NODE_ID)
    logger.debug('dbg')
    expect(sendLog.mock.calls[0]![0]).toMatchObject({ level: 'debug', message: 'dbg' })
  })

  it('warn maps to level=warn', () => {
    const logger = createUdsLogger(sink, 'addon-x', TEST_NODE_ID)
    logger.warn('ugh')
    expect(sendLog.mock.calls[0]![0]).toMatchObject({ level: 'warn', message: 'ugh' })
  })

  it('error maps to level=error', () => {
    const logger = createUdsLogger(sink, 'addon-x', TEST_NODE_ID)
    logger.error('boom')
    expect(sendLog.mock.calls[0]![0]).toMatchObject({ level: 'error', message: 'boom' })
  })

  // ── 2. child() ───────────────────────────────────────────────────────────

  it('child(scopeA) produces a logger whose entries carry scope=scopeA', () => {
    const logger = createUdsLogger(sink, 'addon-x', TEST_NODE_ID)
    const child = logger.child('scopeA')
    child.info('inside')
    expect(sendLog.mock.calls[0]![0]).toMatchObject({ scope: 'scopeA' })
  })

  it('nested child(b) REPLACES scope (matches remote-logger convention — scope is a single label)', () => {
    const logger = createUdsLogger(sink, 'addon-x', TEST_NODE_ID)
    const child = logger.child('scopeA')
    const nested = child.child('scopeB')
    nested.info('deep')
    // remote-logger: child overrides scope (not appended)
    expect(sendLog.mock.calls[0]![0]).toMatchObject({ scope: 'scopeB' })
  })

  it('parent logger retains no scope after child() call', () => {
    const logger = createUdsLogger(sink, 'addon-x', TEST_NODE_ID)
    logger.child('scopeA')
    logger.info('from parent')
    const entry = sendLog.mock.calls[0]![0] as Omit<ChildLogMessage, 'kind'>
    // parent scope is undefined since no scope was passed to createUdsLogger
    expect(entry.scope).toBeUndefined()
  })

  // ── 3. withTags() ─────────────────────────────────────────────────────────

  it('withTags merges tags into subsequent entries', () => {
    const logger = createUdsLogger(sink, 'addon-x', TEST_NODE_ID)
    const tagged = logger.withTags({ deviceId: 7 })
    tagged.info('tagged msg')
    expect(sendLog.mock.calls[0]![0]).toMatchObject({
      tags: expect.objectContaining({ deviceId: 7 }),
    })
  })

  it('withTags does not affect the original logger', () => {
    const logger = createUdsLogger(sink, 'addon-x', TEST_NODE_ID)
    logger.withTags({ deviceId: 7 })
    logger.info('original')
    const entry = sendLog.mock.calls[0]![0] as Omit<ChildLogMessage, 'kind'>
    expect(entry.tags?.deviceId).toBeUndefined()
  })

  it('per-call extras.tags are merged with withTags baseline', () => {
    const logger = createUdsLogger(sink, 'addon-x', TEST_NODE_ID)
    const tagged = logger.withTags({ addonId: 'addon-x', deviceId: 3 })
    tagged.info('msg', { tags: { streamId: '3/main' } })
    const entry = sendLog.mock.calls[0]![0] as Omit<ChildLogMessage, 'kind'>
    expect(entry.tags).toMatchObject({ deviceId: 3, streamId: '3/main' })
  })

  // ── 4. Pre-connect buffering (delegated to client) ─────────────────────────
  //
  // The uds-logger delegates pre-connect buffering to LocalChildClient.sendLog
  // (which already queues log entries before start() and flushes on connect).
  // The logger itself is a thin adapter — it always calls sendLog regardless of
  // connection state, because the client handles the queue. We verify that a log
  // emitted at any time STILL reaches sendLog.

  it('calls sendLog unconditionally (buffering delegated to client)', () => {
    // UdsLogSink no longer exposes isConnected — makeSink() returns the minimal
    // interface; the logger never reads connection state.
    const fake = makeSink()
    const logger = createUdsLogger(fake.sink, 'addon-x', TEST_NODE_ID)
    logger.info('early boot log')
    // Must reach sendLog — the client buffers it until connected
    expect(fake.sendLog).toHaveBeenCalledOnce()
    expect(fake.sendLog.mock.calls[0]![0]).toMatchObject({
      level: 'info',
      message: 'early boot log',
    })
  })

  // ── 5. meta propagation ────────────────────────────────────────────────────

  it('meta from extras is forwarded in the entry', () => {
    const logger = createUdsLogger(sink, 'addon-x', TEST_NODE_ID)
    logger.error('fail', { meta: { err: 'ETIMEDOUT', retries: 3 } })
    expect(sendLog.mock.calls[0]![0]).toMatchObject({ meta: { err: 'ETIMEDOUT', retries: 3 } })
  })

  // ── 6. scope passed to factory ────────────────────────────────────────────

  it('scope passed to createUdsLogger is carried in entries', () => {
    const logger = createUdsLogger(sink, 'addon-x', TEST_NODE_ID, 'process-runner')
    logger.warn('startup')
    expect(sendLog.mock.calls[0]![0]).toMatchObject({ scope: 'process-runner' })
  })

  // ── 7. addonId always in entry ────────────────────────────────────────────

  it('addonId is present even in child loggers', () => {
    const logger = createUdsLogger(sink, 'my-addon', TEST_NODE_ID)
    const child = logger.child('sub')
    child.info('x')
    expect(sendLog.mock.calls[0]![0]).toMatchObject({ addonId: 'my-addon' })
  })

  // ── 8. nodeId / agentId / pid identity fields (Fix 1 + Fix 2) ───────────
  //
  // Parity with createRemoteLogger: every emitted entry and its baseTags must
  // carry nodeId, agentId (derived as the prefix before '/'), and pid.

  it('entry top-level carries nodeId', () => {
    const logger = createUdsLogger(sink, 'addon-x', TEST_NODE_ID)
    logger.info('msg')
    const entry = sendLog.mock.calls[0]![0] as Omit<ChildLogMessage, 'kind'>
    expect(entry.nodeId).toBe(TEST_NODE_ID)
  })

  it('baseTags carries nodeId, agentId (hub prefix), and pid', () => {
    const logger = createUdsLogger(sink, 'addon-x', TEST_NODE_ID)
    logger.info('msg')
    const entry = sendLog.mock.calls[0]![0] as Omit<ChildLogMessage, 'kind'>
    expect(entry.tags).toMatchObject({
      nodeId: TEST_NODE_ID,
      agentId: TEST_AGENT_ID,
      pid: expect.any(Number),
    })
  })

  it('agentId is the full nodeId when nodeId has no slash', () => {
    const logger = createUdsLogger(sink, 'addon-x', 'standalone-node')
    logger.info('msg')
    const entry = sendLog.mock.calls[0]![0] as Omit<ChildLogMessage, 'kind'>
    expect(entry.tags).toMatchObject({
      nodeId: 'standalone-node',
      agentId: 'standalone-node',
    })
  })

  it('child() preserves nodeId and agentId in identity tags', () => {
    const logger = createUdsLogger(sink, 'addon-x', TEST_NODE_ID)
    const child = logger.child('sub-scope')
    child.info('from child')
    const entry = sendLog.mock.calls[0]![0] as Omit<ChildLogMessage, 'kind'>
    expect(entry.nodeId).toBe(TEST_NODE_ID)
    expect(entry.tags).toMatchObject({
      nodeId: TEST_NODE_ID,
      agentId: TEST_AGENT_ID,
    })
  })

  it('withTags() preserves nodeId and agentId in identity tags', () => {
    const logger = createUdsLogger(sink, 'addon-x', TEST_NODE_ID)
    const tagged = logger.withTags({ deviceId: 42 })
    tagged.info('tagged')
    const entry = sendLog.mock.calls[0]![0] as Omit<ChildLogMessage, 'kind'>
    expect(entry.tags).toMatchObject({
      nodeId: TEST_NODE_ID,
      agentId: TEST_AGENT_ID,
      deviceId: 42,
    })
  })
})

// ── createUdsLoggerWithControl (E2 — set-log-level over UDS) ─────────────────
describe('createUdsLoggerWithControl', () => {
  let sendLog: ReturnType<typeof vi.fn>
  let sink: UdsLogSink

  beforeEach(() => {
    const fake = makeSink()
    sink = fake.sink
    sendLog = fake.sendLog
  })

  it('default level forwards every level (parity with createUdsLogger)', () => {
    const { logger } = createUdsLoggerWithControl(sink, 'addon-x', TEST_NODE_ID)
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
    expect(sendLog).toHaveBeenCalledTimes(4)
  })

  it('setLevel("warn") drops debug + info, keeps warn + error', () => {
    const { logger, control } = createUdsLoggerWithControl(sink, 'addon-x', TEST_NODE_ID)
    control.setLevel('warn')
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
    const levels = sendLog.mock.calls.map((c) => (c[0] as Omit<ChildLogMessage, 'kind'>).level)
    expect(levels).toEqual(['warn', 'error'])
  })

  it('setLevel retunes child() and withTags() descendants (shared level state)', () => {
    const { logger, control } = createUdsLoggerWithControl(sink, 'addon-x', TEST_NODE_ID)
    const child = logger.child('sub')
    const tagged = logger.withTags({ deviceId: 1 })
    control.setLevel('error')
    child.info('child-info') // dropped
    tagged.warn('tagged-warn') // dropped
    child.error('child-err') // kept
    const levels = sendLog.mock.calls.map((c) => (c[0] as Omit<ChildLogMessage, 'kind'>).level)
    expect(levels).toEqual(['error'])
  })
})
