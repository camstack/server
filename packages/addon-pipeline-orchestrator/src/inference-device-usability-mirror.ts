/**
 * InferenceDeviceUsabilityMirror — "can this NODE's THIS DEVICE still infer?",
 * kept off the placement path.
 *
 * The per-`(nodeId, deviceKey)` twin of {@link NodeInferenceUsabilityMirror},
 * and deliberately not a second mechanism: it composes the key and delegates
 * every decision to that class, so the arm/apply reluctance D49 pinned lives in
 * exactly one implementation and cannot drift between the node tier and the
 * device tier.
 *
 * ## Why this tier had to exist
 *
 * The node tier already answers "does this node have ANY usable accelerator".
 * On 2026-08-25 the hub's answer was, correctly, yes — its NPU was healthy the
 * whole time. What died was one DEVICE, `openvino:gpu`, and nothing anywhere
 * asked that question: the per-dispatch capability gate is keyed on model
 * FORMAT and `openvino:gpu` and `openvino:npu` share the format `openvino`, so
 * it is blind between them by construction. The balancer kept rotating cameras
 * onto the dead pool — 20 sessions in 20 minutes, every one `tieBreak:
 * "rotation"` — for 31 hours.
 *
 * ## Why a mirror and not the event
 *
 * D49, verbatim: *a one-shot event never gates on a fallible read*. The gate is
 * this in-memory mirror, refreshed off the event path by the same
 * `resolveEligibleInferenceDevices` the dispatcher already runs (plus the
 * session controller's background refresher). The consequences that buys:
 *
 *  - **A read that fails changes nothing.** The caller folds in an observation
 *    only when it HAS one; an unreachable node, a version-skewed executor or a
 *    rejected RPC never reaches {@link observe}, so the previous verdict
 *    stands. This is the whole reason the health read is specified as
 *    "synchronous over in-memory state, never throws for its own reasons": an
 *    empty answer must mean *nothing is refused*, not *I could not tell*.
 *  - **Excluding a healthy device needs a second, consecutive read.** Exclusion
 *    is the direction that DESTROYS work — it strands an accelerator that may
 *    be perfectly fine — so one bad observation only ARMS.
 *  - **Re-admitting is immediate and unconditional.** One good observation puts
 *    the device straight back. Being slow to exclude costs some wasted
 *    inference attempts; being slow to re-admit costs an idle accelerator and a
 *    node that looks broken.
 */
import {
  NodeInferenceUsabilityMirror,
  type NodeUsabilityTransition,
} from './node-inference-usability-mirror.js'

/** One excluded `(nodeId, deviceKey)` pair. */
export interface UnusableInferenceDevice {
  readonly nodeId: string
  readonly deviceKey: string
}

/**
 * NUL — impossible in both a Moleculer node id and a `<backend>:<device>` key,
 * so the composite key can never be ambiguous. A separator that CAN occur in
 * either half makes two distinct pairs collide, and a collision here silently
 * excludes an accelerator nobody reported.
 */
const SEPARATOR = '\u0000'

export class InferenceDeviceUsabilityMirror {
  /** The one implementation of the arm/apply state machine (D49). */
  private readonly mirror = new NodeInferenceUsabilityMirror()

  /**
   * Fold one observation in and report whether the caller should act.
   * Never throws.
   */
  observe(nodeId: string, deviceKey: string, usable: boolean): NodeUsabilityTransition {
    return this.mirror.observe(`${nodeId}${SEPARATOR}${deviceKey}`, usable)
  }

  /** Can the balancer put a session on this device? Unknown pairs answer YES. */
  isUsable(nodeId: string, deviceKey: string): boolean {
    return this.mirror.isUsable(`${nodeId}${SEPARATOR}${deviceKey}`)
  }

  /** Pairs currently excluded — for the placement log and diagnostics. */
  unusableDevices(): readonly UnusableInferenceDevice[] {
    return this.mirror.unusableNodeIds().map((composite) => {
      const at = composite.indexOf(SEPARATOR)
      return { nodeId: composite.slice(0, at), deviceKey: composite.slice(at + 1) }
    })
  }

  /** The excluded device keys on ONE node. */
  unusableDeviceKeys(nodeId: string): readonly string[] {
    return this.unusableDevices()
      .filter((d) => d.nodeId === nodeId)
      .map((d) => d.deviceKey)
  }

  forget(nodeId: string, deviceKey: string): void {
    this.mirror.forget(`${nodeId}${SEPARATOR}${deviceKey}`)
  }

  reset(): void {
    this.mirror.reset()
  }
}

/** One `(deviceKey, transition)` the caller should log. */
export interface InferenceDeviceUsabilityChange {
  readonly deviceKey: string
  readonly transition: Exclude<NodeUsabilityTransition, null>
}

/**
 * Fold ONE node's health answer into the mirror and return what changed.
 *
 * This is the whole reading discipline, in one place, because both halves of it
 * are easy to get subtly wrong and neither failure is visible in a log:
 *
 *  - **`unhealthy === null` — the read FAILED — changes nothing.** Not a single
 *    entry is touched. An unreachable node, a version-skewed executor or a
 *    rejected RPC must be distinguishable from "asked, nothing is refused", or
 *    a flaky link silently re-admits a dead accelerator (D49).
 *  - **Every device the node HAS is observed**, not merely the refused ones.
 *    The first draft observed `refused ∪ already-excluded`, which omits exactly
 *    the devices the mirror has ARMED — so their disarming good read never
 *    arrived and two bad reads an HOUR apart, with a hundred healthy ones
 *    between them, excluded a working accelerator. "Consecutive" is only a
 *    property if the good observations are delivered.
 *
 * Pure with respect to everything except `mirror`, and never throws — it is
 * called from the dispatcher's own read path.
 */
export function foldInferenceDeviceHealth(
  mirror: InferenceDeviceUsabilityMirror,
  nodeId: string,
  unhealthy: readonly string[] | null,
  present: readonly string[],
): readonly InferenceDeviceUsabilityChange[] {
  if (unhealthy === null) return []
  const refused = new Set(unhealthy)
  const observed = new Set<string>([
    ...present,
    ...refused,
    // Anything the mirror still holds against this node even though the
    // hardware probe no longer lists it — otherwise that entry never gets
    // another observation and is stuck excluded forever.
    ...mirror.unusableDeviceKeys(nodeId),
  ])
  const changes: InferenceDeviceUsabilityChange[] = []
  for (const deviceKey of observed) {
    const transition = mirror.observe(nodeId, deviceKey, !refused.has(deviceKey))
    if (transition !== null) changes.push({ deviceKey, transition })
  }
  return changes
}
