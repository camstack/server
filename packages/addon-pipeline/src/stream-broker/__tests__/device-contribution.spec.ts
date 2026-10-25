/**
 * Device-settings contribution under the cam-stream-keyed broker model.
 *
 *   - `getDeviceSettingsContribution` returns one section that hosts a
 *     `sub-tabs` field: an "Assignment" sub-tab (3 selectors —
 *     high/mid/low) plus one sub-tab per published cam stream with the
 *     stream's RTSP / pre-buffer controls.
 *   - `applyDeviceSettingsPatch` routes `streamProfile:<profile>` to
 *     `assignProfile`/`unassignProfile`, `rtspEnabled:<camStreamId>` to
 *     the RTSP provider via `${deviceId}/${camStreamId}` brokerId, and
 *     per-stream pre-buffer keys into the override store + live broker.
 *   - Every published cam stream owns a broker for its lifetime — the
 *     manager no longer exposes manual activate/deactivate semantics.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'
import { DEFAULT_PREBUFFER_SEC } from '../prebuffer.js'
import type { ConfigSubTabsFieldWithValue, IScopedLogger } from '@camstack/types'

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

function stubRtsp(manager: StreamBrokerManager): { setEnabled: ReturnType<typeof vi.fn> } {
  const setEnabled = vi.fn()
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
    setEnabled,
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
  return { setEnabled }
}

/** Seed the manager with two published streams on deviceId=42. */
async function seedTwoStreams(manager: StreamBrokerManager): Promise<void> {
  await manager.publishCameraStream({
    deviceId: 42,
    camStreamId: 'main',
    kind: 'pull-rtsp',
    url: 'rtsp://cam/main',
    label: 'Main',
    resolution: { width: 1920, height: 1080 },
  })
  await manager.publishCameraStream({
    deviceId: 42,
    camStreamId: 'sub',
    kind: 'pull-rtsp',
    url: 'rtsp://cam/sub',
    label: 'Sub',
    resolution: { width: 640, height: 480 },
  })
}

/**
 * What one stream's sub-tab SHOWS for the prebuffer.
 *
 * `unknown` because a hydrated field's `value` is `unknown` — the assertions
 * below state the expected type by comparing against it, rather than a cast
 * asserting it.
 */
interface DisplayedPrebuffer {
  readonly enabled: unknown
  readonly seconds: unknown
}

/**
 * Read the two prebuffer controls off the device settings contribution.
 *
 * This is the only observable of the effective prebuffer from outside the
 * manager, and that is the point (D381): what the screen displays and what the
 * broker installs are resolved by the ONE function, so a test that reads the
 * screen is testing the value the camera actually runs with.
 */
async function displayedPrebuffer(
  manager: StreamBrokerManager,
  deviceId: number,
  camStreamId: string,
): Promise<DisplayedPrebuffer> {
  const contribution = await manager.getDeviceSettingsContribution({ deviceId })
  if (contribution === null) throw new Error(`no contribution for device ${deviceId}`)
  const tab = getSubTabsField(contribution).tabs.find((t) => t.id === `stream:${camStreamId}`)
  if (!tab) throw new Error(`no sub-tab for stream ${camStreamId}`)
  const enabled = tab.fields.find((f) => 'key' in f && f.key === `preBufferEnabled:${camStreamId}`)
  const seconds = tab.fields.find((f) => 'key' in f && f.key === `preBufferSec:${camStreamId}`)
  if (!enabled || !('value' in enabled)) throw new Error('preBufferEnabled field missing')
  if (!seconds || !('value' in seconds)) throw new Error('preBufferSec field missing')
  return { enabled: enabled.value, seconds: seconds.value }
}

function getSubTabsField(
  contribution: import('@camstack/types').ConfigUISchemaWithValues,
): ConfigSubTabsFieldWithValue {
  const section = contribution.sections.find((s) => s.id === 'stream-broker-streams')
  if (!section) throw new Error('section "stream-broker-streams" missing')
  const field = section.fields.find((f) => f.type === 'sub-tabs')
  if (!field || field.type !== 'sub-tabs') throw new Error('sub-tabs field missing')
  return field
}

