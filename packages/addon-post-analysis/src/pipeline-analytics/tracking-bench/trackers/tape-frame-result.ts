/**
 * Tape records back into the production inputs a `FrameProcessor` takes.
 * A face pseudonym becomes the face's label — labels steer label writes, not
 * association, so the tracker sees what it saw.
 */
import type { FrameResult, ObjectDetection, Zone, ZoneRule } from '@camstack/types'
import { tapeDiscardCorners } from '../recorder/frame-record.js'
import type { TapeDetection, TapeFrame, TapeScene } from '../tape-schema.js'

function toObjectDetection(d: TapeDetection): ObjectDetection {
  const debug =
    d.ocls !== undefined || d.ot !== undefined
      ? {
          debug: {
            ...(d.ocls !== undefined ? { originalClass: d.ocls } : {}),
            ...(d.ot !== undefined ? { originalClassTier: d.ot } : {}),
          },
        }
      : {}
  return {
    id: d.id,
    kind: d.k,
    macroClass: d.cls,
    score: d.s,
    labels: d.fid !== undefined ? [{ label: d.fid, score: d.fs ?? 0 }] : [],
    bbox: { x: d.b[0], y: d.b[1], width: d.b[2], height: d.b[3] },
    ...(d.pid !== undefined ? { parentId: d.pid } : {}),
    ...(d.nr !== undefined
      ? { nativeRecovery: { score: d.nr[0], cropSidePx: d.nr[1], viewPx: d.nr[2] } }
      : {}),
    ...debug,
  }
}

export function toFrameResult(frame: TapeFrame, deviceId: number): FrameResult {
  return {
    kind: 'frame',
    frameId: `tape-${String(frame.t)}`,
    deviceId,
    timestamp: frame.t,
    width: frame.w,
    height: frame.h,
    detections: frame.dets.map(toObjectDetection),
    // Back to the executor's corner tuple (Task 5 converted it to [x, y, w, h]).
    discarded: frame.disc.map((d) => ({
      bbox: tapeDiscardCorners(d.b),
      macroClass: d.cls,
      score: d.s,
      reason: d.r,
    })),
    ...(frame.shed === true ? { shed: true as const } : {}),
    ...(frame.rootModelId !== undefined ? { rootModelId: frame.rootModelId } : {}),
  }
}

export function toZones(scene: TapeScene): Zone[] {
  return scene.zones.map((z) => ({
    id: z.id,
    name: z.id,
    kind: z.kind,
    polygon: z.polygon,
    color: '#000000',
  }))
}

export function toRules(scene: TapeScene): ZoneRule[] {
  return scene.rules.map((r) => ({
    id: r.id,
    zoneIds: r.zoneIds,
    mode: r.mode,
    enabled: r.enabled,
    ...(r.classFilter !== undefined ? { classFilter: r.classFilter } : {}),
    ...(r.overlapThreshold !== undefined ? { overlapThreshold: r.overlapThreshold } : {}),
    ...(r.bboxInclusionPct !== undefined ? { bboxInclusionPct: r.bboxInclusionPct } : {}),
    ...(r.preferMask !== undefined ? { preferMask: r.preferMask } : {}),
  }))
}
