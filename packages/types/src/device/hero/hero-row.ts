/**
 * The ROW of a device in a list (D1023 P2): four fixed zones, all taken from
 * the hero model and nothing else.
 *
 *   1. mini-scene   the same scene id as the hero, drawn 44x44 with the state look;
 *   2. name + ONE status line  the facts joined by " · " by the client;
 *   3. the type's primary inline control;
 *   4. a trailing fact (power, else battery, else consumables).
 *
 * Selection rules, all taken from the model:
 *   - the primary control is the device's own power; else the FIRST control of
 *     the FIRST row that has any (a later row's control is never promoted). When
 *     the model lists that part in `gated`, the row has no inline control: the
 *     projection never falls through to another control the caller could use.
 *   - a timed run, when the model carries the slot, sits beside that primary:
 *     Run while idle, Stop while armed. Gating the slot hides the control.
 *   - the status line is the head (what plays, else the state) plus at most
 *     {@link ROW_STATUS_FACTS_MAX} facts, the trailing fact excluded, then the
 *     time left on an armed timed run;
 *   - the trailing fact is the first of power, battery, consumables.
 *
 *   - `extras` are the further inline controls of the types that carry more than one
 *     ({@link ROW_EXTRAS_BY_TYPE}): climate mode and setpoint, a robot's return to base,
 *     a player's volume and remote. Each is a control the model already has, named by id,
 *     in that order and at most {@link ROW_EXTRAS_MAX}; one the model lacks, or lists in
 *     `gated`, is absent, and the one `primary` already is never repeats. Empty = the
 *     row of an older server: `primary` alone.
 *
 * `projectDeviceRow` is pure and computes nothing: it selects from a
 * {@link HeroModel}. A row that needed a value the hero lacks would mean the
 * model is missing it, so the fix goes in the model.
 */
import { z } from 'zod'
import { DeviceType } from '../device-type.js'
import {
  REMOTE_OPEN_ACTION_ID,
  HeroControlSchema,
  HeroFactSchema,
  type HeroControl,
  type HeroFact,
  type HeroModel,
} from './hero-model.js'
import { HeroSceneSchema } from './hero-scene.js'
import { StateLookSchema, HeroStateSchema } from './hero-state.js'
import { HeroTextSchema, type HeroText } from './hero-text.js'

/**
 * The row's timed-run control. `id` is `timed-run.run` while idle and
 * `timed-run.cancel` while armed; `duration` and `unit` are the one-tap run
 * a Run press starts.
 */
export const HeroRowTimedRunSchema = z.object({
  id: z.enum(['timed-run.run', 'timed-run.cancel']),
  duration: z.number(),
  unit: z.enum(['min', 's']),
})
export type HeroRowTimedRun = z.infer<typeof HeroRowTimedRunSchema>

export const HeroRowModelSchema = z.object({
  deviceId: z.number().int(),
  name: z.string(),
  type: z.string(),
  state: HeroStateSchema,
  stateAssumed: z.boolean(),
  look: StateLookSchema,
  scene: HeroSceneSchema,
  /** Joined by " · ": the state (or what is playing), then the facts. */
  statusLine: z.array(HeroTextSchema),
  /** `null` = the type has no inline control, or the caller may not act on it. */
  primary: HeroControlSchema.nullable(),
  /**
   * Beside `primary` when the device offers a timed run: Run while idle, Stop
   * while armed. `null` when there is no slot, or the caller may not act.
   */
  timedRun: HeroRowTimedRunSchema.nullable(),
  /**
   * The further inline controls after `primary`, in order (see the header). The remote
   * is an `action` with id `remote.open`: the client opens the remote, it does not run
   * the call. Absent or empty = `primary` alone.
   */
  extras: z.array(HeroControlSchema).max(2).optional(),
  trailing: HeroFactSchema.nullable(),
})
export type HeroRowModel = z.infer<typeof HeroRowModelSchema>

/** The most facts a row's status line carries after its head: the line never wraps. */
export const ROW_STATUS_FACTS_MAX = 3

/** The trailing fact, in order of preference. */
const TRAILING_ORDER: readonly HeroFact['id'][] = ['power', 'battery', 'consumables']

