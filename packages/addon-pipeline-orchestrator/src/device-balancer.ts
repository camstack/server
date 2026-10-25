/**
 * Per-node inference-device balancer (multi-device C4).
 *
 * Picks which of a node's ENABLED inference devices a NEW detection session
 * should land on, so sessions spread across the node's accelerators
 * (NPU / iGPU / Coral / additional Corals / ANE) proportionally to weight.
 *
 * This is the spec's "second `balance()` pass": it reuses the SAME pure
 * weighted-least-loaded decision core as the node tier (`load-balancer.ts`),
 * with the deviceKey playing the role of `nodeId` — inheriting its capacity
 * caps, its `available` gating, and its L1 manual-affinity tier (here the
 * operator's node+device pin).
 *
 * Load comes from the chosen node's `RunnerLocalLoad.devices` (real per-pool
 * session counts, Block B) — NOT the orchestrator's own session registry, so
 * standing/always-on inference load on a device is counted too (audit F6).
 *
 * ## Why the tie-break is NOT `balance()`'s
 *
 * `balance()` ends on `sortKey - sortKey || nodeId.localeCompare(nodeId)`. That
 * lexicographic fallback is deliberate at the NODE tier: an equal-share re-run
 * must not reshuffle a cluster. At the DEVICE tier it is a starvation bug.
 *
 * Sessions here are ON-MOTION: they start, run for seconds, and end. They
 * almost never overlap, so at dispatch time EVERY device scores 0 and every
 * dispatch is a tie — and a constant tie-break then sends 100% of sessions to
 * the lexicographically-first key, forever. A hub with `openvino:gpu` and
 * `openvino:npu` both enabled, both available, both weight 1, no camera pin,
 * ran every single session on `openvino:gpu` and left the NPU idle. The
 * balancer was balancing CONCURRENT load in a deployment that is never
 * concurrent.
 *
 * The fix is scoped to this file (see {@link pickInferenceDevice}), NOT to
 * `balance()`: making `balance()` itself non-deterministic would make node
 * placement reshuffle on every equal-share re-run, which the node tier relies
 * on not happening. `balance()` still decides the pin (L1), the caps, and the
 * ordering; this file only decides WHICH of the devices `balance()` could not
 * separate gets the session.
 *
 * Returns `default-pool` when there is nothing to place a deviceKey on: zero
 * eligible devices, or exactly one eligible device with no pin (the runner's
 * single default accelerator already serves it — pinning every session to the
 * one key would be redundant and, pre-D, spin a needless second pool).
 */
import type { RunnerLocalLoad, SessionPlacementPolicy, ShareAffinityReason } from '@camstack/types'
import { electByShareWithAffinity } from '@camstack/types'
import type { ShareElectionHistory } from './share-election-history.js'
import type { BalancerInput } from './load-balancer.js'
import { balance, rankCandidates } from './load-balancer.js'

/** Live per-device load for one deviceKey (a `RunnerLocalLoad.devices` entry). */
export interface DeviceLoadInput {
  readonly deviceKey: string
  readonly attachedCameras: number
  /**
   * Requests currently queued at this device's inference pool, and the cap the
   * pool sheds at. Together they say whether the device is DROWNING, which
   * session counts cannot: on 2026-09-04 the hub's `openvino:gpu` failed 100%
   * of inferences for four hours while still winning ~47% of elections (741 vs
   * 666), because it was elected on load and load counts sessions, not health.
   * The NPU sat at zero timeouts throughout and could have absorbed the whole
   * arrival on its own.
   *
   * Absent means "not reported" and never counts as saturated — a node that
   * does not publish backlog must not be quietly excluded.
   */
  readonly inFlight?: number
  readonly inFlightCap?: number
}

/** A device is drowning when its pool queue has reached the shed cap. */
export function isDeviceSaturated(load: DeviceLoadInput | undefined): boolean {
  if (load?.inFlight === undefined || load.inFlightCap === undefined) return false
  return load.inFlightCap > 0 && load.inFlight >= load.inFlightCap
}

