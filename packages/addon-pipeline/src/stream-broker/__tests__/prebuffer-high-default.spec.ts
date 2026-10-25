/**
 * `applyPrebufferConfig` — high-profile default warm.
 *
 * The HIGH-profile stream (the `high` slot in a device's profile map)
 * defaults to a warm prebuffer — kept dialed (network only, no
 * decode/GPU) with zero attached consumers — when the operator has NOT
 * set an explicit per-stream override. Every other profile
 * (mid/low/unassigned) stays strictly on-demand (off by default), and
 * battery-operated devices are NEVER default-warmed regardless of
 * profile. An explicit operator override — on or off — is always
 * honored verbatim and never overridden by this default.
 *
 * There is ONE configuration behind all of this now (D381):
 * `resolvePrebuffer` decides `{ enabled, seconds }`, `applyPrebufferConfig`
 * installs it with `broker.setPrebuffer`, and the flag and the duration can no
 * longer disagree because nothing writes them separately.
 *
 * `getPreBufferDuration()` is the public, type-safe observable this
 * suite asserts against — 0 iff not warm, the resolved seconds iff warm.
 * `hasDemand()`/`_preBufferEnabled` are private to `StreamBroker` and not
 * reachable through the public `IStreamBroker` surface `getBroker()` returns.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'
import { DEFAULT_PREBUFFER_SEC } from '../prebuffer.js'
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

/** Seed the manager with two published streams on deviceId=42 (mirrors device-contribution.spec.ts). */
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
    camStreamId: 'extra',
    kind: 'pull-rtsp',
    url: 'rtsp://cam/extra',
    label: 'Extra',
    resolution: { width: 640, height: 480 },
  })
}