function trailingOf(facts: readonly HeroFact[]): HeroFact | null {
  for (const id of TRAILING_ORDER) {
    const found = facts.find((f) => f.id === id)
    if (found !== undefined) return found
  }
  return null
}

function primaryOf(model: HeroModel): HeroControl | null {
  const power = model.ownPower
  if (power !== null) {
    if (model.gated.includes('own-power')) return null
    return {
      kind: 'toggle',
      id: 'own-power',
      label: power.turnOn.label,
      on: power.on,
      turnOn: power.turnOn,
      turnOff: power.turnOff,
    }
  }
  for (const row of model.rows) {
    const control = row.controls[0]
    if (control === undefined) continue
    return model.gated.includes(row.id) ? null : control
  }
  return null
}

/** The most extra controls one row carries. */
export const ROW_EXTRAS_MAX = 2

/**
 * The extras of a type, by control id, in the order they are drawn. The ids are the
 * model's own: a `remote.open` is read from the model's remote slot, every other
 * from the rows. A type not listed has no extras.
 */
export const ROW_EXTRAS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  [DeviceType.Climate]: ['climate.mode', 'climate.target'],
  [DeviceType.Thermostat]: ['climate.mode', 'climate.target'],
  [DeviceType.Vacuum]: ['vacuum.base'],
  [DeviceType.LawnMower]: ['mower.dock'],
  [DeviceType.MediaPlayer]: ['volume.level', REMOTE_OPEN_ACTION_ID],
}

const controlId = (c: HeroControl): string => (c.kind === 'action' ? c.action.id : c.id)

function extraOf(model: HeroModel, id: string): HeroControl | null {
  if (id === REMOTE_OPEN_ACTION_ID) {
    const open = model.remote?.open
    if (open === undefined || model.gated.includes('remote')) return null
    return { kind: 'action', action: open }
  }
  for (const row of model.rows) {
    if (model.gated.includes(row.id)) continue
    const found = row.controls.find((c) => controlId(c) === id)
    if (found !== undefined) return found
  }
  return null
}

function extrasOf(model: HeroModel, primary: HeroControl | null): HeroControl[] {
  const ids = ROW_EXTRAS_BY_TYPE[model.type] ?? []
  const taken = primary === null ? null : controlId(primary)
  return ids
    .filter((id) => id !== taken)
    .flatMap((id) => {
      const found = extraOf(model, id)
      return found === null ? [] : [found]
    })
    .slice(0, ROW_EXTRAS_MAX)
}

function statusLineOf(model: HeroModel, trailing: HeroFact | null): HeroText[] {
  const playing = model.rows.find((r) => r.id === 'now-playing')?.status ?? null
  const head = playing ?? model.title
  const rest = model.facts
    .filter((f) => f !== trailing)
    .map((f) => f.text)
    .slice(0, ROW_STATUS_FACTS_MAX)
  const slot = model.timedRun
  if (slot === null || slot.remaining === null) return [head, ...rest]
  const word = slot.quickRun.unit === 'min' ? 'min' : 's'
  const left: HeroText = {
    en: `${slot.remaining} ${word}`,
    it: `${slot.remaining} ${word}`,
  }
  return [head, ...rest, left]
}

/** Run while the slot is idle, Stop while it is armed. Hidden when the caller may not act. */
function timedRunOf(model: HeroModel): HeroRowTimedRun | null {
  const slot = model.timedRun
  if (slot === null || model.gated.includes('timed-run')) return null
  return {
    id: slot.activeUntil === null ? 'timed-run.run' : 'timed-run.cancel',
    duration: slot.quickRun.duration,
    unit: slot.quickRun.unit,
  }
}

export function projectDeviceRow(model: HeroModel): HeroRowModel {
  const trailing = trailingOf(model.facts)
  const primary = primaryOf(model)
  return {
    deviceId: model.deviceId,
    name: model.name,
    type: model.type,
    state: model.state,
    stateAssumed: model.stateAssumed,
    look: model.look,
    scene: model.scene,
    statusLine: statusLineOf(model, trailing),
    primary,
    timedRun: timedRunOf(model),
    extras: extrasOf(model, primary),
    trailing,
  }
}
