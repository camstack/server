/**
 * D83 — the manager half of the broker-side audio mute.
 *
 * Three properties, each of which failing would produce a switch that reads
 * "muted" while the camera is audible:
 *
 *  1. the mute PERSISTS into the store the broker already owns
 *     (`DeviceOverride`), not a new map;
 *  2. it applies to every live broker of the device at once; and
 *  3. it is applied to a broker CREATED LATER — a restart, a reconnect or a
 *     catalog republish must not un-mute a camera.
 *
 * (3) is the one that would be missed: a mute that only touched live brokers
 * would test green all day and quietly lapse on the next respawn.
 */
import type { IScopedLogger } from '@camstack/types'
import { makeSourceBrokerId } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DeviceOverride } from '../stream-broker/stream-broker-manager.js'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'
import type { StreamBroker } from '../stream-broker/stream-broker.js'

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

function brokerMap(manager: StreamBrokerManager): Map<string, StreamBroker> {
  return (manager as unknown as { brokers: Map<string, StreamBroker> }).brokers
}

const DEVICE_ID = 102

describe('StreamBrokerManager — broker-side audio mute (D83)', () => {
  let manager: StreamBrokerManager
  let persisted: Map<number, DeviceOverride> | null

  beforeEach(async () => {
    manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
    persisted = null
    manager.setDeviceOverridePersister((map) => {
      // Snapshot, not the live map — a persister handed the manager's own
      // reference would make "was it written" untestable.
      persisted = new Map([...map].map(([k, v]) => [k, { ...v }]))
    })
    await manager.publishCameraStream({
      deviceId: DEVICE_ID,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://example/main',
    })
  })

  it('defaults to unmuted and reports it', () => {
    expect(manager.getDeviceAudioMute({ deviceId: DEVICE_ID })).toEqual({
      muted: false,
      appliedBrokers: 0,
    })
  })

  it('persists the mute into the existing DeviceOverride blob — no new store', async () => {
    await manager.setDeviceAudioMute({ deviceId: DEVICE_ID, muted: true })
    expect(persisted?.get(DEVICE_ID)?.audioMuted).toBe(true)
    expect(manager.getDeviceAudioMute({ deviceId: DEVICE_ID }).muted).toBe(true)
  })

  it('leaves every other field of the override untouched', async () => {
    const overrides = (manager as unknown as { deviceOverrides: Map<number, DeviceOverride> })
      .deviceOverrides
    overrides.set(DEVICE_ID, {
      streamingDebug: true,
      preBuffer: { 'native:main': { enabled: true, seconds: 4 } },
    })

    await manager.setDeviceAudioMute({ deviceId: DEVICE_ID, muted: true })

    const after = persisted?.get(DEVICE_ID)
    expect(after?.streamingDebug).toBe(true)
    expect(after?.preBuffer).toEqual({ 'native:main': { enabled: true, seconds: 4 } })
    expect(after?.audioMuted).toBe(true)
  })

  it('applies to every live broker of the device', async () => {
    await manager.publishCameraStream({
      deviceId: DEVICE_ID,
      camStreamId: 'native:sub',
      kind: 'pull-rtsp',
      url: 'rtsp://example/sub',
    })
    const result = await manager.setDeviceAudioMute({ deviceId: DEVICE_ID, muted: true })
    expect(result.appliedBrokers).toBe(2)
    for (const camStreamId of ['native:main', 'native:sub']) {
      const broker = brokerMap(manager).get(makeSourceBrokerId(DEVICE_ID, camStreamId))
      expect(broker?.isAudioMuted()).toBe(true)
    }
  })

  it('applies to a broker created AFTER the mute — a restart must not un-mute', async () => {
    await manager.setDeviceAudioMute({ deviceId: DEVICE_ID, muted: true })

    // The respawn shape: the live instance is gone, the cam stream stays
    // registered, and a consumer's retry rebuilds the broker.
    const brokers = brokerMap(manager)
    const brokerId = makeSourceBrokerId(DEVICE_ID, 'native:main')
    await brokers.get(brokerId)?.stop()
    brokers.delete(brokerId)

    await manager.publishCameraStream({
      deviceId: DEVICE_ID,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://example/main',
    })

    expect(brokers.get(brokerId)?.isAudioMuted()).toBe(true)
  })

  it('un-mutes every live broker again', async () => {
    await manager.setDeviceAudioMute({ deviceId: DEVICE_ID, muted: true })
    await manager.setDeviceAudioMute({ deviceId: DEVICE_ID, muted: false })
    expect(manager.getDeviceAudioMute({ deviceId: DEVICE_ID })).toEqual({
      muted: false,
      appliedBrokers: 0,
    })
    expect(
      brokerMap(manager).get(makeSourceBrokerId(DEVICE_ID, 'native:main'))?.isAudioMuted(),
    ).toBe(false)
  })

  it('the mute is device-wide, never leaking to another camera', async () => {
    await manager.publishCameraStream({
      deviceId: 101,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://other/main',
    })
    await manager.setDeviceAudioMute({ deviceId: DEVICE_ID, muted: true })
    expect(manager.getDeviceAudioMute({ deviceId: 101 }).muted).toBe(false)
    expect(brokerMap(manager).get(makeSourceBrokerId(101, 'native:main'))?.isAudioMuted()).toBe(
      false,
    )
  })
})

