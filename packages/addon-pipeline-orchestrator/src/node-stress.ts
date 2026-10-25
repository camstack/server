/**
 * Node stress — "is this machine under too much load, and should detection move
 * off it?" — as PURE functions.
 *
 * ## What was already here, and why it is not enough
 *
 * `LoadShedController` already relocates a camera and `remote-health.ts`
 * already re-places a broken one, but neither answers the operator's question.
 * Both reason about ONE CAMERA at a time and both key on an ABSOLUTE fps floor
 * (`fpsMinThreshold`, shipped DISABLED at 0 precisely because an absolute floor
 * is unusable on this fleet: an on-motion camera idles below any threshold you
 * pick). Nothing computes a per-NODE verdict, and the balancer's only
 * real-time pressure term — `queueDepthTotal` — reads 0 on all three nodes
 * while the Mac mini's inference pool hits its in-flight cap 563 times an hour
 * (measured 2026-08-12 21:19→22:20Z). A signal that is zero during the
 * saturation it is supposed to detect is not a signal.
 *
 * ## The three sub-signals, and why they are combined with MAX
 *
 * All three are normalised to [0,1] and describe the SAME underlying condition
 * from different sides, so the composite is a `max`, never a sum or a mean: a
 * sum lets two half-signals fake a full one, and a mean lets one genuine full
 * signal be diluted by two quiet ones.
 *
 *  - `queuePressure` — frames waiting per active camera. The node is behind NOW.
 *  - `dropRatio`     — the share of the DEMANDED frame rate the node is
 *                      throwing away at the queue. This is the honest
 *                      saturation signature: a node that cannot keep up drops
 *                      at the queue, always.
 *  - `fpsDeficit`    — delivered ÷ demanded, over ACTIVE cameras only.
 *
 * ## The corroboration rule — the false positive that would have broken this
 *
 * A camera whose SOURCE only produces 2 fps against a configured 5 shows a
 * 0.6 fps deficit while the node is idle. Blaming the node for that would
 * relocate a camera that is going to look exactly as bad on the next machine —
 * failover as an infinite tour of the cluster. So `fpsDeficit` counts as
 * stress only when CORROBORATED by a queue or a drop: a starved source
 * produces neither (there is nothing to queue and nothing to drop), an
 * overloaded node produces both. Uncorroborated deficit is reported in the
 * signals (an operator wants to see it) and contributes 0 to the score.
 *
 * ## Hysteresis — a flapping failover is worse than none
 *
 * Entering and leaving are deliberately asymmetric on BOTH axes: the band
 * (enter 0.60 / leave 0.35) and the dwell (45 s to enter, 180 s to leave).
 * A node must be convincingly better, for three minutes, before it is a
 * placement candidate again. `saturated` — the only state that may shed — needs
 * a higher score AND a longer dwell than `stressed`.
 *
 * Three further guards bound the ACTION, and all three must pass:
 *   1. a per-device cooldown, so one camera cannot be moved twice in a row;
 *   2. a per-(device → node) RETURN BAN, so a camera cannot be moved back onto
 *      the node it was just taken off — the ping-pong that makes failover
 *      worse than nothing;
 *   3. a cluster-wide rate bound. Past it the cluster is uniformly overloaded
 *      and moving cameras is churn, not relief; the plan says so and stops
 *      rather than looping (same principle as `CrashSupervisor`, D6).
 *
 * ## What this module deliberately does NOT do
 *
 * It never PAUSES a camera. `LoadShedController` detaches as a last resort,
 * which makes a camera blind because the cluster is busy; a camera running at
 * reduced fps is strictly better than a camera running at none. When no target
 * qualifies, the plan is `no-target` and nothing happens — the governor is
 * already throttling, and that is the correct degradation.
 *
 * Pure, deterministic, no clock read (`now` is a parameter), no I/O. The
 * impure half — collecting samples, applying the move, persisting the state
 * carrier — belongs to the caller.
 */

