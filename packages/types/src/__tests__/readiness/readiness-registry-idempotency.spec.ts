/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, no-restricted-syntax */
/**
 * Regression guard for the 2026-08-01 readiness "storm" investigation.
 *
 * What the incident showed: a hub container restart re-announced every
 * device-scoped cap (776 pairs for one producer generation) and EVERY
 * process's registry logged each pair once — 21 577 identical debug
 * lines in one boot minute. The idempotency guard in `ingest` HELD
 * (zero same-registry duplicates across the whole flood); the noise
 * was per-record logging of high-cardinality device scope, multiplied
 * by process count.
 *
 * These tests pin both properties:
 *  1. The idempotency guard: a same-generation + same-state replay is
 *     a full no-op — no snapshot write, no subscriber dispatch, and
 *     NO second log line. (Remove the guard in `ingest` and the
 *     "logs exactly once" assertions here fail.)
 *  2. The volume gate: device-scoped per-record lines are silent by
 *     default and opt-in via `verboseDeviceScopeLogs` (then carrying
 *     `tags.deviceId`); node-scoped lines always log.
 *  3. `hydrate` returns the APPLIED count so periodic reconciles can
 *     stay silent when nothing changed.
 */
import { describe, expect, it, vi } from 'vitest'
import { EventCategory } from '../../enums/event-category.js'
import type {
  EventFilter,
  IEventBus,
  KnownEventCategory,
  ReadinessScope,
  SystemEvent,
  SystemReadyStatePayload,
  TypedEventFilter,
  TypedSystemEvent,
} from '../../interfaces/event-bus.js'
import type { IScopedLogger, LogExtras } from '../../interfaces/logging.js'
import { ReadinessRegistry } from '../../readiness/readiness-registry.js'

// ── Test helpers ──────────────────────────────────────────────────────

class TestEventBus implements IEventBus {
  private subs: Array<{ filter: EventFilter; handler: (event: SystemEvent) => void }> = []
  emitted: SystemEvent[] = []

  emit(event: SystemEvent): void {
    this.emitted.push(event)
    for (const s of this.subs) {
      if (matchesFilter(event, s.filter)) s.handler(event)
    }
  }

  subscribe<C extends KnownEventCategory>(
    filter: TypedEventFilter<C>,
    handler: (event: TypedSystemEvent<C>) => void,
  ): () => void
  subscribe(filter: EventFilter, handler: (event: SystemEvent) => void): () => void
  subscribe(filter: EventFilter, handler: (event: SystemEvent) => void): () => void {
    const entry = { filter, handler }
    this.subs.push(entry)
    return () => {
      this.subs = this.subs.filter((s) => s !== entry)
    }
  }

  getRecent(): readonly SystemEvent[] {
    return []
  }
}

function matchesFilter(event: SystemEvent, filter: EventFilter): boolean {
  if (!filter.category) return true
  const cats = Array.isArray(filter.category) ? filter.category : [filter.category]
  return cats.some((c) => c === event.category)
}

interface RecordedLine {
  readonly message: string
  readonly extras: LogExtras | undefined
}

function makeSpyLogger(): { logger: IScopedLogger; debugLines: RecordedLine[] } {
  const debugLines: RecordedLine[] = []
  const logger: IScopedLogger = {
    debug: (message: string, extras?: LogExtras) => {
      debugLines.push({ message, extras })
    },
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, debugLines }
}

function readyPayload(overrides?: Partial<SystemReadyStatePayload>): SystemReadyStatePayload {
  return {
    capName: 'cap-x',
    scope: { type: 'node', nodeId: 'a' },
    state: 'ready',
    generation: 'gen-A',
    sourceNodeId: 'remote-node',
    ts: 1000,
    ...overrides,
  }
}

