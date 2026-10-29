/**
 * useDeviceDetections — subscribes to motion, raw motion, and detection events for a device.
 *
 * Parametrized: accepts a tRPC-like proxy object so it works in both
 * admin-ui (BackendClient.trpc) and addon pages (AddonPageProps.trpc).
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import type {
  DetectionResultPayload,
  MotionAnalysisPayload,
  MotionZonesRawPayload,
  PhaseTransitionPayload,
  PipelineAnalyticsFrameTrackedPayload,
  ObjectDetection,
} from '@camstack/types'
import { mergeDetections, type FramePart } from './merge-detections'

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
/** Fade of each detection source (raw roots, enriched extras), counted from the
 *  frame's capture time so a late frame is not kept for the full window. */
const DETECTION_FADE_MS = 800
/** A frame older than this at arrival is replayed pre-roll and never drawn.
 *  Same meaning as the server's OVERLAY_MAX_FRAME_AGE_MS. */
const OVERLAY_MAX_FRAME_AGE_MS = 1000
/**
 * The most of a frame's age (arrival minus its capture timestamp) the fade
 * deducts. Bounded so a skewed server/browser clock can never make boxes vanish
 * on arrival.
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
  const rawTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const extrasTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  /** Live part of each source: raw roots and enriched extras fade independently. */
  const rawPart = useRef<FramePart | null>(null)
  const extrasPart = useRef<FramePart | null>(null)
  /** Capture timestamp of the newest frame shown, per source; older arrivals are dropped. */
  const lastRawTs = useRef(0)
  const lastExtrasTs = useRef(0)

  const publish = useCallback(() => {
    setDetection(mergeDetections(rawPart.current, extrasPart.current))
  }, [])

  /** Admit a frame: null = rejected (stale or out of order), else its fade in ms. */
  const admit = useCallback(
    (frameTs: number | null, lastTs: { current: number }): number | null => {
      if (frameTs !== null) {
        if (Date.now() - frameTs > OVERLAY_MAX_FRAME_AGE_MS) return null
        if (frameTs < lastTs.current) return null
        lastTs.current = frameTs
      }
      const ageMs =
        frameTs === null
          ? 0
          : Math.min(Math.max(Date.now() - frameTs, 0), MAX_FRAME_AGE_FADE_DEDUCTION_MS)
      return DETECTION_FADE_MS - ageMs
    },
    [],
  )

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

  // Enriched overlay frames (post-analysis): ONLY the extras are taken — detail
  // children (face, plate…) and identity labels. Root boxes come from the raw
  // detector frames below. Match on data.deviceId — the event source is the
  // pipeline-analytics addon.
  useEffect(() => {
    extrasPart.current = null
    rawPart.current = null
    lastExtrasTs.current = 0
    lastRawTs.current = 0
    setDetection(null)

    if (deviceId === null) return

    const sub = safeSubscribe(trpc, 'pipeline-analytics.frame-tracked', (event: unknown) => {
      const e = event as { data?: PipelineAnalyticsFrameTrackedPayload }
      const data = e?.data
      if (!data || data.deviceId !== deviceId) return
      if (!data.detections?.length) return

      // Shape guard: an OLD post-analysis emitter can still publish legacy
      // `TrackedDetectionOut[]` (no `kind`) on this category. Accept only the
      // current two-plane shape.
      const first = data.detections[0] as { kind?: unknown } | undefined
      if (typeof first?.kind !== 'string') return

      const fadeInMs = admit(
        typeof data.timestamp === 'number' ? data.timestamp : null,
        lastExtrasTs,
      )
      if (fadeInMs === null) return

      extrasPart.current = {
        detections: data.detections,
        frameWidth: data.frameWidth,
        frameHeight: data.frameHeight,
      }
      publish()

      if (extrasTimer.current) clearTimeout(extrasTimer.current)
      extrasTimer.current = setTimeout(() => {
        extrasPart.current = null
        publish()
      }, fadeInMs)
    })

    return () => {
      sub?.unsubscribe()
      if (extrasTimer.current) clearTimeout(extrasTimer.current)
    }
  }, [trpc, deviceId, admit, publish])

  // Raw detector frames: the root boxes, drawn as soon as they arrive.
  useEffect(() => {
    if (deviceId === null) return

    const sub = safeSubscribe(trpc, 'detection.result', (event: unknown) => {
      const e = event as { source?: { id: string | number }; data?: DetectionResultPayload }
      if (!matchesDevice(e?.source, deviceId)) return
      const frame = e.data?.frame
      if (!frame?.detections?.length) return

      const fadeInMs = admit(
        typeof frame.timestamp === 'number' ? frame.timestamp : null,
        lastRawTs,
      )
      if (fadeInMs === null) return

      rawPart.current = {
        detections: frame.detections,
        frameWidth: frame.width,
        frameHeight: frame.height,
      }
      publish()

      if (rawTimer.current) clearTimeout(rawTimer.current)
      rawTimer.current = setTimeout(() => {
        rawPart.current = null
        publish()
      }, fadeInMs)
    })

    return () => {
      sub?.unsubscribe()
      if (rawTimer.current) clearTimeout(rawTimer.current)
    }
  }, [trpc, deviceId, admit, publish])

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
