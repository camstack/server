import { DeviceRole, DeviceType } from '../../device-type.js'
import { buildHeroModel } from '../build-hero-model.js'
import type { HeroAction, HeroControl, HeroModel, HeroRow } from '../hero-model.js'

export const NOW = 1_700_000_000_000

/**
 * A plug-in heater as the fixtures name it: a `switch` with role
 * `switch-heater` (D1033). `kindOf` turns it into the pair the model reads.
 */
export const PLUG_HEATER = 'switch+switch-heater'

/** A device's type and role, the plug-in heater token unfolded. */
export interface FixtureKind {
  readonly type: string
  readonly role: string | null
}

export function kindOf(type: string, role: string | null): FixtureKind {
  return type === PLUG_HEATER
    ? { type: DeviceType.Switch, role: DeviceRole.SwitchHeater }
    : { type, role }
}

export function build(
  type: string,
  caps: readonly string[],
  slices: Record<string, unknown> = {},
  features: readonly string[] = [],
  online = true,
): HeroModel {
  return buildHeroModel({
    device: { id: 7, ...kindOf(type, null), name: 'Dev', online },
    caps,
    features,
    slices,
    now: NOW,
    remoteCommands: null,
    access: { canActuate: true },
  })
}

export function rowOf(m: HeroModel, id: HeroRow['id']): HeroRow {
  const r = m.rows.find((x) => x.id === id)
  if (r === undefined) throw new Error(`no row ${id}`)
  return r
}

/** Every action a row offers, toggles flattened to their two sides. */
export function actionsOf(controls: readonly HeroControl[]): HeroAction[] {
  return controls.flatMap((c) =>
    c.kind === 'action' ? [c.action] : c.kind === 'toggle' ? [c.turnOn, c.turnOff] : [],
  )
}

export const methods = (m: HeroModel, id: HeroRow['id']): string[] =>
  actionsOf(rowOf(m, id).controls).map((a) => a.call.method)

export function primaryOf(m: HeroModel, id: HeroRow['id']): HeroAction | undefined {
  return actionsOf(rowOf(m, id).controls).find((a) => a.emphasis === 'primary')
}
