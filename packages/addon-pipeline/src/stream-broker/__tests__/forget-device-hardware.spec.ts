/**
 * `forgetDeviceHardware` — the broker's half of a device migration
 * (`deviceManager.migrateDevice`).
 *
 * The 2026-09-01 incident these claims come from: after a Hikvision → Reolink
 * replacement on id 618, the broker still held `mid → native:slot-3` (a raw
 * slot only the Hikvision had) and the `derived:Mid to low` feeder — defined
 * against the old profile layout — respawned every ten seconds forever
 * (observed at attempt 2732). Nothing short of the permanent-removal purge
 * clears an assignment entry, and nothing at all deleted a derived definition.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'

const MIGRATED = 618
const BYSTANDER = 101

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this
    }),
    withTags: vi.fn(function (this: unknown) {
      return this
    }),
  } as unknown as ConstructorParameters<typeof StreamBrokerManager>[0]
}

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
  ;(manager as unknown as { rtspServer: unknown }).rtspServer = {
    registerRestreamer: vi.fn(),
    unregisterRestreamer: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getPort: vi.fn(() => 8554),
    loadEnabled: vi.fn(),
  }
}

type OverridesInternal = Map<
  number,
  {
    derivedStreams?: Record<string, unknown>
    audioMuted?: boolean
    hwaccel?: Record<string, unknown>
  }
>

function overrides(manager: StreamBrokerManager): OverridesInternal {
  return (manager as unknown as { deviceOverrides: OverridesInternal }).deviceOverrides
}

function assignments(manager: StreamBrokerManager): Map<number, unknown> {
  return (manager as unknown as { assignments: Map<number, unknown> }).assignments
}

describe('forgetDeviceHardware', () => {
  let manager: StreamBrokerManager
  beforeEach(async () => {
    manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
    await manager.publishCameraStream({
      deviceId: MIGRATED,
      camStreamId: 'high',
      kind: 'pull-rtsp',
      url: 'rtsp://old-hikvision/high',
    })
    await manager.publishCameraStream({
      deviceId: BYSTANDER,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://bystander/main',
    })
  })

  it('deletes every derived-stream definition and persists the deletion', async () => {
    await manager.applyDeviceSettingsPatch({
      deviceId: MIGRATED,
      patch: { derivedStreamNames: ['Mid to low'] },
    })
    const persister = vi.fn()
    manager.setDeviceOverridePersister(persister)

    const result = await manager.forgetDeviceHardware({ deviceId: MIGRATED })

    expect(result.derivedStreamsDeleted).toEqual(['Mid to low'])
    expect(overrides(manager).get(MIGRATED)?.derivedStreams).toBeUndefined()
    // The deletion was PERSISTED — an in-memory-only delete resurrects the
    // feeder at the next boot, which is the 10-second respawn forever.
    expect(persister).toHaveBeenCalled()
    const lastCall = persister.mock.calls.at(-1) as [ReadonlyMap<number, unknown>]
    expect(lastCall[0].get(MIGRATED)).toBeUndefined()
  })

  it('purges the profile-slot assignment ENTRY, so a fresh publish re-derives it', async () => {
    // publish gave the device an automatic assignment
    expect(assignments(manager).has(MIGRATED)).toBe(true)

    const result = await manager.forgetDeviceHardware({ deviceId: MIGRATED })

    expect(result.assignmentsPurged).toBe(true)
    expect(assignments(manager).has(MIGRATED)).toBe(false)
    // NOT the unassign path: an entry `{map: {}, auto: false}` would pin the
    // slots manual and block computeInitialAssignment on the new hardware.
    expect(assignments(manager).get(MIGRATED)).toBeUndefined()
  })

  it('drops the device probe snapshots and keeps the bystander', async () => {
    const streamingStats = {
      status: 'streaming',
      codec: 'h265',
      bitrateKbps: 2048,
      idrIntervalMs: 2000,
      audio: null,
    } as unknown as Parameters<StreamBrokerManager['recordProbeSnapshot']>[1]
    manager.recordProbeSnapshot(`${MIGRATED}/high`, streamingStats, 1000)
    manager.recordProbeSnapshot(`${BYSTANDER}/native:main`, streamingStats, 1000)
    // A prefix collision must not count: 61/xyz is not 618's.
    manager.recordProbeSnapshot(`61/other`, streamingStats, 1000)

    const result = await manager.forgetDeviceHardware({ deviceId: MIGRATED })

    expect(result.probeSnapshotsDropped).toBe(1)
    const remaining = Object.keys(manager.getProbeSnapshots())
    expect(remaining).toContain(`${BYSTANDER}/native:main`)
    expect(remaining).toContain('61/other')
    expect(remaining).not.toContain(`${MIGRATED}/high`)
  })

  it('keeps the role-scoped half of the override (audioMuted) and drops the camStreamId-keyed maps', async () => {
    overrides(manager).set(MIGRATED, {
      audioMuted: true,
      hwaccel: { high: 'vaapi' },
      derivedStreams: {},
    })

    await manager.forgetDeviceHardware({ deviceId: MIGRATED })

    const kept = overrides(manager).get(MIGRATED)
    // The operator's privacy choice is about the camera at this NUMBER.
    expect(kept?.audioMuted).toBe(true)
    // A parser/hwaccel chosen for the old firmware must not apply to a
    // same-named stream of the new box.
    expect(kept?.hwaccel).toBeUndefined()
    expect(kept?.derivedStreams).toBeUndefined()
  })

  it('runs the addon hook and reports its token-row deletions', async () => {
    const hook = vi.fn(async () => ({ rtspTokenRowsDeleted: 3 }))
    manager.setDeviceHardwareForgetHook(hook)

    const result = await manager.forgetDeviceHardware({ deviceId: MIGRATED })

    expect(hook).toHaveBeenCalledWith(MIGRATED)
    expect(result.rtspTokenRowsDeleted).toBe(3)
  })

  it('leaves the bystander device entirely alone', async () => {
    await manager.applyDeviceSettingsPatch({
      deviceId: BYSTANDER,
      patch: { derivedStreamNames: ['keepme'] },
    })

    await manager.forgetDeviceHardware({ deviceId: MIGRATED })

    expect(Object.keys(overrides(manager).get(BYSTANDER)?.derivedStreams ?? {})).toEqual(['keepme'])
    expect(assignments(manager).has(BYSTANDER)).toBe(true)
  })
})
