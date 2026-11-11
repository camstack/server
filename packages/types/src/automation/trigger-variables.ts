/**
 * The variables an event row of a `when` tree puts in the run's bag — ONE list.
 *
 * The runtime (`codegen.ts`, from `decision.vars`) and the editor (the "{x}"
 * button of a step argument) both read it, so a variable the runtime provides
 * is a variable the editor offers. Each map is keyed by `keyof` the vars
 * interface the trigger returns: adding a field there without describing it
 * here does not compile.
 */
import type { DetectionVars } from './detection-trigger.js'
import type { DeviceFiredVars } from './fired-trigger.js'
import type { BecomesVars } from './hold.js'
import type { StationaryVars } from './stationary-trigger.js'
import type { AutomationWhen } from './when.js'
import { forEachLeaf, isEventLeaf } from './when.js'

export interface TriggerVariable {
  readonly name: string
  /** English hint; the editor translates it by `hintKey`, else by `name`. */
  readonly description: string
  /** Set when the same name means something else on another trigger kind. */
  readonly hintKey?: string
}

const DETECTION_DESCRIPTIONS: Readonly<Record<keyof DetectionVars, string>> = {
  deviceId: 'the camera that saw it',
  className: 'what it saw',
  trackId: 'the track',
  score: 'how sure the detector was',
  label: 'the label it matched (a name, a plate), empty when none',
}

const STATIONARY_DESCRIPTIONS: Readonly<Record<keyof StationaryVars, string>> = {
  deviceId: 'the camera that saw it',
  className: 'what it saw',
  zones: 'the zones it is in',
  phase: 'appeared or departed',
  entryId: 'the stopped object',
}

const BECOMES_DESCRIPTIONS: Readonly<Record<keyof BecomesVars, string>> = {
  deviceId: 'the device that changed',
  from: 'the value before the change, empty when it is not known',
  to: 'the value it changed to',
}

/**
 * A fire's payload is offered too, as `data.<path>` (`{{vars.data.channel}}`):
 * those names depend on the device, so they are not in this list.
 */
const FIRED_DESCRIPTIONS: Readonly<Record<keyof DeviceFiredVars, string>> = {
  deviceId: 'the device that fired',
  eventType: 'the event, as the device names it',
  sourceId: 'the part of the device that fired (a button), empty when it names none',
  eventKind: 'the kind of press (press, long-press …), empty when the device declares none',
}

function describe(descriptions: Readonly<Record<string, string>>): readonly TriggerVariable[] {
  return Object.entries(descriptions).map(([name, description]) => ({
    name,
    description,
  }))
}

const DETECTION_VARIABLES = describe(DETECTION_DESCRIPTIONS)
const STATIONARY_VARIABLES = describe(STATIONARY_DESCRIPTIONS)
const FIRED_VARIABLES: readonly TriggerVariable[] = describe(FIRED_DESCRIPTIONS).map((v) =>
  v.name === 'deviceId' ? { ...v, hintKey: 'firedDeviceId' } : v,
)
const BECOMES_VARIABLES: readonly TriggerVariable[] = describe(BECOMES_DESCRIPTIONS).map((v) =>
  v.name === 'deviceId' ? { ...v, hintKey: 'becomesDeviceId' } : v,
)

/** A name two trigger kinds describe differently, said for both (a camera, or a device that changed). */
const SHARED_VARIABLES: Readonly<Record<string, TriggerVariable>> = {
  deviceId: {
    name: 'deviceId',
    description: 'the device that started the run',
    hintKey: 'triggerDeviceId',
  },
}

/** What one event row kind provides; kinds that provide none are absent. */
export function triggerLeafVariables(kind: string): readonly TriggerVariable[] {
  if (kind === 'detection') return DETECTION_VARIABLES
  if (kind === 'stationary') return STATIONARY_VARIABLES
  if (kind === 'device-becomes') return BECOMES_VARIABLES
  if (kind === 'device-fired') return FIRED_VARIABLES
  return []
}

/**
 * What EVERY event row of the tree provides (the intersection by name), in the
 * first row's order. A tree with no event row, or with a row that provides
 * nothing, offers none — the editor hides the button rather than guess.
 */
export function triggerVariablesOf(when: AutomationWhen): readonly TriggerVariable[] {
  const perEvent: (readonly TriggerVariable[])[] = []
  forEachLeaf(when, (leaf) => {
    if (isEventLeaf(leaf)) perEvent.push(triggerLeafVariables(leaf.kind))
  })
  const [first, ...rest] = perEvent
  if (first === undefined) return []
  return first
    .filter((v) => rest.every((other) => other.some((o) => o.name === v.name)))
    .map((v) => {
      const sameMeaning = rest.every((other) =>
        other.some((o) => o.name === v.name && o.description === v.description),
      )
      return sameMeaning ? v : (SHARED_VARIABLES[v.name] ?? v)
    })
}