/**
 * Fair choice among devices the capacity tier could not separate.
 *
 * Round-robin, keyed by the tied SET (not by camera, not global): each distinct
 * tied set carries its own cursor, so a two-device tie strictly alternates and
 * a three-device tie strictly rotates, at any dispatch rate — including the
 * rate that broke the old tie-break, one non-overlapping session at a time.
 *
 * Chosen over the alternative (a decayed history of recent placements folded
 * into the score) because:
 *  - it needs no clock, so it is exactly reproducible in a test;
 *  - it needs no decay constant to tune, and a mis-tuned constant reintroduces
 *    the exact bug (a half-life longer than the inter-session gap collapses
 *    back to "always the same device");
 *  - it GUARANTEES alternation rather than making it probable.
 *
 * The cursor is the only mutable state in this module, and it is advisory: a
 * lost or reset cursor costs at most one unfair dispatch. It deliberately does
 * NOT decide idempotence — that is {@link PickInferenceDeviceInput.currentDeviceKey}'s
 * job, and it is checked FIRST, so re-running placement for an already-placed
 * camera never consumes a rotation slot and never moves the camera.
 */
export interface InferenceDeviceRotation {
  /** The next key to use from `tiedKeys` (a non-empty, already-sorted set). */
  next(tiedKeys: readonly string[]): string
}

/** The default {@link InferenceDeviceRotation} — one cursor per distinct tied set. */
export class RoundRobinInferenceDeviceRotation implements InferenceDeviceRotation {
  /**
   * `tied-set signature → last index used`. Keyed by the SET so that a device
   * going away (unplugged Coral, operator disable) starts a fresh, correct
   * rotation over the remaining devices instead of inheriting an index that
   * points at a gone device or skews the new rotation.
   */
  private readonly cursorByTiedSet = new Map<string, number>()

  next(tiedKeys: readonly string[]): string {
    const ordered = tiedKeys.toSorted()
    const signature = ordered.join('|')
    const previous = this.cursorByTiedSet.get(signature)
    const index = previous === undefined ? 0 : (previous + 1) % ordered.length
    this.cursorByTiedSet.set(signature, index)
    return ordered[index]!
  }
}

export interface PickInferenceDeviceInput {
  /** Enabled∧available devices as `deviceKey → weight` (Block A eligibility). */
  readonly eligible: Readonly<Record<string, number>>
  /** Real per-device load from the node's `getLocalLoad().devices` (Block B). */
  readonly loads?: readonly DeviceLoadInput[]
  /** Per-device session cap as `deviceKey → maxSessions` (null/absent = unlimited). */
  readonly caps?: Readonly<Record<string, number | null>>
  /** Operator's node+device pin — the pinned deviceKey wins as L1 affinity. */
  readonly pinnedDeviceKey?: string | null
  /**
   * The deviceKey this camera is ALREADY running on, when re-running placement
   * for a camera that is currently attached (the standing/`dispatchCamera`
   * path). If it is still among the tied devices it is kept, so a re-dispatch
   * is idempotent and never thrashes a live camera between accelerators. The
   * session path passes nothing: an ephemeral on-motion session has no standing
   * placement, and treating the PREVIOUS session's device as sticky would pin
   * the camera to one accelerator forever — the very bug this fixes.
   */
  readonly currentDeviceKey?: string | null
  /**
   * Fair chooser among tied devices. Absent ⇒ the tie falls back to the
   * lexicographically-first key (`balance()`'s constant tie-break), which is
   * deterministic but NOT fair — production always injects a rotation.
   */
  readonly rotation?: InferenceDeviceRotation
  /**
   * Cluster placement policy (D748). `share` holds the device shares
   * (weights) of PARALLEL sessions with `electByShare` instead of the
   * capacity tier and its 1:1 tie rotation; a device at its `maxSessions`
   * cap or drowning yields to a free one. Absent = `least-loaded`.
   */
  readonly policy?: SessionPlacementPolicy
  /**
   * Memory of recent share elections. Sessions that never overlap leave every
   * device at 0 running, so without it the key order wins every election.
   * Needs `historyScope` (the node id): two nodes may both own a `cpu`.
   */
  readonly shareHistory?: ShareElectionHistory
  readonly historyScope?: string
  /**
   * The device this camera's previous session ran on, on this node (D916).
   * Under `share` it is kept while within one session of the turn holder and
   * offered here (enabled ∧ available — a device in backoff is not offered),
   * not capped and not drowning. Unlike `currentDeviceKey` it never freezes a
   * camera: once the device is more than a session over its share it moves.
   */
  readonly previousDeviceKey?: string | null
}

