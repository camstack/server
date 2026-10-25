/**
 * Resolution of the RTSP join-burst bound (D57) from its two operator
 * surfaces.
 *
 * WHY THE KNOB EXISTS AT ALL. D57 shipped the bound as a module constant. That
 * is wrong for a reason the decision states without drawing the conclusion: the
 * pre-buffer ring holds `[most recent keyframe AU .. now]`, so a burst's span
 * at join time is the time elapsed since the camera's last IDR — uniform in
 * `[0, idrIntervalMs]`. Under a fixed 2 000 ms bound, a camera with a 1.8 s GOP
 * is never withheld and one with a 4 s GOP is withheld on roughly half its
 * joins. One value cannot be right for both, and which one a camera needs is
 * set by its encoder, not by this cluster.
 *
 * WHY THE DEFAULT IS CLUSTER-SCOPED AND NOT PER-NODE. The ingest node is a
 * movable role (the orchestrator's `ingestNode` selector), so a per-node bound
 * would make a camera's join behaviour depend on which node happened to own its
 * ingest at the time — the split-behaviour trap D52/D56 exist to prevent. The
 * default therefore lives in the stream-broker addon's global settings WITHOUT
 * `perNode`, and only the per-CAMERA-STREAM axis is allowed to diverge.
 *
 * WHY THE OVERRIDE IS KEYED BY camStreamId. IDR interval is a property of the
 * encoder, and a camera's sub-stream routinely runs a different GOP from its
 * main. A per-device value would necessarily mis-tune one of them.
 *
 * WHAT IS DELIBERATELY NOT CONFIGURABLE. `maxPackets` stays fixed: it is a
 * defensive backstop against RTP timestamps that stopped describing the stream
 * (wrap, a source that repeats a timestamp, an all-intra latch that never
 * closed), not a tuning knob. And `maxSpanMs` is clamped at both ends, so
 * "configurable" can never mean "D57 turned off" — the population this bound
 * was built against reached 61 535 ms in a single burst.
 */
import {
  DEFAULT_PRIME_BURST_BOUND,
  PRIME_MAX_PACKETS,
  type PrimeBurstBound,
} from './rtsp-restreamer.js'

/**
 * Floor for a configured span bound. Below roughly this, no camera's keyframe
 * AU fits and the bound degenerates into "withhold every burst" — which is a
 * setting nobody wants and everybody could reach by typing a small number.
 */
export const JOIN_BURST_MIN_SPAN_MS = 250

/**
 * Ceiling for a configured span bound. Above this the burst is wide enough to
 * reproduce the confirmed HomeKit failure on any consumer that re-clocks what
 * it receives (measured: a 2 996 ms burst became 3 030 ms of controller-visible
 * jitter). 6 s admits even a slow 4-5 s IDR interval while keeping the tail
 * that D57 measured — p99 28 312 ms, max 61 535 ms — permanently out of reach.
 */
export const JOIN_BURST_MAX_SPAN_LIMIT_MS = 6000

/** Per-camera-stream span overrides, keyed by `camStreamId`. */
export type JoinBurstSpanOverrides = Readonly<Record<string, number>>

export interface JoinBurstBoundInput {
  /** The stream whose bound is being resolved (e.g. `native:main`). */
  readonly camStreamId: string
  /** Cluster-wide default from the addon's global settings. */
  readonly clusterMaxSpanMs?: number
  /** This device's per-camera-stream overrides, if any. */
  readonly overrides?: JoinBurstSpanOverrides
}

/**
 * A configured span, or `null` when the input carries no usable instruction.
 *
 * `0` is the important case: a cleared number input posts it, and passing it
 * through would withhold every burst wider than 0 ms — i.e. all of them — so
 * every consumer of that camera would silently start one full IDR interval
 * late, with no error anywhere. It means "inherit", never "withhold".
 */
function usableSpan(value: number | undefined): number | null {
  if (value === undefined) return null
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.min(JOIN_BURST_MAX_SPAN_LIMIT_MS, Math.max(JOIN_BURST_MIN_SPAN_MS, value))
}

/**
 * Combine cluster default and per-camera-stream override into the bound one
 * restream will apply. Precedence: stream override → cluster default → D57
 * default. Every layer is validated independently, so a bad override falls back
 * to a good cluster value rather than to the hard-coded default.
 */
export function resolveJoinBurstBound(input: JoinBurstBoundInput): PrimeBurstBound {
  const override = usableSpan(input.overrides?.[input.camStreamId])
  const cluster = usableSpan(input.clusterMaxSpanMs)
  const maxSpanMs = override ?? cluster ?? DEFAULT_PRIME_BURST_BOUND.maxSpanMs
  return { maxSpanMs, maxPackets: PRIME_MAX_PACKETS }
}