/** How a node is doing. Only `saturated` may shed work. */
export type NodeStressState = 'ok' | 'stressed' | 'saturated'

/** The three normalised sub-signals plus the composite the state machine reads. */
export interface NodeStressSignals {
  /** Frames queued per active camera, normalised. */
  readonly queuePressure: number
  /** Share of the demanded frame rate dropped at the queue. */
  readonly dropRatio: number
  /** 1 − delivered/demanded over active cameras. Reported ALWAYS. */
  readonly fpsDeficit: number
  /** True when a queue or a drop corroborates {@link fpsDeficit}. */
  readonly deficitCorroborated: boolean
  /** `max(queuePressure, dropRatio, corroborated ? fpsDeficit : 0)`. */
  readonly score: number
}

/** One camera's contribution, as the orchestrator already receives it. */
export interface CameraStressSample {
  readonly deviceId: number
  /** Only `active` cameras are evidence — an idle on-motion camera is not. */
  readonly active: boolean
  readonly configuredFps: number
  readonly actualFps: number
  readonly queueDepth: number
  /** Cumulative counter as reported by the runner. */
  readonly droppedFrames: number
  /** The same counter at the previous observation, or `null` on the first. */
  readonly previousDroppedFrames: number | null
  /** Milliseconds between the two observations. `0` ⇒ no drop rate yet. */
  readonly sinceMs: number
}

/** Everything the state machine needs about ONE node this tick. */
export interface NodeStressInput {
  readonly nodeId: string
  readonly signals: NodeStressSignals
}

/** The state machine's carrier for one node — the caller stores it verbatim. */
export interface NodeStressMemory {
  readonly state: NodeStressState
  /** When {@link state} was entered. */
  readonly since: number
  /**
   * When the score first crossed the threshold of the state it is heading
   * toward, or `null` when it currently agrees with {@link state}. This is the
   * dwell clock — a single disagreeing sample resets it.
   */
  readonly pendingSince: number | null
  /** The state the dwell clock is counting toward. */
  readonly pending: NodeStressState | null
}

/** A node's verdict this tick, plus the memory to carry into the next one. */
export interface NodeStressVerdict {
  readonly nodeId: string
  readonly state: NodeStressState
  /** True when {@link state} differs from the state carried in. */
  readonly changed: boolean
  readonly signals: NodeStressSignals
  readonly memory: NodeStressMemory
}

/** Tunables for {@link evaluateNodeStress}. */
export interface NodeStressThresholds {
  /** Score at or above which a node heads for `stressed`. */
  readonly enter: number
  /** Score at or above which a node heads for `saturated`. */
  readonly saturate: number
  /** Score BELOW which a node heads back to `ok`. */
  readonly exit: number
  /** Dwell before `ok → stressed`. */
  readonly enterDwellMs: number
  /** Dwell before `stressed → saturated`. */
  readonly saturateDwellMs: number
  /** Dwell before any state → `ok`. Deliberately the longest. */
  readonly exitDwellMs: number
}

/**
 * Measured-fleet defaults. The band and the dwells are asymmetric on purpose —
 * see the module doc. `exitDwellMs` is 4× `enterDwellMs`: recovering is cheap
 * to get wrong and expensive to act on.
 */
export const DEFAULT_NODE_STRESS_THRESHOLDS: NodeStressThresholds = {
  enter: 0.6,
  saturate: 0.8,
  exit: 0.35,
  enterDwellMs: 45_000,
  saturateDwellMs: 90_000,
  exitDwellMs: 180_000,
}

/**
 * Queue depth per ACTIVE camera that reads as fully saturated. Four is one
 * in-flight frame plus a GOP's worth of slack at the detection cadence; beyond
 * it every added frame is latency the result will outlive.
 */
const QUEUE_DEPTH_FULL_PER_CAMERA = 4

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  return value >= 1 ? 1 : value
}

/**
 * Reduce this tick's per-camera samples to one node's signals.
 *
 * Only ACTIVE cameras contribute. A node with no active camera is not under
 * load by definition and scores 0 — which is the whole reason the absolute-fps
 * approach had to be abandoned: on an on-motion fleet most cameras are idle
 * most of the time and an absolute floor sees every one of them as broken.
 */