describe('StreamBrokerManager — device-settings contribution (cam-stream-keyed model)', () => {
  let manager: StreamBrokerManager

  beforeEach(() => {
    manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
  })

  it('returns null for an unknown device (no cam streams published)', async () => {
    const contribution = await manager.getDeviceSettingsContribution({ deviceId: 999 })
    expect(contribution).toBeNull()
  })

  it('returns one section with a sub-tabs field: Assignment + one sub-tab per stream', async () => {
    await seedTwoStreams(manager)
    const contribution = await manager.getDeviceSettingsContribution({ deviceId: 42 })
    expect(contribution).not.toBeNull()
    const sectionIds = contribution!.sections.map((s) => s.id)
    expect(sectionIds).toEqual(['stream-broker-streams', 'stream-broker-diagnostics'])

    const subTabs = getSubTabsField(contribution!)
    const tabIds = subTabs.tabs.map((t) => t.id)
    expect(tabIds[0]).toBe('general')
    expect(tabIds).toContain('stream:main')
    expect(tabIds).toContain('stream:sub')
  })

  it('both sections are hoisted to the "stream-broker" top-tab (out of Config)', async () => {
    // The stream-broker settings live in their own device-detail
    // top-level tab, not nested under Config — every section carries
    // `location: 'top-tab'` + `tab: 'stream-broker'` so DeviceDetail
    // discovers the tab and DeviceAggregateSection drops it from the
    // default Config view. Mirrors recording-playback / zones / ptz.
    await seedTwoStreams(manager)
    const contribution = await manager.getDeviceSettingsContribution({ deviceId: 42 })
    for (const section of contribution!.sections) {
      expect(section.tab).toBe('stream-broker')
      expect(section.location).toBe('top-tab')
    }
  })

  it('General sub-tab carries one streamProfile:* selector per profile, populated from published streams', async () => {
    await seedTwoStreams(manager)
    const contribution = await manager.getDeviceSettingsContribution({ deviceId: 42 })
    const subTabs = getSubTabsField(contribution!)
    const assignment = subTabs.tabs.find((t) => t.id === 'general')!
    const keys = assignment.fields.map((f) => ('key' in f ? f.key : ''))
    expect(keys).toEqual([
      'streamProfile:high',
      'streamProfile:mid',
      'streamProfile:low',
      'derivedStreamNames',
    ])
    const highSel = assignment.fields[0]
    if (!highSel || !('options' in highSel)) throw new Error('expected select with options')
    expect(highSel.options.map((o) => o.value)).toEqual(['', 'main', 'sub'])
  })

  it('per-stream sub-tabs expose RTSP + pre-buffer controls (broker always active)', async () => {
    await seedTwoStreams(manager)
    const contribution = await manager.getDeviceSettingsContribution({ deviceId: 42 })
    const subTabs = getSubTabsField(contribution!)
    const mainTab = subTabs.tabs.find((t) => t.id === 'stream:main')!
    const keys = mainTab.fields.map((f) => ('key' in f ? f.key : ''))
    // No Active toggle, no per-stream Profile selector — the Assignment
    // sub-tab is the sole control for profile bindings, and every
    // published stream owns its broker unconditionally.
    expect(keys).not.toContain('streamActive:main')
    expect(keys).not.toContain('streamProfileFor:main')
    expect(keys).toContain('rtspEnabled:main')
    // THE prebuffer, and only it (D381): the per-stream `preRollMs:<id>` knob
    // that sized a second, invisible window is gone from the screen with the
    // window it configured.
    expect(keys).toContain('preBufferEnabled:main')
    expect(keys).toContain('preBufferSec:main')
    expect(keys).not.toContain('preRollMs:main')

    // …and what the two controls DISPLAY is the EFFECTIVE prebuffer, not the
    // stored override. 'main' auto-ranks `high`, which is warm by default, so
    // the switch reads ON at the shipped window. It used to display
    // `override?.enabled ?? false` — OFF on a camera the broker was holding
    // dialed, which is the switch-that-lies D62 forbids.
    const shown = await displayedPrebuffer(manager, 42, 'main')
    expect(shown.enabled).toBe(true)
    expect(shown.seconds).toBe(DEFAULT_PREBUFFER_SEC)
  })

  it('non-profile-bound stream sub-tab still exposes the same controls (no Active toggle)', async () => {
    // Publish 4 streams. Auto-assignment fills the top-3 by resolution;
    // 'extra' stays unbound but its sub-tab still surfaces RTSP +
    // pre-buffer controls — no manual activation gate exists anymore.
    await manager.publishCameraStream({
      deviceId: 42,
      camStreamId: 'main',
      kind: 'pull-rtsp',
      url: 'rtsp://cam/main',
      label: 'Main',
      resolution: { width: 1920, height: 1080 },
    })
    await manager.publishCameraStream({
      deviceId: 42,
      camStreamId: 'sub',
      kind: 'pull-rtsp',
      url: 'rtsp://cam/sub',
      label: 'Sub',
      resolution: { width: 1280, height: 720 },
    })
    await manager.publishCameraStream({
      deviceId: 42,
      camStreamId: 'lowres',
      kind: 'pull-rtsp',
      url: 'rtsp://cam/lowres',
      resolution: { width: 640, height: 480 },
    })
    await manager.publishCameraStream({
      deviceId: 42,
      camStreamId: 'extra',
      kind: 'pull-rtsp',
      url: 'rtsp://cam/extra',
      resolution: { width: 320, height: 240 },
    })
    const contribution = await manager.getDeviceSettingsContribution({ deviceId: 42 })
    const subTabs = getSubTabsField(contribution!)
    const extraTab = subTabs.tabs.find((t) => t.id === 'stream:extra')!
    const keys = extraTab.fields.map((f) => ('key' in f ? f.key : ''))
    expect(keys).not.toContain('streamActive:extra')
    expect(keys).not.toContain('streamProfileFor:extra')
    expect(keys).toContain('rtspEnabled:extra')
    expect(keys).toContain('preBufferEnabled:extra')
  })

  it('applyDeviceSettingsPatch routes rtspEnabled:<camStreamId> to the RTSP provider', async () => {
    await seedTwoStreams(manager)
    const rtsp = (manager as unknown as { rtspProvider: { setEnabled: ReturnType<typeof vi.fn> } })
      .rtspProvider

    await manager.applyDeviceSettingsPatch({
      deviceId: 42,
      patch: { 'rtspEnabled:main': false, 'rtspEnabled:sub': true },
    })

    expect(rtsp.setEnabled).toHaveBeenCalledWith('42/main', false)
    expect(rtsp.setEnabled).toHaveBeenCalledWith('42/sub', true)
  })

  it('applyDeviceSettingsPatch with streamProfile:* reassigns and locks out auto-reassign', async () => {
    await seedTwoStreams(manager)
    await manager.applyDeviceSettingsPatch({
      deviceId: 42,
      patch: { 'streamProfile:high': 'sub', 'streamProfile:low': 'main' },
    })
    const slots = manager.getProfileSlotsForDevice(42)
    expect(slots.find((s) => s.profile === 'high')!.sourceCamStreamId).toBe('sub')
    expect(slots.find((s) => s.profile === 'low')!.sourceCamStreamId).toBe('main')

    await manager.publishCameraStream({
      deviceId: 42,
      camStreamId: 'ultra',
      kind: 'pull-rtsp',
      url: 'rtsp://cam/ultra',
      resolution: { width: 3840, height: 2160 },
    })
    const after = manager.getProfileSlotsForDevice(42)
    expect(after.find((s) => s.profile === 'high')!.sourceCamStreamId).toBe('sub')
  })

  // (Per-stream `streamProfileFor:` selector was dropped — Assignment
  //  sub-tab is the sole control for profile bindings.)

  it('every published cam stream owns a live broker (no manual activation gate)', async () => {
    // Publish 4 streams. Auto-assignment fills the 3 profile slots with
    // the top-3 by resolution; the 4th ('extra') is unbound but its
    // broker is alive nonetheless — broker lifecycle is 1:1 with
    // publishCameraStream / retractCameraStream.
    await manager.publishCameraStream({
      deviceId: 42,
      camStreamId: 'a',
      kind: 'pull-rtsp',
      url: 'rtsp://cam/a',
      resolution: { width: 1920, height: 1080 },
    })
    await manager.publishCameraStream({
      deviceId: 42,
      camStreamId: 'b',
      kind: 'pull-rtsp',
      url: 'rtsp://cam/b',
      resolution: { width: 1280, height: 720 },
    })
    await manager.publishCameraStream({
      deviceId: 42,
      camStreamId: 'c',
      kind: 'pull-rtsp',
      url: 'rtsp://cam/c',
      resolution: { width: 640, height: 480 },
    })
    await manager.publishCameraStream({
      deviceId: 42,
      camStreamId: 'extra',
      kind: 'pull-rtsp',
      url: 'rtsp://cam/extra',
      resolution: { width: 320, height: 240 },
    })

    expect(await manager.getBroker({ brokerId: '42/a' })).not.toBeNull()
    expect(await manager.getBroker({ brokerId: '42/b' })).not.toBeNull()
    expect(await manager.getBroker({ brokerId: '42/c' })).not.toBeNull()
    expect(await manager.getBroker({ brokerId: '42/extra' })).not.toBeNull()

    await manager.retractCameraStream({ deviceId: 42, camStreamId: 'extra' })
    expect(await manager.getBroker({ brokerId: '42/extra' })).toBeNull()
  })

  it('per-stream preBuffer writes the override, fires the persister, and is DISPLAYED', async () => {
    await seedTwoStreams(manager)
    const persister = vi.fn()
    manager.setDeviceOverridePersister(persister)
    // A cluster default distinct from every per-stream number below, so an
    // assertion can never pass by inheriting it.
    manager.setDefaultPreBufferSec(10)

    // Non-high streams are OFF by default, and a seconds-only patch does not
    // turn one on: the switch is the operator's opt-in. ('sub' is the low
    // profile here; 'main' auto-ranks high and warms by default, so this
    // default-off semantic is asserted on the non-high stream.)
    await manager.applyDeviceSettingsPatch({
      deviceId: 42,
      patch: { 'preBufferSec:sub': 15 },
    })
    expect((await displayedPrebuffer(manager, 42, 'sub')).enabled).toBe(false)
    // The broker installs what the screen shows — one resolution, no second
    // opinion: nothing is retained while the switch reads off.
    expect((await manager.getBroker({ brokerId: '42/sub' }))!.getPreBufferDuration()).toBe(0)
    expect(persister).toHaveBeenCalledTimes(1)

    // Turning the switch ON adopts the seconds the operator had already typed
    // — never the cluster default, and never `seconds: 0`, which would be a
    // prebuffer reporting itself on while retaining nothing.
    await manager.applyDeviceSettingsPatch({
      deviceId: 42,
      patch: { 'preBufferEnabled:sub': true },
    })
    const on = await displayedPrebuffer(manager, 42, 'sub')
    expect(on.enabled).toBe(true)
    expect(on.seconds).toBe(15)
    expect((await manager.getBroker({ brokerId: '42/sub' }))!.getPreBufferDuration()).toBe(15)
    expect(persister).toHaveBeenCalledTimes(2)

    await manager.applyDeviceSettingsPatch({
      deviceId: 42,
      patch: { 'preBufferEnabled:sub': false },
    })
    expect((await displayedPrebuffer(manager, 42, 'sub')).enabled).toBe(false)
    expect((await manager.getBroker({ brokerId: '42/sub' }))!.getPreBufferDuration()).toBe(0)
    expect(persister).toHaveBeenCalledTimes(3)
  })

  it('loadPersistedDeviceOverrides seeds per-stream overrides at boot', async () => {
    manager.setDefaultPreBufferSec(10)
    // Loaded BEFORE the streams are published, which is the boot order: the
    // override has to reach the broker at creation, not one restart later.
    manager.loadPersistedDeviceOverrides(
      new Map([[42, { preBuffer: { main: { enabled: true, seconds: 7 } } }]]),
    )
    await seedTwoStreams(manager)

    // The persisted override beats the cluster default AND the warm default —
    // an explicit operator answer is never re-guessed.
    const shown = await displayedPrebuffer(manager, 42, 'main')
    expect(shown.enabled).toBe(true)
    expect(shown.seconds).toBe(7)
    expect((await manager.getBroker({ brokerId: '42/main' }))!.getPreBufferDuration()).toBe(7)

    // A stream nobody configured inherits the cluster seconds — 10 here, not
    // the shipped 5 — whenever the profile default warms it at all.
    const sub = await displayedPrebuffer(manager, 42, 'sub')
    expect(sub.enabled).toBe(false)
    expect((await manager.getBroker({ brokerId: '42/sub' }))!.getPreBufferDuration()).toBe(0)
  })

  it('returns null live contribution (absorbed into settings)', async () => {
    await seedTwoStreams(manager)
    expect(await manager.getDeviceLiveContribution({ deviceId: 42 })).toBeNull()
  })

  // ── Advanced WebRTC debug logging toggle (Diagnostics section) ──────
  it('exposes a webrtcDebug boolean in the Diagnostics section, default false', async () => {
    await seedTwoStreams(manager)
    const contribution = await manager.getDeviceSettingsContribution({ deviceId: 42 })
    const diag = contribution!.sections.find((s) => s.id === 'stream-broker-diagnostics')
    if (!diag) throw new Error('diagnostics section missing')
    const field = diag.fields.find((f) => 'key' in f && f.key === 'webrtcDebug')
    if (!field || field.type !== 'boolean') throw new Error('webrtcDebug boolean field missing')
    expect(field.label).toBe('Advanced WebRTC debug logging')
    expect(field.value).toBe(false)
  })

  it('getDeviceSettingsContribution reflects a persisted webrtcDebug=true', async () => {
    await seedTwoStreams(manager)
    manager.loadPersistedDeviceOverrides(new Map([[42, { webrtcDebug: true }]]))
    const contribution = await manager.getDeviceSettingsContribution({ deviceId: 42 })
    const diag = contribution!.sections.find((s) => s.id === 'stream-broker-diagnostics')!
    const field = diag.fields.find((f) => 'key' in f && f.key === 'webrtcDebug')
    if (!field || field.type !== 'boolean') throw new Error('webrtcDebug boolean field missing')
    expect(field.value).toBe(true)
  })

  it('applyDeviceSettingsPatch persists webrtcDebug and isWebrtcDebug reflects it', async () => {
    await seedTwoStreams(manager)
    const persister = vi.fn()
    manager.setDeviceOverridePersister(persister)

    expect(manager.isWebrtcDebug(42)).toBe(false)

    await manager.applyDeviceSettingsPatch({ deviceId: 42, patch: { webrtcDebug: true } })
    expect(manager.isWebrtcDebug(42)).toBe(true)
    expect(persister).toHaveBeenCalledTimes(1)

    // Round-trip through the contribution.
    const contribution = await manager.getDeviceSettingsContribution({ deviceId: 42 })
    const diag = contribution!.sections.find((s) => s.id === 'stream-broker-diagnostics')!
    const field = diag.fields.find((f) => 'key' in f && f.key === 'webrtcDebug')
    if (!field || field.type !== 'boolean') throw new Error('webrtcDebug boolean field missing')
    expect(field.value).toBe(true)

    // Turning it back off clears the override.
    await manager.applyDeviceSettingsPatch({ deviceId: 42, patch: { webrtcDebug: false } })
    expect(manager.isWebrtcDebug(42)).toBe(false)
  })

  it('webrtcDebug is independent of streamingDebug', async () => {
    await seedTwoStreams(manager)
    await manager.applyDeviceSettingsPatch({ deviceId: 42, patch: { webrtcDebug: true } })
    expect(manager.isWebrtcDebug(42)).toBe(true)
    expect(manager.isStreamingDebug(42)).toBe(false)
  })
})
