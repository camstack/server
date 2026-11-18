/**
 * Pure read model of the step switch matrix (`getStepSwitches`).
 *
 * The orchestrator computes every cell with the placement function the attach
 * path runs; this file only NAMES what a cell means and which level turned a
 * step off, so the three surfaces (cluster mode, node switch, accelerator
 * switch) say the same thing. A client never re-derives a cell, and a node or
 * a query that did not answer is `unknown` — never "off" (an unanswered read is
 * not an empty answer).
 */
import type { StepSwitchCell, StepSwitchMatrix } from '@camstack/types'

export type StepSwitchRow = StepSwitchMatrix['steps'][number]
export type StepSwitchNode = StepSwitchRow['nodes'][number]
export type StepSwitchDevice = StepSwitchNode['devices'][number]

/** Which level turned a step off. `opt-in` = cluster mode opt-in and no camera enabled it. */
export type OffLevel = 'cluster' | 'node' | 'device' | 'opt-in' | 'model'

/** How a step that runs gets to run. */
export type OnVia = 'direct' | 'jump' | 'root' | 'zone'

export type StepEffect =
  | { readonly state: 'on'; readonly via: OnVia; readonly toDeviceKey?: string }
  | { readonly state: 'off'; readonly level: OffLevel }
  | { readonly state: 'unknown' }

/** What the operator reads first when several devices are off for different reasons. */
const OFF_LEVEL_PRIORITY: readonly OffLevel[] = ['cluster', 'node', 'device', 'opt-in', 'model']

/** The effect of one matrix cell. */
export function cellEffect(cell: StepSwitchCell): StepEffect {
  switch (cell.kind) {
    case 'on':
      return { state: 'on', via: 'direct' }
    case 'jump':
      return { state: 'on', via: 'jump', toDeviceKey: cell.toDeviceKey }
    case 'supplied-by-root':
      return { state: 'on', via: 'root' }
    case 'zone-driven':
      return { state: 'on', via: 'zone' }
    case 'off-cluster':
      return { state: 'off', level: 'cluster' }
    case 'off-node':
      return { state: 'off', level: 'node' }
    case 'off-device':
      return { state: 'off', level: 'device' }
    case 'opt-in-unused':
      return { state: 'off', level: 'opt-in' }
    case 'skip':
      return { state: 'off', level: 'model' }
  }
}

/** The effect on one accelerator row. */
export function deviceEffect(device: StepSwitchDevice): StepEffect {
  return cellEffect(device.cell)
}

/**
 * The effect on a node: on when any of its devices runs the step, off (naming
 * the highest-precedence level) when every device is off, unknown when the node
 * did not answer or reports no device — nothing is claimed then.
 */
export function nodeEffect(node: StepSwitchNode): StepEffect {
  if (!node.reachable || node.devices.length === 0) return { state: 'unknown' }
  const effects = node.devices.map(deviceEffect)
  const running = effects.find((e) => e.state === 'on')
  if (running !== undefined) return running
  for (const level of OFF_LEVEL_PRIORITY) {
    if (effects.some((e) => e.state === 'off' && e.level === level)) return { state: 'off', level }
  }
  return { state: 'unknown' }
}

/** The node's entry in a step row, or undefined when the matrix has none for it. */
export function findNode(row: StepSwitchRow, nodeId: string): StepSwitchNode | undefined {
  return row.nodes.find((n) => n.nodeId === nodeId)
}

/** One accelerator of a node in a step row, or undefined when the matrix has none. */
export function findDevice(
  row: StepSwitchRow,
  nodeId: string,
  deviceKey: string,
): StepSwitchDevice | undefined {
  return findNode(row, nodeId)?.devices.find((d) => d.deviceKey === deviceKey)
}

/** The control a switch belongs to: it can be held off only by a level above it. */
export type OwnLevel = 'node' | 'device'

/** The level above `ownLevel` that holds the step off, or null when none does. */
export function heldOffBy(
  effect: StepEffect | null,
  ownLevel: OwnLevel,
): 'cluster' | 'node' | null {
  if (effect === null || effect.state !== 'off') return null
  if (effect.level === 'cluster') return 'cluster'
  if (ownLevel === 'device' && effect.level === 'node') return 'node'
  return null
}