describe('StreamBrokerManager.reconcileDeviceAudioPlane — D83 net under D77', () => {
  let manager: StreamBrokerManager

  beforeEach(async () => {
    manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
    await manager.publishCameraStream({
      deviceId: DEVICE_ID,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://example/main',
    })
  })

  it('asks the CAMERA nothing while no broker is streaming — the cheap question first', async () => {
    const getStatus = vi.fn()
    manager.setApiAccess({ privacyMask: { getStatus: { query: getStatus } } } as never)
    await manager.reconcileDeviceAudioPlane(DEVICE_ID)
    expect(getStatus).not.toHaveBeenCalled()
  })

  it('asks the camera nothing while the operator has MUTED the plane', async () => {
    const getStatus = vi.fn()
    manager.setApiAccess({ privacyMask: { getStatus: { query: getStatus } } } as never)
    await manager.setDeviceAudioMute({ deviceId: DEVICE_ID, muted: true })
    const broker = brokerMap(manager).get(makeSourceBrokerId(DEVICE_ID, 'native:main'))
    vi.spyOn(broker!, 'status', 'get').mockReturnValue('streaming')

    await manager.reconcileDeviceAudioPlane(DEVICE_ID)
    // Silence is the operator's ask. Reading the camera to "confirm" it would
    // be an ISAPI round trip per camera per tick, forever, to learn nothing.
    expect(getStatus).not.toHaveBeenCalled()
  })

  it('asks the camera nothing while a broker already carries an audio track', async () => {
    const getStatus = vi.fn()
    manager.setApiAccess({ privacyMask: { getStatus: { query: getStatus } } } as never)
    const broker = brokerMap(manager).get(makeSourceBrokerId(DEVICE_ID, 'native:main'))
    vi.spyOn(broker!, 'status', 'get').mockReturnValue('streaming')
    vi.spyOn(broker!, 'hasAudioTrack').mockReturnValue(true)

    await manager.reconcileDeviceAudioPlane(DEVICE_ID)
    expect(getStatus).not.toHaveBeenCalled()
  })

  it('re-dials only after TWO passes agree that audio is declared but absent', async () => {
    const getStatus = vi.fn().mockResolvedValue({ enabled: false, regions: [], audioEnabled: true })
    manager.setApiAccess({ privacyMask: { getStatus: { query: getStatus } } } as never)
    const broker = brokerMap(manager).get(makeSourceBrokerId(DEVICE_ID, 'native:main'))
    vi.spyOn(broker!, 'status', 'get').mockReturnValue('streaming')
    vi.spyOn(broker!, 'hasAudioTrack').mockReturnValue(false)
    const redial = vi.spyOn(manager, 'redialDeviceSources').mockImplementation(() => undefined)

    await manager.reconcileDeviceAudioPlane(DEVICE_ID)
    expect(redial).not.toHaveBeenCalled()

    await manager.reconcileDeviceAudioPlane(DEVICE_ID)
    expect(redial).toHaveBeenCalledWith(DEVICE_ID, 'audio-plane-reconcile')
  })

  it('never re-dials on a camera that declares audio OFF', async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValue({ enabled: false, regions: [], audioEnabled: false })
    manager.setApiAccess({ privacyMask: { getStatus: { query: getStatus } } } as never)
    const broker = brokerMap(manager).get(makeSourceBrokerId(DEVICE_ID, 'native:main'))
    vi.spyOn(broker!, 'status', 'get').mockReturnValue('streaming')
    vi.spyOn(broker!, 'hasAudioTrack').mockReturnValue(false)
    const redial = vi.spyOn(manager, 'redialDeviceSources').mockImplementation(() => undefined)

    for (let i = 0; i < 10; i++) await manager.reconcileDeviceAudioPlane(DEVICE_ID)
    expect(redial).not.toHaveBeenCalled()
  })

  it('never re-dials on a read that keeps failing', async () => {
    const getStatus = vi.fn().mockRejectedValue(new Error('camera unreachable'))
    manager.setApiAccess({ privacyMask: { getStatus: { query: getStatus } } } as never)
    const broker = brokerMap(manager).get(makeSourceBrokerId(DEVICE_ID, 'native:main'))
    vi.spyOn(broker!, 'status', 'get').mockReturnValue('streaming')
    vi.spyOn(broker!, 'hasAudioTrack').mockReturnValue(false)
    const redial = vi.spyOn(manager, 'redialDeviceSources').mockImplementation(() => undefined)

    for (let i = 0; i < 10; i++) await manager.reconcileDeviceAudioPlane(DEVICE_ID)
    expect(redial).not.toHaveBeenCalled()
  })

  it('never re-dials on a camera that reports no microphone control', async () => {
    // `audioEnabled: null` is what a camera without the control answers.
    const getStatus = vi.fn().mockResolvedValue({ enabled: false, regions: [], audioEnabled: null })
    manager.setApiAccess({ privacyMask: { getStatus: { query: getStatus } } } as never)
    const broker = brokerMap(manager).get(makeSourceBrokerId(DEVICE_ID, 'native:main'))
    vi.spyOn(broker!, 'status', 'get').mockReturnValue('streaming')
    vi.spyOn(broker!, 'hasAudioTrack').mockReturnValue(false)
    const redial = vi.spyOn(manager, 'redialDeviceSources').mockImplementation(() => undefined)

    for (let i = 0; i < 10; i++) await manager.reconcileDeviceAudioPlane(DEVICE_ID)
    expect(redial).not.toHaveBeenCalled()
  })

  it('stops re-dialing rather than looping forever', async () => {
    const getStatus = vi.fn().mockResolvedValue({ enabled: false, regions: [], audioEnabled: true })
    manager.setApiAccess({ privacyMask: { getStatus: { query: getStatus } } } as never)
    const broker = brokerMap(manager).get(makeSourceBrokerId(DEVICE_ID, 'native:main'))
    vi.spyOn(broker!, 'status', 'get').mockReturnValue('streaming')
    vi.spyOn(broker!, 'hasAudioTrack').mockReturnValue(false)
    const redial = vi.spyOn(manager, 'redialDeviceSources').mockImplementation(() => undefined)

    // 40 ticks with the clock advanced past the cooldown each time.
    let now = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    for (let i = 0; i < 40; i++) {
      now += 6 * 60_000
      await manager.reconcileDeviceAudioPlane(DEVICE_ID)
    }
    nowSpy.mockRestore()
    expect(redial.mock.calls.length).toBeLessThanOrEqual(3)
  })
})
