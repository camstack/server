/**
 * The pure half of `SourceSelector` with `intent: 'action'`: which commands a
 * target offers, which devices offer a command, and what survives switching
 * between "By device" and "By action".
 *
 * Everything here is computed from ONE answer — every listed device's bound
 * caps (`getBindingsBatch`) — through the cap vocabulary (D920). A device
 * offers an action when one of its bindings provides the action's cap.
 */
import { REPEAT_ITEM_VAR, vocabularyActionsForDevice } from '@camstack/types'
import type { ActionTarget, ResolvedVocabAction } from '@camstack/types'

/** The variable a run binds to the device that triggered it. */
export const TRIGGER_DEVICE_VAR = 'deviceId'

export interface ActionFleetDevice {
  readonly id: number
  readonly type?: string
  /** The caps the device's bindings provide; unknown until answered. */
  readonly caps: readonly string[]
}

/** What a selector-side variable target stands for. */
export interface ActionTargetContext {
  /** The devices of the repeat around the step; absent outside such a loop. */
  readonly roundDevices?: readonly number[]
}

export type ActionPickMode = 'by-device' | 'by-action'

/** The commands one device offers, in vocabulary order. */
export function deviceActions(device: ActionFleetDevice): readonly ResolvedVocabAction[] {
  return vocabularyActionsForDevice(device.caps, device.type)
}

/**
 * The commands EVERY one of these action lists offers, keyed by action id. With
 * more than one list, a command whose argument is answered per device (a
 * `dynamic` offer: one device's presets are not another's) is left out.
 */
export function intersectActions(
  lists: readonly (readonly ResolvedVocabAction[])[],
): readonly ResolvedVocabAction[] {
  const [first, ...rest] = lists
  if (first === undefined) return []
  const others = rest.map((actions) => new Set(actions.map((a) => a.id)))
  return first.filter(
    (action) =>
      others.every((ids) => ids.has(action.id)) && (rest.length === 0 || !hasDynamicArg(action)),
  )
}

function hasDynamicArg(action: ResolvedVocabAction): boolean {
  return action.openArgs.some((arg) => arg.offer.kind === 'dynamic')
}

/** Every command at least one device of the fleet offers, once each. */
export function fleetActions(fleet: readonly ActionFleetDevice[]): readonly ResolvedVocabAction[] {
  const byId = new Map<string, ResolvedVocabAction>()
  for (const device of fleet) {
    for (const action of deviceActions(device)) {
      if (!byId.has(action.id)) byId.set(action.id, action)
    }
  }
  return [...byId.values()]
}

/** The devices of the fleet that offer `actionId`. */
export function devicesOffering(
  fleet: readonly ActionFleetDevice[],
  actionId: string,
): readonly ActionFleetDevice[] {
  return fleet.filter((device) => deviceActions(device).some((a) => a.id === actionId))
}

function byId(fleet: readonly ActionFleetDevice[], id: number): ActionFleetDevice {
  return fleet.find((d) => d.id === id) ?? { id, caps: [] }
}

/**
 * The commands a target offers:
 *  - devices: the intersection of the devices' commands;
 *  - the device that triggered the run: unknown until it runs, so every
 *    command the fleet offers, minus those answered per device;
 *  - the device of the round: the intersection over the loop's devices.
 * Anything else (a domain, another variable) offers nothing here.
 */
export function targetActions(
  fleet: readonly ActionFleetDevice[],
  target: ActionTarget | null,
  context: ActionTargetContext,
): readonly ResolvedVocabAction[] {
  if (target === null) return []
  if (target.kind === 'devices') {
    if (target.ids.length === 0) return []
    return intersectActions(target.ids.map((id) => deviceActions(byId(fleet, id))))
  }
  if (target.kind === 'var' && target.name === TRIGGER_DEVICE_VAR) {
    return fleetActions(fleet).filter((a) => !hasDynamicArg(a))
  }
  if (target.kind === 'var' && target.name === REPEAT_ITEM_VAR) {
    const ids = context.roundDevices ?? []
    if (ids.length === 0) return []
    return intersectActions(ids.map((id) => deviceActions(byId(fleet, id))))
  }
  return []
}

export interface ActionCapGroup {
  readonly cap: string
  readonly actions: readonly ResolvedVocabAction[]
}

/** The commands grouped by cap, groups in first-seen order. */
export function groupActionsByCap(
  actions: readonly ResolvedVocabAction[],
): readonly ActionCapGroup[] {
  const groups = new Map<string, ResolvedVocabAction[]>()
  for (const action of actions) {
    groups.set(action.cap, [...(groups.get(action.cap) ?? []), action])
  }
  return [...groups.entries()].map(([cap, list]) => ({ cap, actions: list }))
}

/** Case- and accent-insensitive match of a query against a command's label or phrase. */
export function matchesActionQuery(
  action: ResolvedVocabAction,
  locale: 'en' | 'it',
  capTitle: string,
  query: string,
): boolean {
  const q = fold(query.trim())
  if (q === '') return true
  return [action.label[locale], action.phrase[locale], capTitle, action.id].some((text) =>
    fold(text).includes(q),
  )
}

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

/** Toggle a device in a multi-device target; the last one out leaves no target. */
export function toggleTargetDevice(target: ActionTarget | null, id: number): ActionTarget | null {
  const ids = target?.kind === 'devices' ? target.ids : []
  const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]
  return next.length === 0 ? null : { kind: 'devices', ids: next }
}

/** The device ids a target names (none for a variable). */
export function targetDeviceIds(target: ActionTarget | null): readonly number[] {
  return target?.kind === 'devices' ? target.ids : []
}

/**
 * What survives a switch of mode or a new target: the command stays when the
 * target still offers it, else it is dropped (and its args with it).
 */
export function keepCompatibleAction(
  fleet: readonly ActionFleetDevice[],
  target: ActionTarget | null,
  actionId: string | null,
  context: ActionTargetContext,
): string | null {
  if (actionId === null) return null
  return targetActions(fleet, target, context).some((a) => a.id === actionId) ? actionId : null
}

/**
 * In "By action", the devices are filtered to those offering the picked
 * command: a picked device that does not is dropped from the target.
 */
export function keepOfferingDevices(
  fleet: readonly ActionFleetDevice[],
  target: ActionTarget | null,
  actionId: string,
): ActionTarget | null {
  if (target?.kind !== 'devices') return target
  const offering = new Set(devicesOffering(fleet, actionId).map((d) => d.id))
  const ids = target.ids.filter((id) => offering.has(id))
  return ids.length === 0 ? null : { kind: 'devices', ids }
}
