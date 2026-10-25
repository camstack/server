/**
 * applyDeviceSettingsPatch → derived-stream materialization reconcile.
 *
 * Regression for the "derived streams never appear in the profile-assignment
 * picker or the player stream selector" bug: the per-field patch handlers
 * persisted the derived source/encode but never materialized the live
 * `derived:*` broker + camStream. A derived only became visible after a hub
 * restart (boot reconcile). These tests drive the same patch sequence the
 * admin UI emits and assert the derived materializes the moment it has a
 * source — so `getCameraStreamsForDevice` (which drives BOTH surfaces)
 * surfaces it immediately.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'
import type { IScopedLogger } from '@camstack/types'

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

const DEVICE = 108

async function publishSource(manager: StreamBrokerManager, camStreamId: string): Promise<void> {
  await manager.publishCameraStream({
    deviceId: DEVICE,
    camStreamId,
    kind: 'pull-rtsp',
    url: `rtsp://example/${camStreamId}`,
  })
}

function derivedIds(manager: StreamBrokerManager): string[] {
  return manager
    .getCameraStreamsForDevice(DEVICE)
    .map((s) => s.camStreamId)
    .filter((id) => id.startsWith('derived:'))
}

describe('applyDeviceSettingsPatch derived materialization', () => {
  let manager: StreamBrokerManager

  beforeEach(async () => {
    manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
    await publishSource(manager, 'native:main')
  })

  it('does NOT materialize a derived with no source yet (placeholder)', async () => {
    await manager.applyDeviceSettingsPatch({
      deviceId: DEVICE,
      patch: { derivedStreamNames: ['sub-cropped'] },
    })
    expect(derivedIds(manager)).toEqual([])
  })

  it('materializes a derived the moment a PROFILE source is set', async () => {
    await manager.applyDeviceSettingsPatch({
      deviceId: DEVICE,
      patch: { derivedStreamNames: ['sub-cropped'] },
    })
    // The admin UI's grouped source selector emits an encoded profile ref.
    await manager.applyDeviceSettingsPatch({
      deviceId: DEVICE,
      patch: { 'derivedSource:sub-cropped': 'profile:mid' },
    })
    expect(derivedIds(manager)).toContain('derived:sub-cropped')
  })

  it('materializes a derived pinned to an already-published camStream source', async () => {
    await manager.applyDeviceSettingsPatch({
      deviceId: DEVICE,
      patch: {
        derivedStreamNames: ['pinned'],
        'derivedSource:pinned': 'stream:native:main',
      },
    })
    expect(derivedIds(manager)).toContain('derived:pinned')
  })

  it('defers a derived pinned to an unpublished source, then drains it when it lands', async () => {
    await manager.applyDeviceSettingsPatch({
      deviceId: DEVICE,
      patch: {
        derivedStreamNames: ['pinned'],
        'derivedSource:pinned': 'stream:native:sub',
      },
    })
    // Source broker not up yet → not materialized.
    expect(derivedIds(manager)).not.toContain('derived:pinned')
    // Publishing the source drains the pending derived.
    await publishSource(manager, 'native:sub')
    expect(derivedIds(manager)).toContain('derived:pinned')
  })

  it('retracts a derived when its name is removed from the list', async () => {
    await manager.applyDeviceSettingsPatch({
      deviceId: DEVICE,
      patch: {
        derivedStreamNames: ['sub-cropped'],
        'derivedSource:sub-cropped': 'profile:mid',
      },
    })
    expect(derivedIds(manager)).toContain('derived:sub-cropped')
    await manager.applyDeviceSettingsPatch({
      deviceId: DEVICE,
      patch: { derivedStreamNames: [] },
    })
    expect(derivedIds(manager)).not.toContain('derived:sub-cropped')
  })

  it('keeps a single entry when the source changes on a live derived', async () => {
    await manager.applyDeviceSettingsPatch({
      deviceId: DEVICE,
      patch: {
        derivedStreamNames: ['sub-cropped'],
        'derivedSource:sub-cropped': 'profile:mid',
      },
    })
    await manager.applyDeviceSettingsPatch({
      deviceId: DEVICE,
      patch: { 'derivedSource:sub-cropped': 'profile:high' },
    })
    expect(derivedIds(manager).filter((id) => id === 'derived:sub-cropped')).toHaveLength(1)
  })

  it('PRESERVES the derived profile assignment across a source change (no profile reset)', async () => {
    // 618 live bug: editing a derived's source retracts+republishes it, and the
    // retract cleared the assigned profile slot — the operator saw a "profile
    // reset". reconcileDerivedStreams must save+restore the slot.
    await manager.applyDeviceSettingsPatch({
      deviceId: DEVICE,
      patch: {
        derivedStreamNames: ['sub-cropped'],
        'derivedSource:sub-cropped': 'profile:mid',
      },
    })
    await manager.assignProfile({
      deviceId: DEVICE,
      profile: 'low',
      camStreamId: 'derived:sub-cropped',
    })
    const before = manager.getProfileSlotsForDevice(DEVICE).find((s) => s.profile === 'low')
    expect(before?.sourceCamStreamId).toBe('derived:sub-cropped')

    // Change the derived's source — the retract+republish path.
    await manager.applyDeviceSettingsPatch({
      deviceId: DEVICE,
      patch: { 'derivedSource:sub-cropped': 'profile:high' },
    })

    const after = manager.getProfileSlotsForDevice(DEVICE).find((s) => s.profile === 'low')
    expect(after?.sourceCamStreamId).toBe('derived:sub-cropped')
  })
})
