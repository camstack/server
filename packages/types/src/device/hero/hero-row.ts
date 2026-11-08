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
 *   - ONE control is ever shown: the device's own power; else the FIRST control of
 *     the FIRST row that has any (a later row's control is never promoted). When
 *     the model lists that part in `gated`, the row has no inline control: the
 *     projection never falls through to another control the caller could use.
 *   - the status line is the head (what plays, else the state) plus at most
 *     {@link ROW_STATUS_FACTS_MAX} facts, the trailing fact excluded;
 *   - the trailing fact is the first of power, battery, consumables.
 *
 * `projectDeviceRow` is pure and computes nothing: it selects from a
 * {@link HeroModel}. A row that needed a value the hero lacks would mean the
 * model is missing it, so the fix goes in the model.
 */
import { z } from 'zod'
import {
  HeroControlSchema,
  HeroFactSchema,
  type HeroControl,
  type HeroFact,
  type HeroModel,
} from './hero-model.js'
import { HeroSceneSchema } from './hero-scene.js'
import { StateLookSchema, HeroStateSchema } from './hero-state.js'
import { HeroTextSchema, type HeroText } from './hero-text.js'

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

function statusLineOf(model: HeroModel, trailing: HeroFact | null): HeroText[] {
  const playing = model.rows.find((r) => r.id === 'now-playing')?.status ?? null
  const head = playing ?? model.title
  const rest = model.facts
    .filter((f) => f !== trailing)
    .map((f) => f.text)
    .slice(0, ROW_STATUS_FACTS_MAX)
  return [head, ...rest]
}

export function projectDeviceRow(model: HeroModel): HeroRowModel {
  const trailing = trailingOf(model.facts)
  return {
    deviceId: model.deviceId,
    name: model.name,
    type: model.type,
    state: model.state,
    stateAssumed: model.stateAssumed,
    look: model.look,
    scene: model.scene,
    statusLine: statusLineOf(model, trailing),
    primary: primaryOf(model),
    trailing,
  }
}
