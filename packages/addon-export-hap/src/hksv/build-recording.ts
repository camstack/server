/**
 * Assemble HomeKit Secure Video for one camera — the ADVERTISEMENT and the
 * DELEGATE, together, or neither.
 *
 * That pairing is the whole rule and it is why nothing shipped for HKSV before
 * this: `recording` is optional on `CameraControllerOptions`, and passing it IS
 * the entire user-visible change. There is no "phase 1 behind a flag" for an
 * advertisement — either iOS is offered a recording toggle backed by a delegate
 * that yields real fragments, or the services are not on the accessory at all
 * ([D50](../../../../docs/decisions/adr-0050.md)).
 *
 * So this returns `null` for every reason a camera cannot record, and each of
 * them is logged at `info`/`warn` with `tags: { deviceId }`. A withdrawn
 * capability that says nothing is indistinguishable from a bug — and on this
 * surface the operator's first question is always "why does 102 have it and 101
 * not?".
 */
import type { CamProfile, IScopedLogger, RtspEntryLike } from '@camstack/types'
import { defaultFfmpegSpawn } from '@camstack/types/node'
import { CamProfileSchema } from '@camstack/types'
import type { CameraRecordingOptions } from '@homebridge/hap-nodejs'

import type { ProfileFpsMap } from '../mappers/builders/stream-fps.js'
import type { BuilderContext } from '../mappers/types.js'
import type { HwDecodeDecision } from '../mappers/builders/stream-hwaccel.js'
import { selectHwDecode } from '../mappers/builders/stream-hwaccel.js'
import {
  decoderInfoSourceFromContext,
  probeDecoderHwaccel,
} from '../mappers/builders/stream-hwaccel-probe.js'
import type { HksvBuildOutcome, HksvWithholdReason } from './build-outcome.js'
import { createClipTeeFactory } from './clip-tee.js'
import { describeHapControllers } from './controller-census.js'
import { HksvFragmentSource } from './fragment-source.js'
import { HksvRecordingDelegate } from './recording-delegate.js'
import { recordingOutput } from './recording-invocation.js'
import {
  buildRecordingOptions,
  deriveFragmentLengthMs,
  HKSV_FRAGMENT_LENGTHS_MS,
} from './recording-options.js'
import { pickRecordingSource, refusalReason } from './recording-source.js'

/** Fallback when nothing measured a rate for the picked slot. */
const ASSUMED_RECORDING_FPS = 15

export interface HksvRecording {
  readonly options: CameraRecordingOptions
  readonly delegate: HksvRecordingDelegate
  dispose(): Promise<void>
}

export interface BuildHksvRecordingInput {
  readonly bctx: BuilderContext
  /** Already probed by the orchestrator for the live advertisement — reused. */
  readonly fpsByProfile: ProfileFpsMap
  /** `Characteristic.RecordingAudioActive`, read from the live controller. */
  readonly isAudioActive: () => boolean
}