export function reduceNodeStress(samples: readonly CameraStressSample[]): NodeStressSignals {
  const active = samples.filter((s) => s.active && s.configuredFps > 0)
  if (active.length === 0) {
    return {
      queuePressure: 0,
      dropRatio: 0,
      fpsDeficit: 0,
      deficitCorroborated: false,
      score: 0,
    }
  }

  let demandedFps = 0
  let deliveredFps = 0
  let queueDepth = 0
  let droppedPerSec = 0
  for (const s of active) {
    demandedFps += s.configuredFps
    deliveredFps += Math.max(s.actualFps, 0)
    queueDepth += Math.max(s.queueDepth, 0)
    // A counter that went BACKWARDS is a runner restart, not a burst of drops:
    // treat it as no information rather than as a spike that would trip the
    // machine on the one tick a node is least able to answer for itself.
    if (s.previousDroppedFrames !== null && s.sinceMs > 0) {
      const delta = s.droppedFrames - s.previousDroppedFrames
      if (delta > 0) droppedPerSec += (delta * 1000) / s.sinceMs
    }
  }

  const queuePressure = clamp01(queueDepth / (active.length * QUEUE_DEPTH_FULL_PER_CAMERA))
  const dropRatio = clamp01(droppedPerSec / demandedFps)
  const fpsDeficit = clamp01(1 - deliveredFps / demandedFps)
  const deficitCorroborated = queuePressure > 0 || dropRatio > 0
  const score = Math.max(queuePressure, dropRatio, deficitCorroborated ? fpsDeficit : 0)

  return { queuePressure, dropRatio, fpsDeficit, deficitCorroborated, score }
}

/** A node with no history starts `ok` — never mid-transition. */
export function initialNodeStressMemory(now: number): NodeStressMemory {
  return { state: 'ok', since: now, pendingSince: null, pending: null }
}

/**
 * Which state the current score argues for, given where the node is now.
 * Returns `null` when the score agrees with the present state.
 *
 * The ladder is walked one rung at a time on purpose: a node cannot jump
 * `ok → saturated`, it must serve the `stressed` dwell first. Two consecutive
 * dwells before anything moves is the point.
 */
function targetState(
  state: NodeStressState,
  score: number,
  t: NodeStressThresholds,
): NodeStressState | null {
  if (score < t.exit) return state === 'ok' ? null : 'ok'
  if (state === 'ok') return score >= t.enter ? 'stressed' : null
  if (state === 'stressed') return score >= t.saturate ? 'saturated' : null
  // saturated: only the exit band (checked above) leaves. A score that has
  // merely fallen into the middle band keeps the node saturated — that middle
  // band IS the hysteresis.
  return null
}

/** The dwell a given transition must serve. */
function dwellFor(to: NodeStressState, t: NodeStressThresholds): number {
  if (to === 'ok') return t.exitDwellMs
  return to === 'saturated' ? t.saturateDwellMs : t.enterDwellMs
}

/**
 * Advance ONE node's state machine by one observation.
 *
 * A sample that disagrees with the pending transition resets the dwell clock
 * completely — the machine requires the condition to hold CONTINUOUSLY, not on
 * average. That is what makes it immune to a node that oscillates across a
 * threshold every few seconds.
 */
export function stepNodeStress(
  memory: NodeStressMemory,
  score: number,
  now: number,
  thresholds: NodeStressThresholds = DEFAULT_NODE_STRESS_THRESHOLDS,
): NodeStressMemory {
  const target = targetState(memory.state, score, thresholds)
  if (target === null) {
    return memory.pending === null
      ? memory
      : { state: memory.state, since: memory.since, pendingSince: null, pending: null }
  }
  if (memory.pending !== target) {
    return { state: memory.state, since: memory.since, pendingSince: now, pending: target }
  }
  const heldFor = now - (memory.pendingSince ?? now)
  if (heldFor < dwellFor(target, thresholds)) return memory
  return { state: target, since: now, pendingSince: null, pending: null }
}

