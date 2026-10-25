/**
 * The runner half of a PARK
 * ([D422](../../../../docs/decisions/adr-0422-a-relevant-frame-is-parked-when-it-becomes-relevant.md)):
 * the hub has judged a frame relevant to a track and, while the frame's
 * handle is young, asks the node that holds the pixels to keep a parcel.
 *
 * Deps-injected and pure so every branch is one assertion — the same reason
 * `detail-subtree.ts` and `stateless-step.ts` live outside the addon class.
 * The real deps are the runner's OWN native-lease resolve
 * (`resolveNativeCropPixels`, the same decision `getNativeCrop` makes — a
 * second copy of the tier arithmetic is how a quality tier starts differing by
 * caller) and its single JPEG encoder (`encodeNativeCropResult`).
 *
 * ## What a refusal means, and why it is never retried here
 *
 * A handle that no longer resolves at park time is the fault the 150–500 ms
 * window exists to prevent: the hub's decision arrived after the surface was
 * swept. That is a finding to LOG — per camera, with the handle's measured
 * age, so the next person can say which hop was late — not a reason to ask
 * again. The hub will park the track's NEXT best frame on its own; a retry
 * loop against a dead handle is exactly what D419/D420 were written to end.
 *
 * ## D52 and D9/D18, in this file
 *
 * The rectangle is cut by this node from `input.bbox`; the hub never sends a
 * tile it cut itself. The parcel is one compressed encode at one decision
 * point; nothing here runs at frame rate.
 */
import type { IPipelineRunnerProvider, IScopedLogger, ParkTrackFrameResult } from '@camstack/types'
import type { ParkedFrameStore } from '../session-decode/parked-frame-store.js'
import type { NativeCropMissReason, NativeCropPixels, NativeCropTier } from './native-crop-tier.js'

/** Input of the `parkTrackFrame` cap method, derived from the cap definition. */
export type ParkTrackFrameInput = Parameters<IPipelineRunnerProvider['parkTrackFrame']>[0]

/** What the runner's native-lease resolve answers — mirrors `resolveNativeCropPixels`. */
export interface ResolvedParkPixels {
  readonly pixels: NativeCropPixels | null
  readonly tier: NativeCropTier
  readonly missReason: NativeCropMissReason | null
  readonly handleAgeMs: number | null
  readonly workerReason: string | undefined
}

export interface TrackFrameParkDeps {
  /** This node's id — stamped on every answer so retrieval can be pinned. */
  readonly nodeId: string
  readonly store: Pick<ParkedFrameStore, 'park'>
  /** The runner's own native-lease resolve, unchanged. */
  resolvePixels(input: {
    readonly handle: ParkTrackFrameInput['handle']
    readonly bbox: ParkTrackFrameInput['bbox']
    readonly maxWidth?: number
  }): Promise<ResolvedParkPixels>
  /** The runner's single JPEG encoder; `null` when the encode throws. */
  encodeJpeg(pixels: NativeCropPixels): Promise<Buffer | null>
  readonly logger: IScopedLogger
}

/** Park one frame for one track. Never throws; a refusal is an answer. */
export async function parkTrackFrame(
  deps: TrackFrameParkDeps,
  input: ParkTrackFrameInput,
): Promise<ParkTrackFrameResult> {
  const { deviceId, trackId, kind } = input
  const handleKey = `${input.handle.shmId}#${input.handle.slot}#${input.handle.seq}`
  const resolved = await deps.resolvePixels({
    handle: input.handle,
    bbox: input.bbox,
    ...(input.maxWidth !== undefined ? { maxWidth: input.maxWidth } : {}),
  })
  // Native or nothing. A `ram-fullframe` answer is the ≤640 detection raster;
  // parking it would pin a track's best shot at detection resolution and call
  // it native — the masquerade the subject-crop tier gate refuses too.
  if (resolved.pixels === null || resolved.tier !== 'native') {
    const missReason = resolved.missReason ?? 'worker-lease-gone'
    const detail =
      resolved.workerReason !== undefined ? `${missReason}: ${resolved.workerReason}` : missReason
    deps.logger.warn('track frame park refused — the handle no longer resolves at park time', {
      tags: { deviceId },
      meta: {
        trackId,
        kind,
        reason: 'handle-gone',
        missReason,
        // The number that says which hop was late: how old the handle was
        // when the hub's decision reached this node. Null = never registered.
        handleAgeMs: resolved.handleAgeMs,
        servedTier: resolved.tier,
        handle: handleKey,
        ...(resolved.workerReason !== undefined ? { workerReason: resolved.workerReason } : {}),
      },
    })
    return {
      parked: false,
      nodeId: deps.nodeId,
      reason: 'handle-gone',
      handleAgeMs: resolved.handleAgeMs,
      detail,
    }
  }
  const jpeg = await deps.encodeJpeg(resolved.pixels)
  if (jpeg === null) {
    deps.logger.warn('track frame park refused — JPEG encode failed', {
      tags: { deviceId },
      meta: {
        trackId,
        kind,
        reason: 'encode-failed',
        handleAgeMs: resolved.handleAgeMs,
        handle: handleKey,
        width: resolved.pixels.width,
        height: resolved.pixels.height,
      },
    })
    return {
      parked: false,
      nodeId: deps.nodeId,
      reason: 'encode-failed',
      handleAgeMs: resolved.handleAgeMs,
    }
  }
  const verdict = deps.store.park(deviceId, trackId, kind, {
    jpeg,
    width: resolved.pixels.width,
    height: resolved.pixels.height,
    timestamp: input.timestamp,
  })
  deps.logger.debug('track frame parked', {
    tags: { deviceId },
    meta: {
      trackId,
      kind,
      verdict,
      bytes: jpeg.byteLength,
      width: resolved.pixels.width,
      height: resolved.pixels.height,
      handleAgeMs: resolved.handleAgeMs,
      source: resolved.pixels.source ?? 'lease',
    },
  })
  return {
    parked: true,
    nodeId: deps.nodeId,
    width: resolved.pixels.width,
    height: resolved.pixels.height,
    bytes: jpeg.byteLength,
    replaced: verdict === 'replaced',
  }
}
