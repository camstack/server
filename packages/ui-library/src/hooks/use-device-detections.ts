/**
 * useDeviceDetections — subscribes to motion, raw motion, and detection events for a device.
 *
 * Parametrized: accepts a tRPC-like proxy object so it works in both
 * admin-ui (BackendClient.trpc) and addon pages (AddonPageProps.trpc).
 */
import { useState, useEffect, useRef } from 'react'
import type {
  DetectionResultPayload,
  MotionAnalysisPayload,
  MotionZonesRawPayload,
  PhaseTransitionPayload,
  PipelineAnalyticsFrameTrackedPayload,
  ObjectDetection,
} from '@camstack/types'

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface MotionZone {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly intensity: number
}

export interface MotionState {
  readonly zones: readonly MotionZone[]
  readonly frameWidth: number
  readonly frameHeight: number
}

export interface DetectionState {
  readonly detections: readonly ObjectDetection[]
  readonly frameWidth: number
  readonly frameHeight: number
}

export interface MotionRawBox {
  readonly bbox: readonly [number, number, number, number]
  readonly changeScore: number
}

export interface MotionRawState {
  readonly boxes: readonly MotionRawBox[]
  readonly frameWidth: number
  readonly frameHeight: number
  readonly motionScore: number
}

export interface DeviceDetections {
  readonly motion: MotionState | null
  readonly motionRaw: MotionRawState | null
  readonly detection: DetectionState | null
  readonly phase: string
}

const MOTION_FADE_MS = 500
/** Detection overlay fade — ALSO the raw-fallback suppression window: while an
 *  enriched frame-tracked event arrived within this window, raw detection.result
 *  frames are ignored (post-analysis is the richer source; raw remains the
 *  fallback when post-analysis is absent). Keeping the two equal means raw
 *  resumes exactly when the enriched display fades — no blank gap. */
const DETECTION_FADE_MS = 800
/**
 * The most of a frame's age (arrival minus its capture timestamp) the fade
 * deducts. Bounded so a skewed server/browser clock can never make boxes vanish
 * on arrival: the server already drops frames older than 1 s from the overlay.
 */
const MAX_FRAME_AGE_FADE_DEDUCTION_MS = DETECTION_FADE_MS / 2

// ---------------------------------------------------------------------------
// tRPC subscription shape — typed to the procedures we actually call.
// We cannot import the full generated AppRouter into ui-library (circular dep),
// so we declare the minimal structural subset we need here.
// ---------------------------------------------------------------------------

interface LiveOnEvent {
  subscribe: (
    input: { category: string },
    opts: { onData: (event: unknown) => void },
  ) => { unsubscribe: () => void }
}

interface UseDetectionsTrpc {
  live?: { onEvent?: LiveOnEvent }
}

// ---------------------------------------------------------------------------
// tRPC proxy — must NOT use optional chaining on .subscribe() because
// Vite/esbuild compiles `a?.b?.method?.()` into `method.call(b, ...)` which
// breaks tRPC Proxy's internal `this` binding, causing "Cannot read 'context'".
// Instead, use direct property access inside try/catch.
// ---------------------------------------------------------------------------