/**
 * Advance every node's machine. Nodes absent from `inputs` keep their memory
 * untouched: a node we could not read is NOT a node that recovered. Losing the
 * reading and clearing the state is the failure mode D49 names — a fallible
 * read must never be the thing that undoes work.
 */
export function evaluateNodeStress(
  memories: ReadonlyMap<string, NodeStressMemory>,
  inputs: readonly NodeStressInput[],
  now: number,
  thresholds: NodeStressThresholds = DEFAULT_NODE_STRESS_THRESHOLDS,
): readonly NodeStressVerdict[] {
  return inputs.map((input): NodeStressVerdict => {
    const before = memories.get(input.nodeId) ?? initialNodeStressMemory(now)
    const after = stepNodeStress(before, input.signals.score, now, thresholds)
    return {
      nodeId: input.nodeId,
      state: after.state,
      changed: after.state !== before.state,
      signals: input.signals,
      memory: after,
    }
  })
}

// ── Failover planning ──────────────────────────────────────────────────

/** A camera the planner may consider moving. */
export interface StressFailoverCandidate {
  readonly deviceId: number
  readonly nodeId: string
  /** A manual pin is authoritative — a pinned camera is never moved. */
  readonly pinned: boolean
  readonly active: boolean
  readonly configuredFps: number
  /** Nodes that can obtain this camera's frames (the frame-source constraint). */
  readonly eligibleNodes: readonly string[]
}

/** One completed move, as the caller remembers it. */
export interface StressFailoverHistoryEntry {
  readonly deviceId: number
  /** The node the camera was taken OFF. */
  readonly fromNodeId: string
  readonly at: number
}

/** Everything the planner needs. Pure input — no maps to mutate. */
export interface StressFailoverPlanInput {
  readonly verdicts: readonly NodeStressVerdict[]
  readonly candidates: readonly StressFailoverCandidate[]
  /** Completed moves, newest or oldest first — order is irrelevant. */
  readonly history: readonly StressFailoverHistoryEntry[]
  /** Per-node camera ceilings; absent/null/≤0 = unlimited. Mirrors the balancer. */
  readonly nodeCaps?: Readonly<Record<string, number | null>>
  /** Cameras currently attached per node — the ceiling check and the tie-break. */
  readonly attachedByNode: Readonly<Record<string, number>>
  /**
   * The effective node shares when sessions are placed by share (D750). Present
   * ⇒ the target is the healthy node furthest BELOW its share, and a node at or
   * over its share is no target at all — failover must not undo the balance the
   * operator (or the automatic shares) asked for. Absent ⇒ the historical rule.
   */
  readonly shares?: Readonly<Record<string, number>>
}

/** Anti-flap bounds. Every one of them is a bound on the ACTION, not the signal. */
export interface StressFailoverGuards {
  /** A device that just moved cannot move again inside this window. */
  readonly deviceCooldownMs: number
  /** A device cannot return to the node it was taken off inside this window. */
  readonly returnBanMs: number
  /** Cluster-wide moves allowed inside {@link rateWindowMs}. */
  readonly maxMovesPerWindow: number
  readonly rateWindowMs: number
}

/**
 * Deliberately slow. Ten minutes per device is long enough for a move's effect
 * to appear in the signals it was based on (the enter dwell is 45 s and the
 * exit dwell 180 s); the 30-minute return ban is three times that, so a
 * two-node cluster physically cannot ping-pong. Four moves an hour is a bound,
 * not a target — a cluster needing more is not one a balancer can rescue.
 */
export const DEFAULT_STRESS_FAILOVER_GUARDS: StressFailoverGuards = {
  deviceCooldownMs: 10 * 60_000,
  returnBanMs: 30 * 60_000,
  maxMovesPerWindow: 4,
  rateWindowMs: 60 * 60_000,
}

