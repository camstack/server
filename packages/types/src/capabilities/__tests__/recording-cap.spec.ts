import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device/device-type.js'
import {
  RECORDING_SOURCE_CAMSTACK,
  RECORDING_SOURCE_CAMSTACK_ADDON,
  RecordingAvailabilitySchema,
  RecordingManifestSchema,
  RecordingPlaybackSchema,
  RecordingSourceOptionsSchema,
  recordingCapability,
} from '../recording.cap.js'
import { RecordingStatusSchema, recordingArchiveCapability } from '../recording-archive.cap.js'
import { reservedSourceOwner } from '../reserved-collection-sources.js'

describe('recording cap', () => {
  it('is the device-scoped wrapper COLLECTION, auto-bound to cameras (D625)', () => {
    expect(recordingCapability.name).toBe('recording')
    expect(recordingCapability.scope).toBe('device')
    expect(recordingCapability.mode).toBe('collection')
    expect(recordingCapability.kind).toBe('wrapper')
    expect(recordingCapability.defaultActive).toBe(true)
    expect(recordingCapability.deviceTypes).toEqual([DeviceType.Camera])
  })

  it('carries FIVE methods and nothing about our storage', () => {
    expect(Object.keys(recordingCapability.methods).toSorted()).toEqual([
      'getAvailability',
      'getDaysWithRecordings',
      'getPlayback',
      'getPlaybackOptions',
      'listSources',
    ])
  })

  it('does not expose device settings — the config pair stayed on the archive', () => {
    // D62 / D625 §16.2: `getDeviceConfig`/`setDeviceConfig` are the recording
    // authority. An authority several providers could answer is the "two knobs
    // over one decision" D62 forbids, and the derived settings section follows
    // the methods.
    expect('exposesDeviceSettings' in recordingCapability).toBe(false)
    expect('getDeviceConfig' in recordingCapability.methods).toBe(false)
    expect('setDeviceConfig' in recordingCapability.methods).toBe(false)
    expect(recordingArchiveCapability.exposesDeviceSettings).toBe(true)
    expect(recordingArchiveCapability.methods.getDeviceConfig.auth).toBe('protected')
    expect(recordingArchiveCapability.methods.setDeviceConfig.auth).toBe('admin')
  })

  it('requires `provider` on every method but listSources', () => {
    // An un-narrowed fan-out unions two sources into one bar, which is "two
    // sources are never drawn together" broken where it matters most. Required
    // IN THE SCHEMA, so the generated types make it unomittable.
    for (const name of [
      'getAvailability',
      'getDaysWithRecordings',
      'getPlayback',
      'getPlaybackOptions',
    ] as const) {
      const parsed = recordingCapability.methods[name].input.safeParse({
        deviceId: 107,
        fromMs: 0,
        toMs: 1,
        tzOffsetMinutes: 0,
      })
      expect(parsed.success, `${name} must refuse an absent provider`).toBe(false)
    }
    expect(recordingCapability.methods.listSources.input.safeParse({ deviceId: 107 }).success).toBe(
      true,
    )
  })

  it('reserves the camstack source id for the recorder, and nobody else', () => {
    expect(RECORDING_SOURCE_CAMSTACK).toBe('camstack')
    expect(reservedSourceOwner('recording', RECORDING_SOURCE_CAMSTACK)).toBe(
      RECORDING_SOURCE_CAMSTACK_ADDON,
    )
    // Not reserved anywhere else, and no other id on this cap is reserved.
    expect(reservedSourceOwner('videoclips', RECORDING_SOURCE_CAMSTACK)).toBeNull()
    expect(reservedSourceOwner('recording', 'native:reolink:onboard')).toBeNull()
  })

  it('declares a command-driven status on the ARCHIVE with the typed schema', () => {
    expect(recordingArchiveCapability.status?.schema).toBe(RecordingStatusSchema)
    expect(recordingArchiveCapability.status?.kind).toBe('command-driven')
    expect('status' in recordingCapability).toBe(false)
  })

  it('does NOT declare getStatus in methods (it comes from the status block)', () => {
    expect('getStatus' in recordingArchiveCapability.methods).toBe(false)
  })

  it('exposes getAvailability and getPlayback as PROTECTED queries', () => {
    // F2 (46e8d303e) re-tiered these admin → protected: they are the timeline
    // and playback reads the Viewer makes for a camera the operator already
    // granted. They are now DEVICE-scoped, so the per-device mount is what
    // refuses a camera outside the caller's scope (D625 §15). The
    // deployment-wide `getStorageUsage` stays admin on the archive — asserted
    // so the two cannot drift into each other.
    expect(recordingCapability.methods.getAvailability.kind).toBe('query')
    expect(recordingCapability.methods.getAvailability.auth).toBe('protected')
    expect(recordingCapability.methods.getPlayback.kind).toBe('query')
    expect(recordingCapability.methods.getPlayback.auth).toBe('protected')
    expect(recordingArchiveCapability.methods.getStorageUsage.auth).toBe('admin')
  })

  it('getPlayback answers a union whose onboard arm names where the clip STARTS', () => {
    expect(
      RecordingPlaybackSchema.safeParse({
        kind: 'hls',
        manifest: {
          deviceId: 5,
          localMasterPath: null,
          playbackUrl: 'http://h/x.m3u8',
          playbackEndpoints: ['http://h/x.m3u8'],
        },
      }).success,
    ).toBe(true)
    expect(
      RecordingPlaybackSchema.safeParse({
        kind: 'clip',
        source: 'native:reolink:onboard',
        clipId: 'native:reolink:onboard:abc',
        startsAtMs: 1000,
      }).success,
    ).toBe(true)
    // A `seek: 'segment'` source lands the playhead at the clip head, not at
    // the instant asked for. Omitting that would leave the surface to discover
    // it from a burned-in OSD (D616).
    expect(
      RecordingPlaybackSchema.safeParse({
        kind: 'clip',
        source: 'native:hikvision:onboard',
        clipId: 'x',
      }).success,
    ).toBe(false)
    // A branch that produces no media NAMES why (D391).
    expect(RecordingPlaybackSchema.safeParse({ kind: 'none' }).success).toBe(false)
    expect(
      RecordingPlaybackSchema.safeParse({ kind: 'none', reason: 'nothing here' }).success,
    ).toBe(true)
  })

  it('declares `segment` seek — the honest name for an ask a camera ignores', () => {
    const options = {
      transport: 'realtime',
      coverage: 'sparse',
      seek: 'segment',
      stepBack: false,
      scrub: false,
      rates: [0.25, 0.5, 1],
      exclusive: true,
    }
    expect(RecordingSourceOptionsSchema.safeParse(options).success).toBe(true)
    // `exclusive` is not optional: a surface that never learns a read holds the
    // camera's only replay slot is the fifteen-minute Hikvision incident again.
    const { exclusive: _exclusive, ...withoutExclusive } = options
    expect(RecordingSourceOptionsSchema.safeParse(withoutExclusive).success).toBe(false)
  })

  it('validates status / manifest / availability schemas', () => {
    expect(
      RecordingStatusSchema.safeParse({
        deviceId: 5,
        enabled: true,
        activeMode: 'continuous',
        nodeId: 'hub',
        storageBytes: 0,
      }).success,
    ).toBe(true)
    expect(
      RecordingStatusSchema.safeParse({
        deviceId: 1,
        enabled: false,
        activeMode: 'unknown',
        nodeId: 'hub',
        storageBytes: 0,
      }).success,
    ).toBe(false)
    expect(
      RecordingManifestSchema.safeParse({
        deviceId: 5,
        localMasterPath: null,
        playbackUrl: null,
        playbackEndpoints: [],
      }).success,
    ).toBe(true)
    expect(
      RecordingManifestSchema.safeParse({
        deviceId: 5,
        localMasterPath: '/x/master.m3u8',
        playbackUrl: 'http://h/rec/t/5/master.m3u8',
        playbackEndpoints: ['http://h/rec/t/5/master.m3u8'],
      }).success,
    ).toBe(true)
    // playbackEndpoints is required (no silent omission of the candidate list).
    expect(
      RecordingManifestSchema.safeParse({ deviceId: 5, localMasterPath: null, playbackUrl: null })
        .success,
    ).toBe(false)
    expect(
      RecordingAvailabilitySchema.safeParse({
        deviceId: 1,
        read: 'read',
        ranges: [],
        profilesWithFootage: [],
      }).success,
    ).toBe(true)
    expect(
      RecordingAvailabilitySchema.safeParse({
        deviceId: 5,
        read: 'read',
        ranges: [{ profile: 'main', startMs: 1000, endMs: 2000 }],
        profilesWithFootage: ['main', 'low'],
      }).success,
    ).toBe(true)
    // D625 §10.4: `read` is REQUIRED on the singular answer. Without it a
    // rollout, an unreachable camera and a camera with no footage all spell
    // the same empty bar.
    expect(
      RecordingAvailabilitySchema.safeParse({
        deviceId: 1,
        ranges: [],
        profilesWithFootage: [],
      }).success,
      'an availability answer that does not say whether anybody looked must not validate',
    ).toBe(false)
    // D433: `ranges` answers for ONE profile on purpose, so the answer has to
    // name the others or a caller reads the preferred profile as the only one
    // that exists — the false negative that hid 14 GB of `low` footage for
    // camera 101. Optional would let a producer omit it and bring that back,
    // so the omission is REFUSED, not defaulted.
    expect(
      RecordingAvailabilitySchema.safeParse({ deviceId: 1, read: 'read', ranges: [] }).success,
      'an availability answer that names only one profile must not validate',
    ).toBe(false)
  })
})
