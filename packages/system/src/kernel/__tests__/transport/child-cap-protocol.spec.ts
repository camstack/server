import { describe, expect, it } from 'vitest'
import type {
  ChildEventMessage,
  ChildLogMessage,
  ChildToParentRequest,
  EventSubUpdateMessage,
  ParentEventMessage,
  ParentToChildRequest,
  ReadinessSnapshotRequest,
  ReadinessSnapshotResponse,
  RegisterMessage,
} from '../../transport/child-cap-protocol.js'

describe('UDS protocol — event/log/readiness message kinds', () => {
  it('child→parent union includes event, log, readiness-request', () => {
    const evt: ChildEventMessage = {
      kind: 'event',
      event: {
        id: 'e1',
        timestamp: new Date(),
        source: { type: 'addon', id: 'a' },
        category: 'device.registered',
        data: { deviceId: 1, providerId: 'p1' },
      },
    }
    const log: ChildLogMessage = { kind: 'log', level: 'info', message: 'hi', addonId: 'a' }
    const req: ReadinessSnapshotRequest = { kind: 'readiness-request' }
    const msgs: ChildToParentRequest[] = [evt, log, req]
    expect(msgs.map((m) => m.kind)).toEqual(['event', 'log', 'readiness-request'])
  })

  it('parent→child union includes event delivery + readiness snapshot', () => {
    const evt: ParentEventMessage = {
      kind: 'event',
      event: {
        id: 'e2',
        timestamp: new Date(),
        source: { type: 'core', id: 'hub' },
        category: 'system.ready-state',
        data: {
          capName: 'stream-broker',
          scope: { type: 'global' },
          state: 'ready',
          generation: 'gen-1',
          sourceNodeId: 'hub',
          ts: Date.now(),
        },
      },
      sourceNodeId: 'hub',
    }
    const res: ReadinessSnapshotResponse = { kind: 'readiness-snapshot', records: [] }
    const msgs: ParentToChildRequest[] = [evt, res]
    expect(msgs.map((m) => m.kind)).toEqual(['event', 'readiness-snapshot'])
  })
})

describe('UDS protocol — subscription-filtered event fan-out', () => {
  it('RegisterMessage without eventPatterns stays valid (back-compat / legacy child)', () => {
    // A legacy child bundling an older @camstack/system omits eventPatterns —
    // the field is OPTIONAL so this register message is still type-valid. The
    // parent reads its absence as "undeclared" and fails open (broadcast-all).
    const legacy: RegisterMessage = {
      kind: 'register',
      childId: 'legacy',
      caps: [{ capName: 'ptz', mode: 'singleton' }],
    }
    expect(legacy.eventPatterns).toBeUndefined()
  })

  it('RegisterMessage carries an optional eventPatterns snapshot', () => {
    const reg: RegisterMessage = {
      kind: 'register',
      childId: 'reolink',
      caps: [{ capName: 'ptz', mode: 'singleton' }],
      eventPatterns: ['device.bindings-changed', 'system.ready-state'],
    }
    expect(reg.eventPatterns).toEqual(['device.bindings-changed', 'system.ready-state'])
  })

  it('EventSubUpdateMessage is a fire-and-forget child→parent full-set-replace message', () => {
    const sub: EventSubUpdateMessage = {
      kind: 'event-sub',
      patterns: ['pipeline.*', 'system.ready-state'],
    }
    const msgs: ChildToParentRequest[] = [sub]
    expect(msgs.map((m) => m.kind)).toEqual(['event-sub'])
    expect(sub.patterns).toEqual(['pipeline.*', 'system.ready-state'])
  })
})