/** The planner moved a camera. */
export interface StressFailoverMove {
  readonly kind: 'move'
  readonly deviceId: number
  readonly fromNodeId: string
  readonly toNodeId: string
  /** The source node's composite score at the time of the decision. */
  readonly fromScore: number
  readonly toScore: number
}

/** The planner did nothing, and says exactly why. */
export interface StressFailoverHold {
  readonly kind: 'hold'
  /**
   * - `no-saturated-node`  → nothing is saturated; the healthy path.
   * - `rate-bounded`       → the cluster-wide move budget is spent.
   * - `no-movable-camera`  → every camera on the saturated node is pinned,
   *                          idle, or inside its own cooldown.
   * - `no-target`          → no `ok` node can take it (ceiling, frame source,
   *                          return ban, or it would just move the problem).
   */
  readonly reason: 'no-saturated-node' | 'rate-bounded' | 'no-movable-camera' | 'no-target'
  /** The saturated node the planner was reasoning about, when there was one. */
  readonly nodeId?: string
  /** The camera that had nowhere to go (`no-target` under share placement). */
  readonly deviceId?: number
}

export type StressFailoverPlan = StressFailoverMove | StressFailoverHold

/**
 * Plan AT MOST ONE move.
 *
 * One, not a batch: every move changes the signals the next decision reads, and
 * a batch computed from one snapshot would over-correct exactly the way the
 * pre-2026-07-31 balancer did. The caller re-runs after the next observation.
 *
 * The source is the SATURATED node with the highest score. The camera is the
 * most expensive movable one on it — the largest single unit of load resolves
 * the imbalance in the fewest moves — with the lowest deviceId breaking a tie
 * so a repeated run is idempotent. The target must be `ok` (not merely
 * less-bad: moving work onto a `stressed` node is how a cluster collapses in
 * sequence), must have strictly fewer attached cameras than the source, and
 * must clear its ceiling, the frame-source constraint and the return ban.
 */
export function planStressFailover(
  input: StressFailoverPlanInput,
  now: number,
  guards: StressFailoverGuards = DEFAULT_STRESS_FAILOVER_GUARDS,
): StressFailoverPlan {
  const saturated = input.verdicts
    .filter((v) => v.state === 'saturated')
    .toSorted((a, b) => b.signals.score - a.signals.score || a.nodeId.localeCompare(b.nodeId))[0]
  if (!saturated) return { kind: 'hold', reason: 'no-saturated-node' }

  const recentMoves = input.history.filter((h) => now - h.at < guards.rateWindowMs)
  if (recentMoves.length >= guards.maxMovesPerWindow) {
    return { kind: 'hold', reason: 'rate-bounded', nodeId: saturated.nodeId }
  }

  const cooling = new Set(
    input.history.filter((h) => now - h.at < guards.deviceCooldownMs).map((h) => h.deviceId),
  )
  const movable = input.candidates
    .filter(
      (c) =>
        c.nodeId === saturated.nodeId &&
        c.active &&
        !c.pinned &&
        c.configuredFps > 0 &&
        !cooling.has(c.deviceId),
    )
    .toSorted((a, b) => b.configuredFps - a.configuredFps || a.deviceId - b.deviceId)
  if (movable.length === 0) {
    return { kind: 'hold', reason: 'no-movable-camera', nodeId: saturated.nodeId }
  }

  const okByNode = new Map(
    input.verdicts.filter((v) => v.state === 'ok').map((v) => [v.nodeId, v] as const),
  )
  const sourceAttached = input.attachedByNode[saturated.nodeId] ?? 0

  if (input.shares !== undefined) {
    return planShareTarget(input, input.shares, saturated, movable, okByNode, now, guards)
  }

  for (const camera of movable) {
    const banned = new Set(
      input.history
        .filter((h) => h.deviceId === camera.deviceId && now - h.at < guards.returnBanMs)
        .map((h) => h.fromNodeId),
    )
    const targets = camera.eligibleNodes
      .filter((nodeId) => nodeId !== saturated.nodeId && !banned.has(nodeId))
      .map((nodeId) => okByNode.get(nodeId))
      .filter((v): v is NodeStressVerdict => v !== undefined)
      .filter((v) => {
        const attached = input.attachedByNode[v.nodeId] ?? 0
        if (attached >= sourceAttached) return false
        const cap = input.nodeCaps?.[v.nodeId]
        return cap === null || cap === undefined || cap <= 0 || attached < cap
      })
      .toSorted((a, b) => a.signals.score - b.signals.score || a.nodeId.localeCompare(b.nodeId))
    const target = targets[0]
    if (!target) continue
    return {
      kind: 'move',
      deviceId: camera.deviceId,
      fromNodeId: saturated.nodeId,
      toNodeId: target.nodeId,
      fromScore: saturated.signals.score,
      toScore: target.signals.score,
    }
  }

  return { kind: 'hold', reason: 'no-target', nodeId: saturated.nodeId }
}

