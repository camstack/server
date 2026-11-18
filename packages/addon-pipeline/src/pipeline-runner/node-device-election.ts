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
import type { ModelFormat, NodeInferenceDevices, PipelineEngineChoice } from '@camstack/types'

export type NodeDeviceChoice =
  /** Nothing is known to be excluded (or the view is unreadable): the node default serves, as before. */
  | { readonly kind: 'default' }
  /** An eligible device: run on it, EXPLICITLY. */
  | { readonly kind: 'device'; readonly deviceKey: string; readonly format: ModelFormat }
  /** Every device is off or not functional: nothing may run. */
  | { readonly kind: 'none-eligible'; readonly detail: string }

/**
 * The key the orchestrator's probe gives the device an engine runs on
 * (`types/src/inference/runtime-capabilities.ts`: `backend === 'cpu' ? 'cpu' :
 * '<backend>:<device>'`). `deviceKeyOf` would say `cpu:cpu` for the CPU engine
 * `resolveDeviceEngine('cpu')` builds, which is never a probe key.
 */
export function probeKeyOfEngine(engine: PipelineEngineChoice): string {
  if (engine.backend === 'cpu') return 'cpu'
  return engine.device ? `${engine.backend}:${engine.device}` : engine.backend
}

/**
 * `view` null = the read failed, which changes nothing (D49). With the node's
 * default engine key KNOWN, it keeps serving while it is eligible; otherwise an
 * eligible device is named (or the work is refused when there is none). With
 * the key UNKNOWN the default keeps serving unless the orchestrator says it is
 * EXCLUDED (`defaultPoolExcluded === true`): a healthy node never switches to
 * its heaviest device just because the runner could not name its engine.
 */
export function chooseNodeDevice(
  view: NodeInferenceDevices | null,
  defaultKey?: string,
): NodeDeviceChoice {
  if (view === null || !view.reachable) return { kind: 'default' }
  if (defaultKey === undefined && view.defaultPoolExcluded !== true) return { kind: 'default' }
  const eligible = view.devices
    .filter((d) => d.exclusion === null)
    .toSorted((a, b) => b.weight - a.weight || a.key.localeCompare(b.key))
  if (defaultKey !== undefined && eligible.some((d) => d.key === defaultKey)) {
    return { kind: 'default' }
  }
  const best = eligible[0]
  if (best !== undefined) return { kind: 'device', deviceKey: best.key, format: best.format }
  if (view.defaultPoolExcluded !== true) return { kind: 'default' }
  return {
    kind: 'none-eligible',
    detail: `node "${view.nodeId}" has no eligible inference device — every one is turned off in load balancing or not functional, and its default engine is one of them`,
  }
}