/** What the camera's affinity did in a share election (D916). */
export interface InferenceDeviceAffinity {
  readonly sticky: boolean
  readonly reason: ShareAffinityReason
  readonly previousDeviceKey: string | null
  /** The device the plain share rule would have elected. */
  readonly turnKey: string | null
}

/** Why a deviceKey was elected. */
export type InferenceDeviceReason = 'pin' | 'capacity' | 'tie-break' | 'share'

/** How a tie among equally-scored devices was resolved. */
export type InferenceDeviceTieBreak =
  /** The camera is already placed on one of the tied devices — kept (idempotence). */
  | 'sticky'
  /** Round-robin across the tied set. */
  | 'rotation'
  /** No rotation injected — first key by sort order (deterministic, not fair). */
  | 'lexicographic'

/** Why NO deviceKey was elected and the runner's default pool serves the camera. */
export type InferenceDeviceDefaultReason =
  /** The node reported no enabled∧available device that can host a camera root. */
  | 'no-eligible-device'
  /** Exactly one eligible device and no pin — the default pool already IS it. */
  | 'single-eligible-device'
  /** A pin exists but the pinned device is at/over its `maxSessions` cap. */
  | 'pin-unplaceable'
  /** Every eligible device is at/over its `maxSessions` cap. */
  | 'all-devices-at-cap'

/** A deviceKey was elected for this camera. */
export interface InferenceDeviceSelected {
  readonly kind: 'selected'
  readonly deviceKey: string
  readonly reason: InferenceDeviceReason
  /** Set only when `reason === 'tie-break'`. */
  readonly tieBreak: InferenceDeviceTieBreak | null
  /** Every device that entered the decision, sorted. */
  readonly eligibleKeys: readonly string[]
  /** The devices the capacity tier could not separate (equal weighted score). */
  readonly tiedKeys: readonly string[]
  /** Set by the `share` path only. */
  readonly affinity?: InferenceDeviceAffinity
}

/** No deviceKey elected — the runner's default accelerator serves the camera. */
export interface InferenceDeviceDefaulted {
  readonly kind: 'default-pool'
  readonly reason: InferenceDeviceDefaultReason
  readonly eligibleKeys: readonly string[]
}

export type InferenceDeviceSelection = InferenceDeviceSelected | InferenceDeviceDefaulted

/** Synthesize a `RunnerLocalLoad` for one device so `balance()` scores it. */
function deviceAsLoad(deviceKey: string, load?: DeviceLoadInput): RunnerLocalLoad {
  return {
    nodeId: deviceKey,
    attachedCameras: load?.attachedCameras ?? 0,
    activeCameras: 0,
    avgInferenceFps: 0,
    avgInferenceTimeMs: 0,
    // The device tier has no queue-depth measurement (D762): its pressure
    // signal is the pool's `inFlight` against `inFlightCap`, judged by
    // `isDeviceSaturated`, not this node-tier term.
    queueDepthTotal: 0,
    devices: [],
    hardware: { hasGpu: false },
  }
}

/**
 * Elect the inference device for one camera on one node.
 *
 * Order (each step short-circuits): pin → capacity → fair tie-break. A pin is
 * still resolved by `balance()`'s L1 and is never overridden here; caps are
 * still enforced by `balance()` and by {@link rankCandidates}, which sees the
 * same input. Only the head-of-list TIE — the case where nothing in the load
 * signal separates two devices — is decided by this function.
 */