/** Deficits equal up to float noise. */
const SHARE_EPSILON = 1e-9

function underCap(input: StressFailoverPlanInput, nodeId: string): boolean {
  const cap = input.nodeCaps?.[nodeId]
  const attached = input.attachedByNode[nodeId] ?? 0
  return cap === null || cap === undefined || cap <= 0 || attached < cap
}

/**
 * Share placement's failover target (D750): among the camera's eligible,
 * `ok`, under-cap nodes, the one furthest below its share of the cameras
 * attached across the source and those nodes — the same deficit rule a new
 * session is placed by. A node at or over its share is no target, so a move
 * never undoes the balance. Nothing below its share ⇒ hold, naming the camera.
 */
function planShareTarget(
  input: StressFailoverPlanInput,
  shares: Readonly<Record<string, number>>,
  saturated: NodeStressVerdict,
  movable: readonly StressFailoverCandidate[],
  okByNode: ReadonlyMap<string, NodeStressVerdict>,
  now: number,
  guards: StressFailoverGuards,
): StressFailoverPlan {
  const shareOf = (nodeId: string): number => {
    const share = shares[nodeId]
    return share !== undefined && share > 0 ? share : 0
  }
  for (const camera of movable) {
    const banned = new Set(
      input.history
        .filter((h) => h.deviceId === camera.deviceId && now - h.at < guards.returnBanMs)
        .map((h) => h.fromNodeId),
    )
    const healthy = camera.eligibleNodes
      .filter((nodeId) => nodeId !== saturated.nodeId && !banned.has(nodeId))
      .map((nodeId) => okByNode.get(nodeId))
      .filter((v): v is NodeStressVerdict => v !== undefined)
      .filter((v) => underCap(input, v.nodeId))
    const set = [saturated.nodeId, ...healthy.map((v) => v.nodeId)]
    const shareSum = set.reduce((sum, nodeId) => sum + shareOf(nodeId), 0)
    const attachedSum = set.reduce((sum, nodeId) => sum + (input.attachedByNode[nodeId] ?? 0), 0)
    if (shareSum <= 0) continue
    const deficit = (nodeId: string): number =>
      (shareOf(nodeId) / shareSum) * attachedSum - (input.attachedByNode[nodeId] ?? 0)
    const target = healthy
      .filter((v) => deficit(v.nodeId) > SHARE_EPSILON)
      .toSorted(
        (a, b) =>
          deficit(b.nodeId) - deficit(a.nodeId) ||
          a.signals.score - b.signals.score ||
          a.nodeId.localeCompare(b.nodeId),
      )[0]
    if (!target) continue
    return {
      kind: 'move',
      deviceId: camera.deviceId,
      fromNodeId: saturated.nodeId,
      toNodeId: target.nodeId,
      fromScore: saturated.signals.score,
      toScore: target.signals.score,
    }
  }
  const first = movable[0]
  return {
    kind: 'hold',
    reason: 'no-target',
    nodeId: saturated.nodeId,
    ...(first !== undefined ? { deviceId: first.deviceId } : {}),
  }
}