export async function buildHksvRecording(
  input: BuildHksvRecordingInput,
): Promise<HksvRecording | null> {
  const { bctx } = input
  const { ctx, numericDeviceId } = bctx
  const log = ctx.logger.withTags({ deviceId: numericDeviceId })

  /**
   * Record the verdict for the clip source, next to the log line that already
   * states it. A camera HomeKit never recorded is not "a camera with no clips",
   * and `listSources` can only say which it is if the refusal was written down
   * (D571). Every `return null` below passes through here.
   */
  const note = (withheld: HksvWithholdReason | null, detail: string | null): void => {
    const outcome: HksvBuildOutcome = {
      deviceId: numericDeviceId,
      advertised: withheld === null,
      withheld,
      detail,
      atMs: Date.now(),
    }
    bctx.options.noteHksvOutcome?.(outcome)
  }

  const entries = await readProfileEntries(bctx)
  if (entries === null) {
    log.warn('export-hap: HKSV withheld — could not read the camera profiles', {})
    note('profiles-unreadable', 'cameraStreams.getProfileRtspEntries could not be read')
    return null
  }

  // The operator's spend switch, the same one the live path reads. Absent
  // means allowed, like every switch whose field postdates the entries it
  // governs — but on THIS branch "allowed" only ever applies to a camera that
  // cannot be copied at all: `pickRecordingSource` prefers a copy whenever one
  // exists, whatever the switch says.
  const allowTranscode = bctx.options.hapDeviceSettings?.allowTranscode !== false
  const choice = pickRecordingSource(entries, { allowTranscode })
  if (!choice.ok) {
    log.info('export-hap: HKSV withheld — no recordable stream', {
      meta: { refusal: choice.refusal, reason: refusalReason(choice.refusal) },
    })
    note('no-recordable-stream', `${choice.refusal}: ${refusalReason(choice.refusal)}`)
    return null
  }
  const source = choice.source

  // The expensive half of a re-encode is the DECODE, and the one authority on
  // what this node can decode is the decoder addon's own probe — the same read
  // the live transcode and `AgentLoadService` use, so the three cannot
  // disagree. Only asked on the branch that decodes.
  const decodeHwAccel = source.transcode ? await resolveDecodeHwAccel(bctx, log) : null

  const gopMs = await readSourceGopMs(bctx, source.width, source.height)
  // On the ENCODE branch we own the key-frame grid (`forceKeyFramesSeconds`),
  // so the camera's own cadence stops being a reason to withhold recording —
  // the gate below exists purely because a copy cannot cut where the source
  // did not. A transcoding camera therefore takes the shortest length we
  // advertise and hits it by construction.
  const fragmentLengthMs = source.transcode
    ? HKSV_FRAGMENT_LENGTHS_MS[0]
    : deriveFragmentLengthMs(gopMs)
  if (fragmentLengthMs === undefined || fragmentLengthMs === null) {
    // A key-frame cadence longer than anything we offer. On a copy branch we
    // cannot cut shorter, and advertising a length we exceed produces clips iOS
    // discards in silence — the single hardest HKSV failure to diagnose.
    log.warn(
      'export-hap: HKSV withheld — the camera key-frame interval is longer than any fragment length we advertise',
      {
        meta: { gopMs, brokerId: source.brokerId },
      },
    )
    note('key-frame-interval', `gopMs=${String(gopMs ?? 'unknown')}`)
    return null
  }

  // `RecordingSource.profile` is a bare string off the camera's entry list;
  // parsed, never cast, so a provider inventing a slot name cannot reach a
  // sidecar as if it were one of ours.
  const parsedProfile = CamProfileSchema.safeParse(source.profile)
  const recordedProfile: CamProfile | null = parsedProfile.success ? parsedProfile.data : null
  const fps = resolveFps(input.fpsByProfile, source.profile)
  // What the fragments will CARRY, which is the source size on a copy and the
  // fitted size when the encoder is resizing. Advertising anything else is the
  // "stream that does not match its own advertisement" defect.
  const out = recordingOutput(source)
  const options = buildRecordingOptions({
    width: out.width,
    height: out.height,
    fps,
    fragmentLengthMs,
  })

  // The TEE. HomeKit Secure Video is a sink — HDS `dataSend` is push-only and
  // `CameraRecordingDelegate` has no read-back — so a clip iOS stored is ours
  // only if we kept our own copy of what we SENT, at the moment we sent it. A
  // stream nobody teed is gone, which is why this ships ahead of the provider
  // that will list it (D550).
  //
  // Absent when the addon could not open its clip directory: HKSV then records
  // exactly as it did before, and the boot log already said why.
  // Per camera, and ON unless the operator said otherwise. A camera whose
  // HomeKit copy nobody wants still pays the disk and one thumbnail ffmpeg per
  // clip, so the switch is real work saved — but it is off only when he SAYS
  // so, because a clip not teed can never be recovered.
  const keepClips = bctx.options.hapDeviceSettings.keepHomekitClips !== false
  const clipStore = keepClips ? bctx.options.hksvClipStore : null
  const openClipTee =
    clipStore === null
      ? undefined
      : createClipTeeFactory({
          logger: log,
          deviceId: numericDeviceId,
          store: clipStore,
          width: out.width,
          height: out.height,
          fragmentMs: fragmentLengthMs,
          // The SLOT, recorded on every clip: `served` is a measurement the
          // tee is the only thing able to make, and a later reader must not
          // derive it from the pixels.
          ...(recordedProfile === null ? {} : { profile: recordedProfile }),
        })

  const delegate = new HksvRecordingDelegate({
    logger: log,
    deviceId: numericDeviceId,
    isAudioActive: input.isAudioActive,
    ...(openClipTee === undefined ? {} : { openClipTee }),
    advertisedFragmentMs: fragmentLengthMs,
    now: () => Date.now(),
    // Read at call time, never captured: the accessory is not published yet
    // here, and the census is only meaningful once a controller has connected.
    describeControllers: () => describeHapControllers(bctx.accessory),
    createSource: ({ fragmentMs, audioActive }) =>
      new HksvFragmentSource({
        logger: log,
        deviceId: numericDeviceId,
        // The addon's ONE pinned-ffmpeg resolver (D540), shared with the live
        // streaming path and the clip passes.
        resolveFfmpeg: bctx.options.resolveFfmpeg,
        spawnFn: defaultFfmpegSpawn,
        source,
        fragmentMs,
        audioActive,
        // Only the encode branch decodes anything. Read from the decoder
        // addon's own probe, so this and the pipeline cannot disagree about
        // what the hardware is.
        decodeHwAccel: decodeHwAccel?.hwaccel ?? null,
        ...(decodeHwAccel === null || decodeHwAccel.extraInputArgs.length === 0
          ? {}
          : { decodeInputArgs: decodeHwAccel.extraInputArgs }),
      }),
  })

  const advertisedResolution = options.video.resolutions[0]
  log.info('export-hap: HKSV ADVERTISED — recording is offered for this camera', {
    meta: {
      brokerId: source.brokerId,
      profile: source.profile,
      resolution: `${out.width}x${out.height}`,
      // A permanent encoder is the most expensive thing this addon can start,
      // and it must never be inferred from a missing line. BOTH branches say
      // which they are.
      branch: source.transcode ? 'transcode' : 'copy',
      ...(source.transcode
        ? {
            sourceResolution: `${source.width}x${source.height}`,
            decodeHwAccel: decodeHwAccel?.hwaccel ?? 'software',
          }
        : {}),
      // BOTH, always: the advertised rate is quantised (see
      // `normaliseAdvertisedFps`), and a hash computed over the advertised one
      // is what decides whether the controller's stored selection survives a
      // restart. Logging only the measurement would hide the number that
      // matters.
      measuredFps: fps,
      advertisedFps: advertisedResolution?.[2] ?? null,
      fragmentLengthMs,
      // `undefined` means the camera does not report a GOP and 4000 ms is a
      // guess; the delegate measures the real cadence and warns if it is wrong.
      sourceGopMs: gopMs ?? 'unknown',
      // A recording nobody tees is a clip that can never be recovered, and
      // silence about that reads as "it is being kept". BOTH facts, because
      // they call for different actions: the operator switched the copies off,
      // or the addon has no writable clips location.
      clipsKept: openClipTee !== undefined,
      clipsSwitchedOn: keepClips,
    },
  })
  note(null, null)

  return {
    options,
    delegate,
    dispose: () => delegate.dispose(),
  }
}

