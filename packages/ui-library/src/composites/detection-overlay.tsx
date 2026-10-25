/**
 * DetectionOverlay — renders motion zones, raw motion boxes, detection bounding boxes,
 * and pipeline phase indicator as CSS overlay.
 *
 * Pure component — receives all data via props. Use with useDeviceDetections hook.
 * Positioned absolute inside a relative parent (e.g., video container).
 */
import { useClassPainter } from './display-palette-context'
import { getPhaseVisual } from '../lib/phase-config'
import type { DeviceDetections, MotionRawBox } from '../hooks/use-device-detections'
import type { ObjectDetection, StationaryOverlayBox } from '@camstack/types'
import { formatParkedFor, STATIONARY_OVERLAY_STYLE } from '@camstack/types'
import { type JSX } from 'react'

export interface DetectionOverlayProps {
  readonly detections: DeviceDetections
  readonly showMotionZones?: boolean
  readonly showMotionRaw?: boolean
  readonly showDetections?: boolean
  /**
   * Draw subjects the tracker calls MOVING (and the ones it has not judged
   * yet — an unclassified track is not a still one, and hiding it would make a
   * new subject invisible for its first frames).
   */
  readonly showMoving?: boolean
  /**
   * Draw the CENSUS — the parked objects the registry holds.
   *
   * This layer does not come from the detection stream, and cannot. When the
   * evidence ledger promotes a parked object the tracker is told to forget it,
   * so it stops being a detection at all; it lives on the occupancy snapshot.
   * The switch therefore governs {@link stationaryObjects}, not a filter over
   * `detections` — which is what it used to be, and why it appeared to do
   * nothing.
   */
  readonly showStationary?: boolean
  /**
   * The census, normalised, from the occupancy snapshot
   * (`zoneAnalytics.getCurrentSnapshot().stationaryObjects`). Absent means the
   * caller has not fetched it — which is NOT the same as "nothing is parked",
   * so the layer simply draws nothing rather than claiming an empty lot.
   */
  readonly stationaryObjects?: readonly StationaryOverlayBox[]
  readonly showPhaseIndicator?: boolean
}

/**
 * Whether the tracker has said this subject is not going anywhere.
 *
 * The verdict is the tracker's `TrackState`, and `idle` is its word for still —
 * the SAME field the evidence ledger judges an observation on (D494), so the
 * overlay and the registry can never disagree about one box. An ABSENT verdict
 * is NOT still: the tracker needs ~10 s to settle on `idle`, and treating "no
 * verdict yet" as still would file every new subject under the wrong switch for
 * its first seconds.
 */
function isStill(d: ObjectDetection): boolean {
  return d.track?.movementState === 'idle'
}