function announceOnBus(bus: TestEventBus, payload: SystemReadyStatePayload): void {
  bus.emit({
    id: `evt-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date(),
    source: { type: 'capability', id: payload.capName, nodeId: payload.sourceNodeId },
    category: EventCategory.SystemReadyState,
    data: payload,
  })
}

const deviceScope: ReadinessScope = { type: 'device', deviceId: 102 }

// ── Tests ─────────────────────────────────────────────────────────────

describe('ReadinessRegistry — idempotent replay is a FULL no-op (dispatch + log)', () => {
  it('a repeated same-generation same-state announcement neither re-dispatches nor re-logs', () => {
    const bus = new TestEventBus()
    const { logger, debugLines } = makeSpyLogger()
    const reg = new ReadinessRegistry({
      eventBus: bus,
      sourceNodeId: 'consumer-node',
      logger,
    })
    const handler = vi.fn()
    reg.onReadyState('cap-x', { type: 'node', nodeId: 'a' }, handler)

    announceOnBus(bus, readyPayload())
    announceOnBus(bus, readyPayload({ ts: 2000 }))
    announceOnBus(bus, readyPayload({ ts: 3000 }))

    // Snapshot recorded once; epoch never moved.
    const rec = reg.get('cap-x', { type: 'node', nodeId: 'a' })
    expect(rec?.state).toBe('ready')
    expect(rec?.epoch).toBe(1)
    // Dispatched once.
    expect(handler).toHaveBeenCalledTimes(1)
    // Logged exactly once — this is the assertion that fails if the
    // idempotency guard in `ingest` is removed.
    const ingestLines = debugLines.filter((l) => l.message.includes('cap-x'))
    expect(ingestLines).toHaveLength(1)
    expect(ingestLines[0]!.message).toContain('epoch=1')
    reg.close()
  })

  it('device-scoped replays are equally guarded when verbose logging is enabled', () => {
    const bus = new TestEventBus()
    const { logger, debugLines } = makeSpyLogger()
    const reg = new ReadinessRegistry({
      eventBus: bus,
      sourceNodeId: 'consumer-node',
      logger,
      verboseDeviceScopeLogs: true,
    })

    announceOnBus(bus, readyPayload({ scope: deviceScope }))
    announceOnBus(bus, readyPayload({ scope: deviceScope, ts: 2000 }))

    const lines = debugLines.filter((l) => l.message.includes('device:102'))
    expect(lines).toHaveLength(1)
    // CLAUDE.md logging rule: device lines carry tags.deviceId.
    expect(lines[0]!.extras?.tags?.deviceId).toBe(102)
    reg.close()
  })
})

describe('ReadinessRegistry — device-scope log volume gate', () => {
  it('device-scoped per-record lines are silent by default; node-scoped always log', () => {
    const bus = new TestEventBus()
    const { logger, debugLines } = makeSpyLogger()
    const reg = new ReadinessRegistry({
      eventBus: bus,
      sourceNodeId: 'consumer-node',
      logger,
    })

    announceOnBus(bus, readyPayload({ scope: deviceScope }))
    announceOnBus(bus, readyPayload({ capName: 'cap-node', scope: { type: 'node', nodeId: 'a' } }))

    // The device transition is INGESTED (state queryable) but not logged.
    expect(reg.get('cap-x', deviceScope)?.state).toBe('ready')
    expect(debugLines.filter((l) => l.message.includes('device:102'))).toHaveLength(0)
    // The node transition still logs per-record.
    expect(debugLines.filter((l) => l.message.includes('cap-node'))).toHaveLength(1)
    reg.close()
  })
})

describe('ReadinessRegistry — hydrate returns applied count', () => {
  it('first hydrate applies all records; an identical re-hydrate applies none', () => {
    const bus = new TestEventBus()
    const reg = new ReadinessRegistry({ eventBus: bus, sourceNodeId: 'consumer-node' })
    const snapshot = [
      {
        capName: 'cap-x',
        scope: deviceScope,
        state: 'ready' as const,
        generation: 'gen-A',
        epoch: 1,
        lastChange: 1000,
        sourceNodeId: 'remote-node',
      },
      {
        capName: 'cap-y',
        scope: { type: 'node' as const, nodeId: 'a' },
        state: 'ready' as const,
        generation: 'gen-A',
        epoch: 1,
        lastChange: 1000,
        sourceNodeId: 'a',
      },
    ]
    expect(reg.hydrate(snapshot)).toBe(2)
    // The 60s reconcile case: identical snapshot → nothing applied →
    // callers (readiness-context) stay silent.
    expect(reg.hydrate(snapshot)).toBe(0)
    reg.close()
  })
})