/**
 * The `-hwaccel` value for a transcoding prebuffer, and the flags that travel
 * with it.
 *
 * Software is a legitimate answer and is always NAMED: a camera that quietly
 * stopped using the GPU and one that never had it look identical in a CPU
 * graph, and on this branch the difference is most of a core, permanently.
 */
async function resolveDecodeHwAccel(
  bctx: BuilderContext,
  log: IScopedLogger,
): Promise<HwDecodeDecision> {
  const reading = await probeDecoderHwaccel({
    source: decoderInfoSourceFromContext(bctx.ctx),
    log,
    memo: bctx.options.decodeMemos.reading,
  })
  const decision = selectHwDecode({ transcode: true, reading, platform: process.platform })
  if (decision.kind === 'software') {
    log.warn(
      'export-hap: HKSV will transcode in SOFTWARE — this costs most of a core, permanently',
      {
        meta: { reason: decision.reason },
      },
    )
  }
  return decision
}

/** `cameraStreams.getProfileRtspEntries`, or `null` when the cap is unreachable. */
async function readProfileEntries(bctx: BuilderContext): Promise<readonly RtspEntryLike[] | null> {
  try {
    const entries = await bctx.proxy.cameraStreams?.getProfileRtspEntries({})
    return entries ?? null
  } catch {
    return null
  }
}

/**
 * The camera's own key-frame interval in ms, from `stream-params`, matched to
 * the picked slot BY RESOLUTION.
 *
 * By resolution and not by name on purpose: `stream-params` names its profiles
 * `main`/`sub`/`ext` while the broker names its slots `high`/`mid`/`low`, and
 * on 101 `ext` is the 1280×720 slot the broker calls `mid` — a name-based match
 * would silently read the 4K slot's GOP for a 720p recording.
 *
 * `undefined` when the cap is not bound, which is most non-Hikvision providers.
 */
async function readSourceGopMs(
  bctx: BuilderContext,
  width: number,
  height: number,
): Promise<number | undefined> {
  try {
    const status = await bctx.proxy.streamParams?.getStatus({})
    if (!status) return undefined
    for (const profile of [status.main, status.sub, status.ext]) {
      if (!profile) continue
      if (profile.width !== width || profile.height !== height) continue
      const { gop, framerate } = profile
      if (gop === undefined || gop <= 0 || framerate <= 0) return undefined
      return Math.round((gop / framerate) * 1000)
    }
    return undefined
  } catch {
    return undefined
  }
}

function resolveFps(fpsByProfile: ProfileFpsMap, profile: string): number {
  const resolved = fpsByProfile.get(profile as CamProfile)
  return resolved?.fps ?? ASSUMED_RECORDING_FPS
}