/** Helper: subscribe to live.onEvent without optional chaining on subscribe() */
function safeSubscribe(
  trpc: UseDetectionsTrpc,
  category: string,
  onData: (event: unknown) => void,
): { unsubscribe: () => void } | null {
  try {
    const live = trpc.live
    if (!live) return null
    const proc = live.onEvent
    if (!proc || typeof proc.subscribe !== 'function') return null
    return proc.subscribe({ category }, { onData })
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Event narrowing helper — device events now carry a numeric `source.id`
// uniformly across the backend (pipeline-orchestrator / detection-pipeline /
// provider addons), so we compare numbers directly.
// ---------------------------------------------------------------------------

function matchesDevice(
  source: { readonly id?: string | number } | undefined,
  deviceId: number,
): boolean {
  return source?.id === deviceId
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDeviceDetections(
  trpc: UseDetectionsTrpc,
  deviceId: number | null,
): DeviceDetections {
  const [motion, setMotion] = useState<MotionState | null>(null)
  const [motionRaw, setMotionRaw] = useState<MotionRawState | null>(null)
  const [detection, setDetection] = useState<DetectionState | null>(null)
  const [phase, setPhase] = useState<string>('watching')

  const motionTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const motionRawTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const detectionTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const lastEnrichedAt = useRef(0)
  /** Capture timestamp of the newest enriched frame shown; older arrivals are dropped. */
  const lastShownFrameTs = useRef(0)

  // Subscribe to motion analysis events
  useEffect(() => {
    if (deviceId === null) return

    const sub = safeSubscribe(trpc, 'detection.motion-analysis', (event: unknown) => {
      const e = event as { source?: { id: string | number }; data?: MotionAnalysisPayload }
      if (!matchesDevice(e?.source, deviceId)) return
      const data = e.data
      if (!data?.regions || data.regions.length === 0) return

      setMotion({
        zones: data.regions.map((r) => ({ ...r.bbox, intensity: r.intensity })),
        frameWidth: data.frameWidth,
        frameHeight: data.frameHeight,
      })

      if (motionTimer.current) clearTimeout(motionTimer.current)
      motionTimer.current = setTimeout(() => setMotion(null), MOTION_FADE_MS)
    })

    return () => {
      sub?.unsubscribe()
      if (motionTimer.current) clearTimeout(motionTimer.current)
    }
  }, [trpc, deviceId])

  // Subscribe to raw motion zone events (all CCL regions before minArea filter)
  useEffect(() => {
    if (deviceId === null) return

    const sub = safeSubscribe(trpc, 'detection.motion-zones-raw', (event: unknown) => {
      const e = event as { source?: { id: string | number }; data?: MotionZonesRawPayload }
      if (!matchesDevice(e?.source, deviceId)) return
      const data = e.data
      if (!data?.zones) return

      setMotionRaw({
        boxes: data.zones.map((z) => ({ bbox: z.bbox, changeScore: z.changeScore })),
        frameWidth: data.frameSize?.width ?? 0,
        frameHeight: data.frameSize?.height ?? 0,
        motionScore:
          data.zones.length > 0
            ? data.zones.reduce((sum, z) => sum + z.changeScore, 0) / data.zones.length
            : 0,
      })

      if (motionRawTimer.current) clearTimeout(motionRawTimer.current)
      motionRawTimer.current = setTimeout(() => setMotionRaw(null), MOTION_FADE_MS)
    })

    return () => {
      sub?.unsubscribe()
      if (motionRawTimer.current) clearTimeout(motionRawTimer.current)
    }
  }, [trpc, deviceId])

  // Subscribe to the enriched overlay frames (two-plane re-injection):
  // roots + synthesized face/plate details + identity labels. Match on
  // data.deviceId — the event source is the pipeline-analytics addon.
  useEffect(() => {
    // Switching device within the suppression window must not carry over the
    // PREVIOUS device's stamp — otherwise the new device's raw detection.result
    // frames stay suppressed even though no enriched frame has arrived for it.
    lastEnrichedAt.current = 0
    lastShownFrameTs.current = 0

    if (deviceId === null) return

    const sub = safeSubscribe(trpc, 'pipeline-analytics.frame-tracked', (event: unknown) => {
      const e = event as { data?: PipelineAnalyticsFrameTrackedPayload }
      const data = e?.data
      if (!data || data.deviceId !== deviceId) return
      if (!data.detections?.length) return

      // Shape guard: an OLD post-analysis emitter can still publish legacy
      // `TrackedDetectionOut[]` (trackId/className/bbox{x,y,w,h}, no `kind`)
      // on this same category/envelope. Accept only the current two-plane
      // shape — otherwise we'd stamp lastEnrichedAt + suppress raw frames
      // while DetectionCanvas (which partitions on `d.kind`) renders nothing.
      const first = data.detections[0] as { kind?: unknown } | undefined
      if (typeof first?.kind !== 'string') return // legacy emitter — fall through to raw path

      // Frames can arrive out of order (replayed pre-roll, a slow relay): a
      // frame older than the newest one already drawn would make the boxes
      // jump backwards, so it is dropped. No timestamp = arrival order.
      const frameTs = typeof data.timestamp === 'number' ? data.timestamp : null
      if (frameTs !== null && frameTs < lastShownFrameTs.current) return
      if (frameTs !== null) lastShownFrameTs.current = frameTs

      // Fade by FRAME age, not arrival: a box that was already late when it
      // arrived is not kept for the full window on top of that lag.
      const ageMs =
        frameTs === null
          ? 0
          : Math.min(Math.max(Date.now() - frameTs, 0), MAX_FRAME_AGE_FADE_DEDUCTION_MS)
      const fadeInMs = DETECTION_FADE_MS - ageMs

      // Raw-frame suppression ends with the display, so there is no blank gap.
      lastEnrichedAt.current = Date.now() - ageMs
      setDetection({
        detections: data.detections,
        frameWidth: data.frameWidth,
        frameHeight: data.frameHeight,
      })

      if (detectionTimer.current) clearTimeout(detectionTimer.current)
      detectionTimer.current = setTimeout(() => setDetection(null), fadeInMs)
    })

    return () => {
      sub?.unsubscribe()
      // This effect arms the shared fade timer too — own its cleanup instead
      // of relying on the sibling raw-detection effect's identical dep array.
      if (detectionTimer.current) clearTimeout(detectionTimer.current)
    }
  }, [trpc, deviceId])

  // Subscribe to detection result events
  useEffect(() => {
    if (deviceId === null) return

    const sub = safeSubscribe(trpc, 'detection.result', (event: unknown) => {
      const e = event as { source?: { id: string | number }; data?: DetectionResultPayload }
      if (!matchesDevice(e?.source, deviceId)) return
      if (Date.now() - lastEnrichedAt.current < DETECTION_FADE_MS) return
      const frame = e.data?.frame
      if (!frame?.detections?.length) return

      setDetection({
        detections: frame.detections,
        frameWidth: frame.width,
        frameHeight: frame.height,
      })

      if (detectionTimer.current) clearTimeout(detectionTimer.current)
      detectionTimer.current = setTimeout(() => setDetection(null), DETECTION_FADE_MS)
    })

    return () => {
      sub?.unsubscribe()
      if (detectionTimer.current) clearTimeout(detectionTimer.current)
    }
  }, [trpc, deviceId])

  // Subscribe to detection phase transitions (real-time, not polling)
  useEffect(() => {
    if (deviceId === null) return

    // Initial phase stays at the default 'watching' — live
    // `detection.phase-transition` events drive updates. The legacy
    // `detection.cameraDetectionStatus` shim was removed; callers that
    // need a deterministic snapshot read `pipelineRunner.getCameraMetrics`
    // with an explicit nodeId directly.
    const sub = safeSubscribe(trpc, 'detection.phase-transition', (event: unknown) => {
      const e = event as { source?: { id: string | number }; data?: PhaseTransitionPayload }
      if (!matchesDevice(e?.source, deviceId)) return
      if (e.data?.to) setPhase(e.data.to)
    })

    return () => {
      sub?.unsubscribe()
    }
  }, [trpc, deviceId])

  return { motion, motionRaw, detection, phase }
}