export function pickInferenceDevice(input: PickInferenceDeviceInput): InferenceDeviceSelection {
  const eligibleKeys = Object.keys(input.eligible).toSorted()
  if (eligibleKeys.length === 0) {
    return { kind: 'default-pool', reason: 'no-eligible-device', eligibleKeys }
  }
  const pin = input.pinnedDeviceKey ?? null
  // One eligible accelerator and no explicit device pin ⇒ nothing to balance;
  // leave `deviceKey` unset so the runner's default pool serves it.
  if (eligibleKeys.length === 1 && !pin) {
    return { kind: 'default-pool', reason: 'single-eligible-device', eligibleKeys }
  }

  const loadByKey = new Map((input.loads ?? []).map((l) => [l.deviceKey, l]))

  // A drowning device is stepped over BEFORE capacity is weighed — capacity
  // counts sessions, and a device whose pool queue is pinned at its shed cap
  // has capacity by that measure while answering nothing. Never step over ALL
  // of them: when every eligible device is saturated there is no better place
  // to go, and excluding the set would silently disable the accelerator tier.
  // A pinned device is honoured regardless: a pin is an operator statement.
  const healthyKeys = eligibleKeys.filter((k) => !isDeviceSaturated(loadByKey.get(k)))
  const consideredKeys =
    pin !== null || healthyKeys.length === 0 || healthyKeys.length === eligibleKeys.length
      ? eligibleKeys
      : healthyKeys

  if (input.policy === 'share' && pin === null) {
    const history = input.historyScope !== undefined ? input.shareHistory : undefined
    const historyScope = input.historyScope ?? ''
    const outcome = electByShareWithAffinity(
      eligibleKeys.map((key) => {
        const load = loadByKey.get(key)
        const attached = load?.attachedCameras ?? 0
        const cap = input.caps?.[key]
        const hasCap = cap !== null && cap !== undefined && cap > 0
        return {
          key,
          share: input.eligible[key] ?? 1,
          running: attached,
          ...(history !== undefined ? { recent: history.recent(historyScope, key) } : {}),
          capped: hasCap && attached >= cap,
          saturated: isDeviceSaturated(load),
          ...(hasCap ? { spare: Math.max(0, cap - attached) } : {}),
        }
      }),
      input.previousDeviceKey ?? null,
    )
    const election = outcome.election
    if (election.kind === 'none') {
      return { kind: 'default-pool', reason: 'all-devices-at-cap', eligibleKeys }
    }
    history?.noteElected(historyScope, election.key)
    return {
      kind: 'selected',
      deviceKey: election.key,
      reason: 'share',
      tieBreak: null,
      eligibleKeys,
      tiedKeys: [election.key],
      affinity: {
        sticky: outcome.sticky,
        reason: outcome.affinityReason,
        previousDeviceKey: outcome.previousKey,
        turnKey: outcome.turnKey,
      },
    }
  }

  const balancerInput: BalancerInput = {
    nodes: consideredKeys.map((k) => deviceAsLoad(k, loadByKey.get(k))),
    preferredAgent: pin,
    weights: input.eligible,
    nodeCaps: input.caps,
    eligibleNodes: consideredKeys,
  }

  const decision = balance(balancerInput)
  if (!decision || decision.kind !== 'assigned') {
    // `balance()` returns `pending` only from its L1 branch (the pinned device
    // is at/over cap) or when every candidate is capped — distinguish the two
    // so the dispatch log names the real reason the accelerator was skipped.
    return {
      kind: 'default-pool',
      reason: pin ? 'pin-unplaceable' : 'all-devices-at-cap',
      eligibleKeys,
    }
  }
  if (decision.reason === 'manual') {
    return {
      kind: 'selected',
      deviceKey: decision.agentNodeId,
      reason: 'pin',
      tieBreak: null,
      eligibleKeys,
      tiedKeys: [decision.agentNodeId],
    }
  }

  // Capacity tier. Re-rank to see whether the winner actually WON or merely
  // sorted first among equals — the distinction the old code never made.
  const ranked = rankCandidates(balancerInput)
  const bestSortKey = ranked[0]!.sortKey
  const tiedKeys = ranked.filter((c) => c.sortKey === bestSortKey).map((c) => c.nodeId)
  if (tiedKeys.length === 1) {
    return {
      kind: 'selected',
      deviceKey: ranked[0]!.nodeId,
      reason: 'capacity',
      tieBreak: null,
      eligibleKeys,
      tiedKeys,
    }
  }

  // Idempotence FIRST: a camera already running on one of the tied devices
  // stays there, and does not consume a rotation slot.
  const current = input.currentDeviceKey ?? null
  if (current !== null && tiedKeys.includes(current)) {
    return {
      kind: 'selected',
      deviceKey: current,
      reason: 'tie-break',
      tieBreak: 'sticky',
      eligibleKeys,
      tiedKeys,
    }
  }

  const rotation = input.rotation
  return {
    kind: 'selected',
    deviceKey: rotation ? rotation.next(tiedKeys) : tiedKeys[0]!,
    reason: 'tie-break',
    tieBreak: rotation ? 'rotation' : 'lexicographic',
    eligibleKeys,
    tiedKeys,
  }
}

/** The elected deviceKey, or `undefined` when the runner's default pool serves it. */
export function selectedDeviceKey(selection: InferenceDeviceSelection): string | undefined {
  return selection.kind === 'selected' ? selection.deviceKey : undefined
}
