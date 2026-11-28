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
import type { ModelFormat, NodeInferenceDevices } from '@dominevo/types'

export type NodeDeviceChoice =
  /** Nothing is known to be excluded (or the view is unreadable): the node default serves, as before. */
  | { readonly kind: 'default' }
  /** An eligible device: run on it, EXPLICITLY. */
  | { readonly kind: 'device'; readonly deviceKey: string; readonly format: ModelFormat }
  /** Every device is off or not functional: nothing may run. */
  | { readonly kind: 'none-eligible'; readonly detail: string }

/**
 * `view` null = the read failed, which changes nothing (D49). The node default
 * keeps serving unless the orchestrator says the node's default ENGINE device is
 * excluded (`defaultPoolExcluded === true` — decided from the node's selected
 * engine, independent of how many other devices are eligible). Then the best
 * eligible device is named, or the work is refused when there is none.
 */
export function chooseNodeDevice(view: NodeInferenceDevices | null): NodeDeviceChoice {
  if (view === null || !view.reachable || view.defaultPoolExcluded !== true) {
    return { kind: 'default' }
  }
  const best = view.devices
    .filter((d) => d.exclusion === null)
    .toSorted((a, b) => b.weight - a.weight || a.key.localeCompare(b.key))[0]
  if (best !== undefined) return { kind: 'device', deviceKey: best.key, format: best.format }
  return {
    kind: 'none-eligible',
    detail: `node "${view.nodeId}" has no eligible inference device — every one is turned off in load balancing or not functional, and its default engine is one of them`,
  }
}
