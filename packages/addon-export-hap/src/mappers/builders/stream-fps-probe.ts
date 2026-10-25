/**
 * The impure half of R2: fetch the three inputs `stream-fps.ts` derives the
 * advertised frame rates from, and say — at `info`, tagged with the deviceId —
 * exactly what we ended up advertising and where each number came from.
 *
 * Runs once per accessory build. HAP freezes
 * `SupportedVideoStreamConfiguration` when the `CameraController` is
 * constructed, so this is the only moment the advertisement can be set; a
 * later reassignment of a profile slot reaches HomeKit through the existing
 * reconcile → rebuild path, not from here.
 *
 * Every failure mode is logged rather than swallowed. A probe that quietly
 * returns "assumed 30" for a camera whose Mid slot runs at 10 fps is precisely
 * the state this work exists to end.
 */
import type {
  CameraStream,
  ProfileRtspEntry,
  ProfileSlot,
  WebrtcStreamChoice,
} from '@camstack/types'

import type { BuilderContext } from '../types.js'
import {
  CANDIDATE_RESOLUTIONS,
  deriveAdvertisedResolutions,
  formatAdvertisedResolutions,
  resolveProfileFps,
  type AdvertisedResolution,
  type ProfileFpsMap,
} from './stream-fps.js'
import { sensorForStreams, type SensorProfile } from '../../multi-tier/native-codec.js'
import { TierVideoCodec } from '../../multi-tier/video-stream-tiers.js'

export interface AdvertisedVideoProfile {
  readonly resolutions: readonly AdvertisedResolution[]
  /** Per-profile rate + provenance, so the START path can report both. */
  readonly fpsByProfile: ProfileFpsMap
  /**
   * The sensor the NEW camera service describes: native size and codec.
   *
   * Deliberately NOT read off `resolutions` above. That list is the classic
   * service's, capped at 1080p because that is the ceiling the classic service
   * accepts — and the new service exists to carry the 4K the cap hides.
   *
   * Derived here because `getCameraStreams` is already in hand; asking again
   * from the accessory would be a second round trip for a fact this probe has.
   */
  readonly sensor: SensorProfile
}

export async function probeAdvertisedVideoProfile(
  bctx: BuilderContext,
): Promise<AdvertisedVideoProfile> {
  const { ctx, proxy, numericDeviceId, options } = bctx
  const log = ctx.logger.withTags({ deviceId: numericDeviceId })

  const entries = await probe<readonly ProfileRtspEntry[]>(
    () => proxy.cameraStreams?.getProfileRtspEntries({}),
    'cameraStreams.getProfileRtspEntries',
    log,
  )
  const slots = await probe<readonly ProfileSlot[]>(
    () => proxy.cameraStreams?.getBrokerStreams({}),
    'cameraStreams.getBrokerStreams',
    log,
  )
  const camStreams = await probe<readonly CameraStream[]>(
    () => proxy.cameraStreams?.getCameraStreams({}),
    'cameraStreams.getCameraStreams',
    log,
  )
  const choices = await probe<readonly WebrtcStreamChoice[]>(
    () => proxy.webrtcSession?.listStreams({}),
    'webrtcSession.listStreams',
    log,
  )

  const fpsByProfile = resolveProfileFps({
    choices: choices ?? [],
    slots: slots ?? [],
    camStreams: camStreams ?? [],
  })
  const sensor = sensorForStreams(camStreams ?? [])
  const resolutions = deriveAdvertisedResolutions({
    candidates: CANDIDATE_RESOLUTIONS,
    entries: entries ?? [],
    deviceId: numericDeviceId,
    pref: options.hapDeviceSettings.streamPreference,
    fpsByProfile,
  })

  const assumed = resolutions.filter((r) => r.source === 'assumed').length
  log.info('export-hap: advertised video profile derived', {
    meta: {
      streamPreference: options.hapDeviceSettings.streamPreference,
      resolutions: formatAdvertisedResolutions(resolutions),
      sensor: `${sensor.width}x${sensor.height} ${sensor.codec === TierVideoCodec.H265 ? 'h265' : 'h264'}`,
      profileFps: [...fpsByProfile.values()].map((f) => `${f.profile}=${f.fps}(${f.source})`),
      assumedCount: assumed,
      // The number that used to be advertised unconditionally. Kept in the
      // line so a reader can see at a glance whether R2 changed anything for
      // this camera.
      previouslyAdvertisedFps: 30,
    },
  })
  if (assumed === resolutions.length) {
    log.warn(
      'export-hap: no measured or published frame rate for ANY profile — advertising the assumed rate',
      { meta: { entries: entries?.length ?? 0, choices: choices?.length ?? 0 } },
    )
  }

  return { resolutions, fpsByProfile, sensor }
}

/**
 * Run one cap read. Returns null both when the cap is not bound and when the
 * call throws — and LOGS which, because "the camera has no telemetry" and "the
 * telemetry call failed" lead to different fixes.
 */
export async function probe<T>(
  call: () => Promise<T> | undefined,
  label: string,
  log: BuilderContext['ctx']['logger'],
): Promise<T | null> {
  try {
    const pending = call()
    if (pending === undefined) {
      log.info('export-hap: fps probe skipped — cap not bound on this device', {
        meta: { call: label },
      })
      return null
    }
    return await pending
  } catch (err) {
    log.warn('export-hap: fps probe failed — falling back to a lower-authority source', {
      meta: { call: label, error: err instanceof Error ? err.message : String(err) },
    })
    return null
  }
}
