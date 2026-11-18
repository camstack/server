/**
 * Which device an UNPINNED piece of work (a stateless step, a bench with no
 * `deviceKey`) runs on — decided from the orchestrator's own view of the node
 * (`getNodeInferenceDevices`), never from the runner's default pool.
 *
 * The default pool is the node's selected engine. It knows neither the
 * operator's "off" in load balancing nor a device that is down, so it can be
 * exactly the device the election excluded (#610). Pure: the caller reads the
 * view and acts on the answer.
 */
import type { ModelFormat, NodeInferenceDevices } from '@camstack/types'

export type NodeDeviceChoice =
  /** Nothing is known to be excluded (or the view is unreadable): the node default serves, as before. */
  | { readonly kind: 'default' }
  /** An eligible device: run on it, EXPLICITLY. */
  | { readonly kind: 'device'; readonly deviceKey: string; readonly format: ModelFormat }
  /** Every device is off or not functional: nothing may run. */
  | { readonly kind: 'none-eligible'; readonly detail: string }

/**
 * `view` null = the read failed, which changes nothing (D49). `defaultKey` is
 * the device key of the node's selected engine when known: when it is itself
 * eligible the node default is fine and keeps serving (no change of path for
 * the healthy node); otherwise an eligible device is named explicitly.
 */
export function chooseNodeDevice(
  view: NodeInferenceDevices | null,
  defaultKey?: string,
): NodeDeviceChoice {
  if (view === null || !view.reachable) return { kind: 'default' }
  const eligible = view.devices
    .filter((d) => d.exclusion === null)
    .toSorted((a, b) => b.weight - a.weight || a.key.localeCompare(b.key))
  const best = eligible[0]
  if (defaultKey !== undefined && eligible.some((d) => d.key === defaultKey)) {
    return { kind: 'default' }
  }
  if (best !== undefined) return { kind: 'device', deviceKey: best.key, format: best.format }
  if (view.defaultPoolExcluded === true) {
    return {
      kind: 'none-eligible',
      detail: `node "${view.nodeId}" has no eligible inference device — every one is turned off in load balancing or not functional, and its default engine is one of them`,
    }
  }
  return { kind: 'default' }
}