export function DetectionOverlay({
  detections: { motion, motionRaw, detection, phase },
  showMotionZones = true,
  showMotionRaw = true,
  showDetections = true,
  showMoving = true,
  showStationary = true,
  stationaryObjects,
  showPhaseIndicator = true,
}: DetectionOverlayProps): JSX.Element | null {
  const hasMotion = showMotionZones && motion && motion.zones.length > 0
  const hasMotionRaw = showMotionRaw && motionRaw && motionRaw.boxes.length > 0
  // Two switches over ONE list, the way the viewer's overlay panel splits them:
  // a parked car and a walking person are different things to want on screen.
  // `showDetections` stays the master — off means neither, which is what every
  // existing caller passing only that flag still gets.
  //
  // `isStill` still splits the DETECTION list: a subject the tracker calls idle
  // but the ledger has not promoted yet is a real thing to be able to hide. It
  // is a narrow population by design — most parked objects have already left
  // the stream — which is exactly why the census below is a layer of its own
  // and not a filter over this list.
  const visibleDets =
    showDetections && detection
      ? detection.detections.filter((d) => (isStill(d) ? showStationary : showMoving))
      : []
  const hasDets = visibleDets.length > 0
  const parked = showDetections && showStationary ? (stationaryObjects ?? []) : []
  const hasParked = parked.length > 0

  if (!hasMotion && !hasMotionRaw && !hasDets && !hasParked && !showPhaseIndicator) return null

  return (
    <div className="absolute inset-0 pointer-events-none z-10">
      {showPhaseIndicator && <PhaseBadge phase={phase} />}
      {hasMotionRaw && <MotionRawBoxes raw={motionRaw!} />}
      {hasMotion && <MotionZones motion={motion!} />}
      {hasParked && <StationaryBoxes boxes={parked} />}
      {hasDets && (
        <DetectionBoxes
          detections={visibleDets}
          frameWidth={detection!.frameWidth}
          frameHeight={detection!.frameHeight}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PhaseBadge({ phase }: { readonly phase: string }) {
  const cfg = getPhaseVisual(phase)
  return (
    <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/60 backdrop-blur-sm">
      <span className={`w-2 h-2 rounded-full ${cfg.dotClass}`} />
      <span className="text-[10px] font-semibold text-white uppercase tracking-wider">
        {cfg.label}
      </span>
    </div>
  )
}

function MotionRawBoxes({
  raw,
}: {
  readonly raw: { boxes: readonly MotionRawBox[]; frameWidth: number; frameHeight: number }
}) {
  if (raw.frameWidth === 0 || raw.frameHeight === 0) return null

  return (
    <>
      {raw.boxes.map((box, i) => {
        const [x1, y1, x2, y2] = box.bbox
        const left = (x1 / raw.frameWidth) * 100
        const top = (y1 / raw.frameHeight) * 100
        const width = ((x2 - x1) / raw.frameWidth) * 100
        const height = ((y2 - y1) / raw.frameHeight) * 100
        const opacity = Math.max(0.05, Math.min(0.25, box.changeScore * 0.3))

        return (
          <div
            key={`mr-${i}`}
            className="absolute rounded-sm"
            style={{
              left: `${left}%`,
              top: `${top}%`,
              width: `${width}%`,
              height: `${height}%`,
              backgroundColor: `rgba(239, 68, 68, ${opacity})`,
            }}
          />
        )
      })}
    </>
  )
}

function MotionZones({
  motion,
}: {
  readonly motion: {
    zones: readonly { x: number; y: number; w: number; h: number; intensity: number }[]
    frameWidth: number
    frameHeight: number
  }
}) {
  if (motion.frameWidth === 0 || motion.frameHeight === 0) return null

  // Filter out near-full-frame zones (noise)
  const meaningful = motion.zones.filter((z) => {
    const coverage = (z.w * z.h) / (motion.frameWidth * motion.frameHeight)
    return coverage < 0.9
  })

  return (
    <>
      {meaningful.map((z, i) => {
        const alpha = Math.max(0.15, Math.min(0.5, z.intensity / 255))
        return (
          <div
            key={`mz-${i}`}
            className="absolute rounded-sm"
            style={{
              left: `${(z.x / motion.frameWidth) * 100}%`,
              top: `${(z.y / motion.frameHeight) * 100}%`,
              width: `${(z.w / motion.frameWidth) * 100}%`,
              height: `${(z.h / motion.frameHeight) * 100}%`,
              border: `1px solid rgba(250, 204, 21, ${alpha})`,
              backgroundColor: `rgba(250, 204, 21, ${alpha * 0.15})`,
            }}
          />
        )
      })}
    </>
  )
}

/**
 * The census, drawn as its own layer.
 *
 * Deliberately quieter than a detection box: a parked car is not news, and an
 * overlay that shouts about it every frame is the reason the operator turns the
 * whole thing off. Dashed, dimmer, and labelled with how long it has been
 * there — which is the only question anyone asks about a parked object, and the
 * one a detection box can never answer.
 */
function StationaryBoxes({ boxes }: { readonly boxes: readonly StationaryOverlayBox[] }) {
  const paint = useClassPainter()
  const now = Date.now()
  return (
    <>
      {boxes.map((b) => {
        const color = paint(b.className)
        return (
          <div
            key={b.id}
            // A stable hook for the guard that keeps this layer alive. Keying a
            // test on a Tailwind class breaks the moment the treatment moves to
            // the shared contract — which is exactly what just happened.
            data-census-box=""
            className="absolute"
            style={{
              left: `${String(b.x1 * 100)}%`,
              top: `${String(b.y1 * 100)}%`,
              width: `${String((b.x2 - b.x1) * 100)}%`,
              height: `${String((b.y2 - b.y1) * 100)}%`,
              borderColor: color,
              // The treatment is a shared contract, not a Tailwind class chosen
              // here — the viewer draws the same census with the same values in
              // React Native primitives.
              borderWidth: STATIONARY_OVERLAY_STYLE.borderWidth,
              borderStyle: STATIONARY_OVERLAY_STYLE.dashed ? 'dashed' : 'solid',
              borderRadius: STATIONARY_OVERLAY_STYLE.borderRadius,
              opacity: STATIONARY_OVERLAY_STYLE.opacity,
            }}
          >
            <span
              className="absolute -top-5 left-0 px-1 text-[10px] font-medium rounded-sm whitespace-nowrap"
              style={{ backgroundColor: color, color: '#000' }}
            >
              {b.label ?? b.className} · {formatParkedFor(now - b.becameStationaryAt)}
            </span>
          </div>
        )
      })}
    </>
  )
}

function DetectionBoxes({
  detections,
  frameWidth,
  frameHeight,
}: {
  readonly detections: readonly ObjectDetection[]
  readonly frameWidth: number
  readonly frameHeight: number
}) {
  const paint = useClassPainter()
  if (frameWidth === 0 || frameHeight === 0) return null

  return (
    <>
      {detections.map((d) => {
        const { x, y, width: bw, height: bh } = d.bbox
        const left = (x / frameWidth) * 100
        const top = (y / frameHeight) * 100
        const width = (bw / frameWidth) * 100
        const height = (bh / frameHeight) * 100
        const color = paint(d.macroClass)

        const parts = [`${d.macroClass} ${(d.score * 100).toFixed(0)}%`]
        for (const l of d.labels) {
          parts.push(l.label)
        }

        return (
          <div
            key={`det-${d.id}`}
            className="absolute border-2 rounded-sm"
            style={{
              left: `${left}%`,
              top: `${top}%`,
              width: `${width}%`,
              height: `${height}%`,
              borderColor: color,
            }}
          >
            <div
              className="absolute -top-4 left-0 px-1 py-0.5 text-[9px] font-bold text-white rounded-sm whitespace-nowrap"
              style={{ backgroundColor: color }}
            >
              {parts.join(' | ')}
            </div>
          </div>
        )
      })}
    </>
  )
}
