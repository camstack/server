/**
 * Profile-slot broker — C2 of the stream-broker refactor.
 *
 * Tests mirati per il nuovo contratto:
 *   - broker IS keyed by `${deviceId}/${profile}` (high/mid/low)
 *   - providers publish physical cam streams via `publishCameraStream`
 *   - auto-assignment runs until the first manual `assignProfile` call
 *   - push-kind streams drive demand/idle events over the event bus
 *   - profileMap persistence fires on every change
 */

import type { EventFilter, IEventBus, IScopedLogger, SystemEvent } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager'

// ── Fakes ────────────────────────────────────────────────────────────

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

function makeEventBus(): { bus: IEventBus; captured: SystemEvent[] } {
  const captured: SystemEvent[] = []
  const handlers = new Map<string, Set<(event: SystemEvent) => void>>()
  const bus: IEventBus = {
    emit(event: SystemEvent) {
      captured.push(event)
      const set = handlers.get(event.category)
      if (set) for (const h of set) h(event)
    },
    subscribe(filter: EventFilter, handler: (event: SystemEvent) => void) {
      const cat =
        typeof filter === 'object' && 'category' in filter && typeof filter.category === 'string'
          ? filter.category
          : '*'
      const existing = handlers.get(cat) ?? new Set()
      existing.add(handler)
      handlers.set(cat, existing)
      return () => {
        handlers.get(cat)?.delete(handler)
      }
    },
    getRecent() {
      return captured as readonly SystemEvent[]
    },
  }
  return { bus, captured }
}

function makeManager(): StreamBrokerManager {
  return new StreamBrokerManager(makeLogger())
}

/**
 * Patch the manager with a minimal RTSP stub so publish paths don't try
 * to bind a real listen server port. Same technique used by the
 * device-contribution spec.
 */