describe('applyPrebufferConfig — high-profile default warm', () => {
  let manager: StreamBrokerManager

  beforeEach(() => {
    manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
  })

  it('high-profile stream with NO explicit override defaults to WARM', async () => {
    await seedTwoStreams(manager)
    // Force the assignment so 'main' is unambiguously the high slot,
    // regardless of how the auto-ranking settled during publish, then
    // restart its broker so applyPreBufferConfig re-runs against the
    // final assignment (mirrors an operator picking the profile from
    // the Assignment sub-tab, which is the real-world trigger for a
    // fresh broker to pick up a new profile's default).
    await manager.assignProfile({ deviceId: 42, profile: 'high', camStreamId: 'main' })
    await manager.restartProfile({ deviceId: 42, profile: 'high' })

    const broker = await manager.getBroker({ brokerId: '42/main' })
    expect(broker).not.toBeNull()
    // A high-profile stream with no explicit override must be kept warm by
    // default, at the SHIPPED window — the constant, never a literal, because
    // this assertion is about the default and not about a chosen number
    // (D381 halved it from 10 s to 5 s).
    expect(broker!.getPreBufferDuration()).toBe(DEFAULT_PREBUFFER_SEC)
  })

  it('non-high stream with NO explicit override stays OFF', async () => {
    await seedTwoStreams(manager)
    await manager.assignProfile({ deviceId: 42, profile: 'high', camStreamId: 'main' })
    await manager.restartProfile({ deviceId: 42, profile: 'high' })
    // 'extra' is not assigned to high.

    const broker = await manager.getBroker({ brokerId: '42/extra' })
    expect(broker).not.toBeNull()
    expect(broker!.getPreBufferDuration()).toBe(0)
  })

  it('an explicit operator OFF override is honored on the high stream (never overridden)', async () => {
    await seedTwoStreams(manager)
    await manager.assignProfile({ deviceId: 42, profile: 'high', camStreamId: 'main' })
    await manager.restartProfile({ deviceId: 42, profile: 'high' })
    await manager.applyDeviceSettingsPatch({
      deviceId: 42,
      patch: { 'preBufferEnabled:main': false },
    })

    const broker = await manager.getBroker({ brokerId: '42/main' })
    expect(broker!.getPreBufferDuration()).toBe(0)
  })

  it('an explicit operator ON override warms a NON-high stream (unchanged behavior)', async () => {
    await seedTwoStreams(manager)
    await manager.applyDeviceSettingsPatch({
      deviceId: 42,
      patch: { 'preBufferEnabled:extra': true },
    })

    const broker = await manager.getBroker({ brokerId: '42/extra' })
    expect(broker!.getPreBufferDuration()).toBeGreaterThan(0)
  })

  it('a battery-operated device is never default-warmed even on the high profile', async () => {
    await manager.publishCameraStream({
      deviceId: 43,
      camStreamId: 'main',
      kind: 'pull-rtsp',
      url: 'rtsp://cam43/main',
      label: 'Main',
      resolution: { width: 1920, height: 1080 },
      deviceFeatures: ['battery-operated'],
    })
    await manager.assignProfile({ deviceId: 43, profile: 'high', camStreamId: 'main' })
    await manager.restartProfile({ deviceId: 43, profile: 'high' })

    const broker = await manager.getBroker({ brokerId: '43/main' })
    expect(broker).not.toBeNull()
    expect(broker!.getPreBufferDuration()).toBe(0)
  })

  // ── Terminal-style (`pull-http`) sources are never default-warm ───────
  // A `pull-http` stream is an MJPEG relay normalised to H.264 by an ffmpeg
  // transcode on ingest. Default-warming it means that transcode runs
  // FOREVER: `hasDemand()` returns true on `_preBufferEnabled` alone, so the
  // warm default is permanent synthetic demand with no viewer behind it.
  // Measured on the live hub: the terminal addon's glances relay held a
  // `libx264` process at ~12% of a core and kept the relay's PTY open for
  // hours with zero viewers. It is also the cheapest source to re-dial, so
  // there is nothing to buy by keeping it hot.
  it('a pull-http (terminal relay) stream is never default-warmed even on the high profile', async () => {
    await manager.publishCameraStream({
      deviceId: 44,
      camStreamId: 'terminal',
      kind: 'pull-http',
      url: 'http://127.0.0.1:8099/glances.mjpeg',
      label: 'Terminal',
      resolution: { width: 1280, height: 720 },
    })
    await manager.assignProfile({ deviceId: 44, profile: 'high', camStreamId: 'terminal' })
    await manager.restartProfile({ deviceId: 44, profile: 'high' })

    const broker = await manager.getBroker({ brokerId: '44/terminal' })
    expect(broker).not.toBeNull()
    expect(broker!.getPreBufferDuration()).toBe(0)
  })

  it('an explicit operator ON override still warms a pull-http stream (the default is not a ban)', async () => {
    await manager.publishCameraStream({
      deviceId: 45,
      camStreamId: 'terminal',
      kind: 'pull-http',
      url: 'http://127.0.0.1:8099/glances.mjpeg',
      label: 'Terminal',
      resolution: { width: 1280, height: 720 },
    })
    await manager.applyDeviceSettingsPatch({
      deviceId: 45,
      patch: { 'preBufferEnabled:terminal': true },
    })

    const broker = await manager.getBroker({ brokerId: '45/terminal' })
    expect(broker!.getPreBufferDuration()).toBeGreaterThan(0)
  })

  // ── Reassignment path (the normal-boot ordering case) ────────────────
  // On a real multi-stream boot, provider addons publish streams one at a
  // time. The first stream's broker is created while auto-assignment still
  // ranks it `mid` (single-stream transient), so applyPreBufferConfig sees
  // "not high" at creation. When the stream LATER becomes `high` (2nd stream
  // published, or an operator assigns it), applyAssignmentUpdate must
  // re-apply the prebuffer default to the SAME already-existing broker so it
  // warms up without a manual restart.
  it('a stream that BECOMES high after its broker exists warms up (no restart)', async () => {
    // Publish a single stream: auto-assignment ranks it `mid`, broker created
    // OFF. (No restartProfile — this is exactly the boot-ordering case.)
    await manager.publishCameraStream({
      deviceId: 42,
      camStreamId: 'main',
      kind: 'pull-rtsp',
      url: 'rtsp://cam/main',
      label: 'Main',
      resolution: { width: 1920, height: 1080 },
    })
    const brokerBefore = await manager.getBroker({ brokerId: '42/main' })
    expect(brokerBefore).not.toBeNull()
    expect(brokerBefore!.getPreBufferDuration()).toBe(0)

    // Now assign it to `high` — the same broker instance must be re-warmed.
    await manager.assignProfile({ deviceId: 42, profile: 'high', camStreamId: 'main' })

    const brokerAfter = await manager.getBroker({ brokerId: '42/main' })
    expect(brokerAfter).not.toBeNull()
    // Same live instance, no recreate.
    expect(brokerAfter).toBe(brokerBefore)
    expect(brokerAfter!.getPreBufferDuration()).toBe(DEFAULT_PREBUFFER_SEC)
  })

  it('a stream that STOPS being high reverts to on-demand default (no explicit override)', async () => {
    await seedTwoStreams(manager)
    // Make 'main' high (and warm) without recreating its broker via the
    // reassignment path under test.
    await manager.assignProfile({ deviceId: 42, profile: 'high', camStreamId: 'main' })
    const mainBroker = await manager.getBroker({ brokerId: '42/main' })
    expect(mainBroker!.getPreBufferDuration()).toBe(DEFAULT_PREBUFFER_SEC)

    // Reassign high to 'extra'. 'main' is no longer high → reverts to OFF,
    // 'extra' becomes high → warms up. Both are the same live instances.
    await manager.assignProfile({ deviceId: 42, profile: 'high', camStreamId: 'extra' })

    const mainAfter = await manager.getBroker({ brokerId: '42/main' })
    const extraAfter = await manager.getBroker({ brokerId: '42/extra' })
    expect(mainAfter).toBe(mainBroker)
    expect(mainAfter!.getPreBufferDuration()).toBe(0)
    expect(extraAfter!.getPreBufferDuration()).toBe(DEFAULT_PREBUFFER_SEC)
  })

  it('reassignment NEVER overrides an explicit operator OFF on the stream becoming high', async () => {
    await seedTwoStreams(manager)
    // Operator explicitly turns pre-buffer OFF on 'main' while it is not high.
    await manager.applyDeviceSettingsPatch({
      deviceId: 42,
      patch: { 'preBufferEnabled:main': false },
    })
    // Then 'main' becomes high — the explicit OFF must still win.
    await manager.assignProfile({ deviceId: 42, profile: 'high', camStreamId: 'main' })

    const broker = await manager.getBroker({ brokerId: '42/main' })
    expect(broker!.getPreBufferDuration()).toBe(0)
  })

  // ── Seconds-only patch must not silently disable the warm default ────
  // A `preBufferSec:<id>`-only patch (no switch key) has to start from the
  // value the operator is LOOKING at, which is `effectivePrebuffer` — the same
  // resolution the screen displays and the broker installs. Starting from a
  // fresh `{ enabled: false }` instead would persist `{enabled:false,
  // seconds:N}` and silently force the high stream OFF on the next broker
  // recreation, defeating the warm default.
  it('a seconds-only patch on a high stream keeps it WARM across broker recreation', async () => {
    await seedTwoStreams(manager)
    await manager.assignProfile({ deviceId: 42, profile: 'high', camStreamId: 'main' })
    // Seconds-only patch — NO preBufferEnabled key.
    await manager.applyDeviceSettingsPatch({
      deviceId: 42,
      patch: { 'preBufferSec:main': 15 },
    })
    // Force a broker recreation so the (now explicit) override drives config.
    await manager.restartProfile({ deviceId: 42, profile: 'high' })

    const broker = await manager.getBroker({ brokerId: '42/main' })
    expect(broker).not.toBeNull()
    // Still warm — at the patched duration, not forced OFF.
    expect(broker!.getPreBufferDuration()).toBe(15)
  })

  it('a seconds-only patch on a NON-high stream keeps it OFF (unchanged)', async () => {
    await seedTwoStreams(manager)
    await manager.assignProfile({ deviceId: 42, profile: 'high', camStreamId: 'main' })
    // 'extra' is not high — a seconds-only patch must not warm it.
    await manager.applyDeviceSettingsPatch({
      deviceId: 42,
      patch: { 'preBufferSec:extra': 15 },
    })
    await manager.restartProfile({ deviceId: 42, profile: 'high' })

    const broker = await manager.getBroker({ brokerId: '42/extra' })
    expect(broker).not.toBeNull()
    expect(broker!.getPreBufferDuration()).toBe(0)
  })
})
