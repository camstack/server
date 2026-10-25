/**
 * The impure half of R5: read what each profile slot costs, at the moment a
 * session starts.
 *
 * Deliberately NOT hoisted to accessory-build time like the frame-rate probe.
 * The advertisement is frozen when the `CameraController` is constructed, so
 * it has no choice; the copy-vs-transcode decision is taken per session and
 * must see the camera's encoder configuration as it is now — an operator who
 * lowers a substream's bitrate should get pass-through on the next session,
 * not after the next accessory rebuild.
 *
 * Three cap reads per session start. Each is logged when it fails, because
 * "this camera exposes no encoder configuration" and "the call errored" lead
 * to different fixes, and both end in the same fallback.
 *
 * ## Why this is bounded in time
 *
 * These reads sit inside HomeKit's `Selected RTP Stream Configuration` write
 * handler, and they cross into a stream-broker that regularly freezes for two
 * to three seconds. Run in sequence, their latencies ADD. Measured on the live
 * hub: negotiate at :11, controller gives up at 9.1 s, fit resolved at :32 —
 * twenty-one seconds — and the start then failed with `Not running` because
 * the session it was preparing was already gone.
 *
 * So the reads now run CONCURRENTLY and under one budget. Missing evidence is
 * a supported state — {@link resolveProfileBitrates} yields `unknown`, and
 * since D62 an unknown rate no longer forces a re-encode: it means the picker
 * cannot PREFER a slot on rate grounds and falls through to the tolerated
 * branch. Answering with less evidence is therefore strictly better than
 * answering after the controller has left.
 */
import type { CameraStream, IScopedLogger, ProfileSlot, WebrtcStreamChoice } from '@camstack/types'

import type { BuilderContext } from '../types.js'
import { withDeadline } from './deadline.js'
import type { ProfileBitrateMap } from './stream-bitrate.js'
import { resolveProfileBitrates } from './stream-bitrate.js'

/**
 * Total budget for the rate evidence, not per call — the point is to bound
 * what the CONTROLLER waits for, and it waits for the sum.
 */
export const BITRATE_EVIDENCE_BUDGET_MS = 1_500

export interface ProbeProfileBitratesInput {
  readonly bctx: BuilderContext
  /** Already fetched by the START path — not re-read here. */
  readonly slots: readonly ProfileSlot[]
  readonly log: IScopedLogger
}

/** Exactly what the pure resolver accepts, so the two cannot drift apart. */
type StreamParamsReading = Parameters<typeof resolveProfileBitrates>[0]['streamParams']

export interface RateEvidence {
  readonly camStreams: readonly CameraStream[] | null
  readonly streamParams: StreamParamsReading
  readonly choices: readonly WebrtcStreamChoice[] | null
}

const NO_EVIDENCE: RateEvidence = { camStreams: null, streamParams: null, choices: null }

/**
 * The last evidence that actually arrived, per device.
 *
 * Falling back to NO evidence on a slow read was not a neutral degradation: it
 * changed WHICH SLOT the picker chose. Measured on 101 within forty seconds,
 * same camera, same negotiated 1280x720:
 *
 *   10:22:11  mid  10 fps
 *   10:22:17  low  24 fps
 *   10:22:26  mid  10 fps
 *   10:22:50  low  24 fps
 *
 * With evidence, `low` classifies as a fit and wins; without it every slot is
 * `unknown` and the fallback takes `mid`. So the stream a controller received
 * depended on whether a cap read beat a 1500 ms timer — a coin flip, and one
 * that hands iOS a different profile on each retry.
 *
 * A rate is a property of the camera's encoder configuration, which changes
 * when an operator changes it and not otherwise. Yesterday's reading is a far
 * better answer than no reading, and the ONE case that must still see fresh
 * numbers — the operator lowering a substream — is a deliberate act followed
 * by a new session, by which time the background read has long landed.
 */
const lastGoodEvidence = new Map<number, RateEvidence>()

/**
 * Resolve every profile slot's rate. Never throws and never outlives its
 * budget: a slow read falls back to this device's last good reading, and only
 * a device that has never answered at all ends up `unknown`.
 */
export async function probeProfileBitrates(
  input: ProbeProfileBitratesInput,
): Promise<ProfileBitrateMap> {
  const deviceId = input.bctx.numericDeviceId
  const evidence = await gatherRateEvidence(
    input.bctx.proxy,
    input.log,
    lastGoodEvidence.get(deviceId),
  )
  if (evidence.camStreams !== null || evidence.streamParams !== null) {
    lastGoodEvidence.set(deviceId, evidence)
  }
  return resolveProfileBitrates({
    slots: input.slots,
    camStreams: evidence.camStreams ?? [],
    streamParams: evidence.streamParams,
    choices: evidence.choices ?? [],
  })
}

/**
 * Issue the three reads CONCURRENTLY under one budget.
 *
 * Exported so the concurrency and the budget can be asserted directly: run in
 * sequence these latencies add, and adding them is what cost a session.
 */
export async function gatherRateEvidence(
  proxy: BuilderContext['proxy'],
  log: IScopedLogger,
  lastGood?: RateEvidence,
): Promise<RateEvidence> {
  const startedAt = Date.now()

  const gathered = Promise.all([
    probe<readonly CameraStream[]>(
      () => proxy.cameraStreams?.getCameraStreams({}),
      'cameraStreams.getCameraStreams',
      log,
    ),
    probe(() => proxy.streamParams?.getStatus({}), 'streamParams.getStatus', log),
    probe<readonly WebrtcStreamChoice[]>(
      () => proxy.webrtcSession?.listStreams({}),
      'webrtcSession.listStreams',
      log,
    ),
  ]).then(
    ([camStreams, streamParams, choices]): RateEvidence => ({ camStreams, streamParams, choices }),
  )

  const evidence = await withDeadline(
    gathered,
    BITRATE_EVIDENCE_BUDGET_MS,
    lastGood ?? NO_EVIDENCE,
    () => {
      log.warn('export-hap: rate evidence ABANDONED on its budget', {
        meta: {
          budgetMs: BITRATE_EVIDENCE_BUDGET_MS,
          // Named so the next reader knows where the time went rather than
          // re-deriving it: this path crosses into the stream-broker, which
          // stalls for seconds at a time under load.
          fellBackTo: lastGood === undefined ? 'no-evidence' : 'last-good',
          consequence:
            lastGood === undefined
              ? 'every slot rate reads UNKNOWN; the picker loses its rate preference'
              : 'the previous reading decides the fit, so the chosen slot stays STABLE',
        },
      })
    },
  )

  const elapsedMs = Date.now() - startedAt
  if (elapsedMs > BITRATE_EVIDENCE_BUDGET_MS / 2) {
    log.info('export-hap: rate evidence was slow', {
      meta: { elapsedMs, budgetMs: BITRATE_EVIDENCE_BUDGET_MS },
    })
  }

  return evidence
}

async function probe<T>(
  call: () => Promise<T> | undefined,
  label: string,
  log: IScopedLogger,
): Promise<T | null> {
  try {
    const pending = call()
    if (pending === undefined) {
      log.info('export-hap: bitrate probe skipped — cap not bound on this device', {
        meta: { call: label },
      })
      return null
    }
    return await pending
  } catch (err) {
    log.warn('export-hap: bitrate probe failed — the slot rate stays UNKNOWN', {
      meta: { call: label, error: err instanceof Error ? err.message : String(err) },
    })
    return null
  }
}