function stubRtsp(manager: StreamBrokerManager): void {
  ;(manager as unknown as { rtspProvider: unknown }).rtspProvider = {
    getEntry: vi.fn((brokerId: string) => ({
      brokerId,
      url: `rtsp://host/${brokerId}`,
      mutedUrl: '',
      enabled: true,
    })),
    getInternalEntry: vi.fn((brokerId: string) => ({
      brokerId,
      url: `rtsp://host/${brokerId}`,
      mutedUrl: '',
      enabled: true,
    })),
    setEnabled: vi.fn(),
    isEnabled: vi.fn(() => true),
    setTokenPersister: vi.fn(),
    setEnabledPersister: vi.fn(),
    getAllEntries: vi.fn(() => []),
    regenerateToken: vi.fn(),
    getRtspPort: vi.fn(() => 8554),
    persistTokens: vi.fn(),
  }
  // Swap the RtspListenServer with a no-op stand-in so `registerRestreamer`
  // and `unregisterRestreamer` don't blow up when brokers come up.
  ;(manager as unknown as { rtspServer: unknown }).rtspServer = {
    registerRestreamer: vi.fn(),
    unregisterRestreamer: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getPort: vi.fn(() => 8554),
    loadEnabled: vi.fn(),
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('StreamBrokerManager — profile-slot broker (C2)', () => {
  let manager: StreamBrokerManager

  beforeEach(() => {
    manager = makeManager()
    stubRtsp(manager)
  })

  describe('auto-assignment rules', () => {
    it('publish of 1 stream auto-assigns to `mid`', async () => {
      await manager.publishCameraStream({
        deviceId: 1,
        camStreamId: 'stream-a',
        kind: 'pull-rtsp',
        url: 'rtsp://x',
      })
      const slots = manager.getProfileSlotsForDevice(1)
      const mid = slots.find((s) => s.profile === 'mid')!
      const high = slots.find((s) => s.profile === 'high')!
      const low = slots.find((s) => s.profile === 'low')!
      expect(mid.sourceCamStreamId).toBe('stream-a')
      expect(high.sourceCamStreamId).toBeNull()
      expect(low.sourceCamStreamId).toBeNull()
    })

    it('publish of 2 streams assigns higher-resolution → high, lower → low', async () => {
      await manager.publishCameraStream({
        deviceId: 2,
        camStreamId: 'hi',
        kind: 'pull-rtsp',
        url: 'rtsp://hi',
        resolution: { width: 1920, height: 1080 },
      })
      await manager.publishCameraStream({
        deviceId: 2,
        camStreamId: 'lo',
        kind: 'pull-rtsp',
        url: 'rtsp://lo',
        resolution: { width: 640, height: 480 },
      })
      const slots = manager.getProfileSlotsForDevice(2)
      expect(slots.find((s) => s.profile === 'high')!.sourceCamStreamId).toBe('hi')
      expect(slots.find((s) => s.profile === 'low')!.sourceCamStreamId).toBe('lo')
      expect(slots.find((s) => s.profile === 'mid')!.sourceCamStreamId).toBeNull()
    })

    it('publish of 3 streams → canonical high/mid/low by resolution', async () => {
      await manager.publishCameraStream({
        deviceId: 3,
        camStreamId: 'a',
        kind: 'pull-rtsp',
        url: 'rtsp://a',
        resolution: { width: 640, height: 480 },
      })
      await manager.publishCameraStream({
        deviceId: 3,
        camStreamId: 'b',
        kind: 'pull-rtsp',
        url: 'rtsp://b',
        resolution: { width: 3840, height: 2160 },
      })
      await manager.publishCameraStream({
        deviceId: 3,
        camStreamId: 'c',
        kind: 'pull-rtsp',
        url: 'rtsp://c',
        resolution: { width: 1280, height: 720 },
      })
      const slots = manager.getProfileSlotsForDevice(3)
      expect(slots.find((s) => s.profile === 'high')!.sourceCamStreamId).toBe('b')
      expect(slots.find((s) => s.profile === 'mid')!.sourceCamStreamId).toBe('c')
      expect(slots.find((s) => s.profile === 'low')!.sourceCamStreamId).toBe('a')
    })

    it('re-publish of same camStreamId leaves profileMap untouched', async () => {
      await manager.publishCameraStream({
        deviceId: 4,
        camStreamId: 'only',
        kind: 'pull-rtsp',
        url: 'rtsp://x',
      })
      const firstSlots = manager.getProfileSlotsForDevice(4)

      // Republish with updated label — should be idempotent for profileMap.
      await manager.publishCameraStream({
        deviceId: 4,
        camStreamId: 'only',
        kind: 'pull-rtsp',
        url: 'rtsp://x',
        label: 'Main',
      })
      const secondSlots = manager.getProfileSlotsForDevice(4)
      expect(secondSlots.find((s) => s.profile === 'mid')!.sourceCamStreamId).toBe('only')
      expect(secondSlots.find((s) => s.profile === 'mid')!.sourceCamStreamId).toBe(
        firstSlots.find((s) => s.profile === 'mid')!.sourceCamStreamId,
      )

      // Label is observable on the device-scoped read.
      const cams = manager.getCameraStreamsForDevice(4)
      expect(cams[0]!.label).toBe('Main')
    })
  })

  describe('retract', () => {
    it('retract of assigned camStream unassigns the profile and destroys its broker', async () => {
      await manager.publishCameraStream({
        deviceId: 5,
        camStreamId: 'only',
        kind: 'pull-rtsp',
        url: 'rtsp://x',
      })
      expect(await manager.getBroker({ brokerId: '5/only' })).not.toBeNull()

      await manager.retractCameraStream({ deviceId: 5, camStreamId: 'only' })

      expect(await manager.getBroker({ brokerId: '5/only' })).toBeNull()
      const slots = manager.getProfileSlotsForDevice(5)
      expect(slots.every((s) => s.sourceCamStreamId === null)).toBe(true)
    })

    it('retract of non-existent camStream is a no-op', async () => {
      await manager.publishCameraStream({
        deviceId: 6,
        camStreamId: 'keep',
        kind: 'pull-rtsp',
        url: 'rtsp://x',
      })
      await manager.retractCameraStream({ deviceId: 6, camStreamId: 'ghost' })
      const slots = manager.getProfileSlotsForDevice(6)
      expect(slots.find((s) => s.profile === 'mid')!.sourceCamStreamId).toBe('keep')
    })

    it('device unregister preserves all manual profile assignments including a derived stream', async () => {
      await manager.publishCameraStream({
        deviceId: 24,
        camStreamId: 'native:main',
        kind: 'pull-rtsp',
        url: 'rtsp://main',
      })
      await manager.publishCameraStream({
        deviceId: 24,
        camStreamId: 'native:mid',
        kind: 'pull-rtsp',
        url: 'rtsp://mid',
      })
      await manager.publishCameraStream({
        deviceId: 24,
        camStreamId: 'derived:mobile',
        kind: 'derived',
        source: { kind: 'camStream', camStreamId: 'native:main' },
        encodeProfile: {
          video: { codec: 'h264', width: 640, height: 360 },
          audio: 'passthrough',
        },
      })
      await manager.assignProfile({
        deviceId: 24,
        profile: 'high',
        camStreamId: 'native:main',
      })
      await manager.assignProfile({
        deviceId: 24,
        profile: 'mid',
        camStreamId: 'native:mid',
      })
      await manager.assignProfile({
        deviceId: 24,
        profile: 'low',
        camStreamId: 'derived:mobile',
      })
      const persist = vi.fn()
      manager.setProfileMapPersister(persist)

      await manager.retractDevice(24, { preserveAssignments: true })

      expect(persist).not.toHaveBeenCalled()
      expect(
        Object.fromEntries(
          manager
            .getProfileSlotsForDevice(24)
            .map((slot) => [slot.profile, slot.sourceCamStreamId]),
        ),
      ).toEqual({
        high: 'native:main',
        mid: 'native:mid',
        low: 'derived:mobile',
      })

      await manager.publishCameraStream({
        deviceId: 24,
        camStreamId: 'native:main',
        kind: 'pull-rtsp',
        url: 'rtsp://main',
      })
      await manager.publishCameraStream({
        deviceId: 24,
        camStreamId: 'native:mid',
        kind: 'pull-rtsp',
        url: 'rtsp://mid',
      })
      await manager.publishCameraStream({
        deviceId: 24,
        camStreamId: 'derived:mobile',
        kind: 'derived',
        source: { kind: 'camStream', camStreamId: 'native:main' },
        encodeProfile: {
          video: { codec: 'h264', width: 640, height: 360 },
          audio: 'passthrough',
        },
      })

      expect(
        Object.fromEntries(
          manager
            .getProfileSlotsForDevice(24)
            .map((slot) => [slot.profile, slot.sourceCamStreamId]),
        ),
      ).toEqual({
        high: 'native:main',
        mid: 'native:mid',
        low: 'derived:mobile',
      })
    })
  })

  describe('manual assignment', () => {
    it('assignProfile tears down the previous broker and builds a fresh one', async () => {
      await manager.publishCameraStream({
        deviceId: 7,
        camStreamId: 'a',
        kind: 'pull-rtsp',
        url: 'rtsp://a',
        resolution: { width: 1920, height: 1080 },
      })
      await manager.publishCameraStream({
        deviceId: 7,
        camStreamId: 'b',
        kind: 'pull-rtsp',
        url: 'rtsp://b',
        resolution: { width: 640, height: 480 },
      })
      // brokerId is now keyed by camStreamId; before reassign, brokers
      // exist for both published streams (publish lifecycle, not
      // profile lifecycle).
      const beforeA = await manager.getBroker({ brokerId: '7/a' })
      const beforeB = await manager.getBroker({ brokerId: '7/b' })
      expect(beforeA).not.toBeNull()
      expect(beforeB).not.toBeNull()

      await manager.assignProfile({ deviceId: 7, profile: 'high', camStreamId: 'b' })
      // Reassigning the profile slot does NOT tear down 'a' — its
      // broker stays alive for as long as the cam stream is published.
      const afterA = await manager.getBroker({ brokerId: '7/a' })
      const afterB = await manager.getBroker({ brokerId: '7/b' })
      expect(afterA).not.toBeNull()
      expect(afterB).not.toBeNull()
      expect(afterA).toBe(beforeA)
      expect(afterB).toBe(beforeB)
      expect(
        manager.getProfileSlotsForDevice(7).find((s) => s.profile === 'high')!.sourceCamStreamId,
      ).toBe('b')
    })

    it('assignProfile throws when the camStreamId is unknown', async () => {
      await manager.publishCameraStream({
        deviceId: 8,
        camStreamId: 'a',
        kind: 'pull-rtsp',
        url: 'rtsp://a',
      })
      await expect(
        manager.assignProfile({ deviceId: 8, profile: 'high', camStreamId: 'ghost' }),
      ).rejects.toThrow(/not published/)
    })

    it('manual assignProfile disables subsequent auto-reassignment', async () => {
      await manager.publishCameraStream({
        deviceId: 9,
        camStreamId: 'a',
        kind: 'pull-rtsp',
        url: 'rtsp://a',
        resolution: { width: 640, height: 480 },
      })
      // Manual assignment locks auto off.
      await manager.assignProfile({ deviceId: 9, profile: 'high', camStreamId: 'a' })

      // Publishing a higher-resolution stream must NOT reshuffle the assignment —
      // specifically, auto mode is off so `high` must stay pinned to 'a' even
      // though `b` has the larger pixel count.
      await manager.publishCameraStream({
        deviceId: 9,
        camStreamId: 'b',
        kind: 'pull-rtsp',
        url: 'rtsp://b',
        resolution: { width: 1920, height: 1080 },
      })
      const slots = manager.getProfileSlotsForDevice(9)
      expect(slots.find((s) => s.profile === 'high')!.sourceCamStreamId).toBe('a')
      // No derived on this device: auto=false still means empty slots stay
      // empty (an operator unassign must survive the next publish).
      expect(slots.find((s) => s.profile === 'low')!.sourceCamStreamId).toBeNull()
    })

    it('unassignProfile is idempotent and never tears down the broker', async () => {
      await manager.publishCameraStream({
        deviceId: 10,
        camStreamId: 'a',
        kind: 'pull-rtsp',
        url: 'rtsp://a',
      })
      // After publish: auto-assign puts 'a' on `mid` (1-stream rule).
      // Manually pinning 'a' to `high` adds a SECOND profile binding
      // for the same camStreamId — both slots reference the same
      // broker via `assignments[10].map`.
      await manager.assignProfile({ deviceId: 10, profile: 'high', camStreamId: 'a' })

      const first = await manager.unassignProfile({ deviceId: 10, profile: 'high' })
      const second = await manager.unassignProfile({ deviceId: 10, profile: 'high' })
      expect(first.success).toBe(true)
      expect(second.success).toBe(true)
      // Broker is published-stream-keyed — survives every profile
      // reassignment.
      expect(await manager.getBroker({ brokerId: '10/a' })).not.toBeNull()
      await manager.unassignProfile({ deviceId: 10, profile: 'mid' })
      expect(await manager.getBroker({ brokerId: '10/a' })).not.toBeNull()
      // Only retraction tears it down.
      await manager.retractCameraStream({ deviceId: 10, camStreamId: 'a' })
      expect(await manager.getBroker({ brokerId: '10/a' })).toBeNull()
    })

    it('restartProfile rebuilds the broker for the assigned slot', async () => {
      await manager.publishCameraStream({
        deviceId: 11,
        camStreamId: 'a',
        kind: 'pull-rtsp',
        url: 'rtsp://a',
      })
      const before = await manager.getBroker({ brokerId: '11/a' })
      expect(before).not.toBeNull()

      const res = await manager.restartProfile({ deviceId: 11, profile: 'mid' })
      expect(res.success).toBe(true)

      const after = await manager.getBroker({ brokerId: '11/a' })
      expect(after).not.toBeNull()
      expect(after).not.toBe(before)
    })

    it('restartProfile returns {success: false} when the slot is unassigned', async () => {
      const res = await manager.restartProfile({ deviceId: 12, profile: 'mid' })
      expect(res.success).toBe(false)
    })
  })

  describe('persistence', () => {
    it('profileMap persister fires on publish, assign, and unassign', async () => {
      const persister = vi.fn()
      manager.setProfileMapPersister(persister)

      await manager.publishCameraStream({
        deviceId: 13,
        camStreamId: 'a',
        kind: 'pull-rtsp',
        url: 'rtsp://a',
      })
      expect(persister).toHaveBeenCalled()
      const callsAfterPublish = persister.mock.calls.length

      await manager.assignProfile({ deviceId: 13, profile: 'high', camStreamId: 'a' })
      expect(persister.mock.calls.length).toBeGreaterThan(callsAfterPublish)

      const callsAfterAssign = persister.mock.calls.length
      await manager.unassignProfile({ deviceId: 13, profile: 'high' })
      expect(persister.mock.calls.length).toBeGreaterThan(callsAfterAssign)
    })

    it('loadPersistedProfileMap seeds assignments at boot', async () => {
      manager.loadPersistedProfileMap(new Map([[50, { map: { mid: 'persisted' }, auto: false }]]))
      await manager.publishCameraStream({
        deviceId: 50,
        camStreamId: 'persisted',
        kind: 'pull-rtsp',
        url: 'rtsp://x',
      })
      const slots = manager.getProfileSlotsForDevice(50)
      expect(slots.find((s) => s.profile === 'mid')!.sourceCamStreamId).toBe('persisted')

      // Because auto=false, a second publish must NOT move the assignment to high.
      await manager.publishCameraStream({
        deviceId: 50,
        camStreamId: 'other',
        kind: 'pull-rtsp',
        url: 'rtsp://y',
        resolution: { width: 1920, height: 1080 },
      })
      const after = manager.getProfileSlotsForDevice(50)
      expect(after.find((s) => s.profile === 'mid')!.sourceCamStreamId).toBe('persisted')
      expect(after.find((s) => s.profile === 'high')!.sourceCamStreamId).toBeNull()
    })
  })

  describe('push-kind demand/idle events', () => {
    it('publish + auto-assign of push-kind emits onCamStreamDemand', async () => {
      const { bus, captured } = makeEventBus()
      manager.setEventBus(bus)

      await manager.publishCameraStream({
        deviceId: 20,
        camStreamId: 'push',
        kind: 'push-annexb',
      })
      const demand = captured.filter((e) => e.category === 'stream-broker.onCamStreamDemand')
      expect(demand).toHaveLength(1)
      expect(demand[0]!.data).toMatchObject({ deviceId: 20, camStreamId: 'push', profile: 'mid' })
    })

    it('retracting the only consumer emits onCamStreamIdle exactly once', async () => {
      const { bus, captured } = makeEventBus()
      manager.setEventBus(bus)

      await manager.publishCameraStream({
        deviceId: 21,
        camStreamId: 'push',
        kind: 'push-annexb',
      })
      await manager.retractCameraStream({ deviceId: 21, camStreamId: 'push' })
      const idle = captured.filter((e) => e.category === 'stream-broker.onCamStreamIdle')
      expect(idle).toHaveLength(1)
      expect(idle[0]!.data).toMatchObject({ deviceId: 21, camStreamId: 'push' })
    })

    it('pull-kind streams do NOT emit demand/idle', async () => {
      const { bus, captured } = makeEventBus()
      manager.setEventBus(bus)

      await manager.publishCameraStream({
        deviceId: 22,
        camStreamId: 'pull',
        kind: 'pull-rtsp',
        url: 'rtsp://x',
      })
      await manager.retractCameraStream({ deviceId: 22, camStreamId: 'pull' })
      expect(captured.filter((e) => e.category === 'stream-broker.onCamStreamDemand')).toHaveLength(
        0,
      )
      expect(captured.filter((e) => e.category === 'stream-broker.onCamStreamIdle')).toHaveLength(0)
    })

    it('shared push-kind assigned to 2 profiles emits demand once (0→N) and idle once (N→0)', async () => {
      const { bus, captured } = makeEventBus()
      manager.setEventBus(bus)

      await manager.publishCameraStream({
        deviceId: 23,
        camStreamId: 'shared',
        kind: 'push-annexb',
      })
      // After 1 stream: auto-assigns to mid only → 1 demand emission.
      expect(captured.filter((e) => e.category === 'stream-broker.onCamStreamDemand')).toHaveLength(
        1,
      )

      // Manually assign the same camStreamId to `high`. Since it's already
      // consumed by mid, no additional demand event should fire.
      await manager.assignProfile({ deviceId: 23, profile: 'high', camStreamId: 'shared' })
      expect(captured.filter((e) => e.category === 'stream-broker.onCamStreamDemand')).toHaveLength(
        1,
      )

      // Unassign one profile — the cam stream is still consumed by mid → no idle.
      await manager.unassignProfile({ deviceId: 23, profile: 'high' })
      expect(captured.filter((e) => e.category === 'stream-broker.onCamStreamIdle')).toHaveLength(0)

      // Retract the stream entirely → idle exactly once.
      await manager.retractCameraStream({ deviceId: 23, camStreamId: 'shared' })
      expect(captured.filter((e) => e.category === 'stream-broker.onCamStreamIdle')).toHaveLength(1)
    })
  })

  describe('system-wide views', () => {
    it('listAllCameraStreams returns entries across devices in publish order', async () => {
      await manager.publishCameraStream({
        deviceId: 30,
        camStreamId: 'd30-a',
        kind: 'pull-rtsp',
        url: 'rtsp://a',
      })
      await manager.publishCameraStream({
        deviceId: 31,
        camStreamId: 'd31-a',
        kind: 'pull-rtsp',
        url: 'rtsp://a',
      })
      const all = await manager.listAllCameraStreams()
      expect(all).toHaveLength(2)
      const ids = all.map((s) => `${s.deviceId}:${s.camStreamId}`).toSorted()
      expect(ids).toEqual(['30:d30-a', '31:d31-a'])
    })

    it('listAllProfileSlots returns all 3 slots for every device with an assignment', async () => {
      await manager.publishCameraStream({
        deviceId: 40,
        camStreamId: 'only',
        kind: 'pull-rtsp',
        url: 'rtsp://a',
      })
      const all = await manager.listAllProfileSlots()
      expect(all).toHaveLength(3)
      expect(all.map((s) => s.profile).toSorted()).toEqual(['high', 'low', 'mid'])
    })
  })
})
