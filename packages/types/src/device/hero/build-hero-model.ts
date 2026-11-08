/**
 * `buildHeroModel` — the ONE pure function behind every device hero (D1023).
 * The admin device page, the admin quick-detail dialog and the viewer's device
 * screen all draw what it returns; none of them decides anything.
 *
 * Inputs are the device, the caps it is bound to (`getBindings`, per device —
 * never the global cap list, D12), its features and one raw slice per cap. A
 * slice that is missing or does not parse is "not answered": unknown is never
 * off (D315/D393), a heater whose switch has not reported renders `unknown`.
 */
import { RunningStateStatusSchema } from '../../capabilities/running-state.cap.js'
import type { HeroContext, HeroFragment, StateReading, StateSource } from './hero-fragment.js'
import { HERO_CAP_CONTRIBUTIONS } from './hero-contributions.js'
import { resolveHeroLayout } from './hero-layout.js'
import { resolveHeroLook } from './hero-look.js'
import { resolveHeroSceneId, type HeroScene } from './hero-scene.js'
import type {
  HeroBackground,
  HeroBadge,
  HeroConsumptionSlot,
  HeroFact,
  HeroModel,
  HeroProvenance,
  HeroRow,
  HeroSideTile,
  HeroSideTiles,
} from './hero-model.js'
import { HERO_SIDE_TILES_MAX } from './hero-model.js'
import type { HeroState } from './hero-state.js'
import { heroText, type HeroText } from './hero-text.js'
import { resolveOwnPower } from './own-power.js'

export interface HeroModelInput {
  readonly device: {
    readonly id: number
    readonly type: string
    readonly role: string | null
    readonly name: string
    readonly online: boolean
  }
  /** Kebab cap names the device is bound to. */
  readonly caps: readonly string[]
  readonly features: readonly string[]
  /** Raw runtime slice per cap name; absent = not answered. */
  readonly slices: Readonly<Record<string, unknown>>
  readonly now: number
  /** Saved remote commands; `null` = not known (the button still shows). */
  readonly remoteCommands: number | null
  /** Whether the session may act on the device; the model lists what it must hide. */
  readonly access: { readonly canActuate: boolean }
}

/** The first source with a known answer wins. */
const STATE_SOURCE_ORDER: readonly StateSource[] = [
  'media-player',
  'dishwasher',
  'running-state',
  'switch',
  'contact',
]

const STATE_TEXT: Readonly<Record<HeroState, HeroText>> = {
  on: heroText('On', 'Acceso'),
  off: heroText('Off', 'Spento'),
  running: heroText('Running', 'In funzione'),
  idle: heroText('Idle', 'Inattivo'),
  standby: heroText('Standby', 'In standby'),
  alert: heroText('Alert', 'Allarme'),
  offline: heroText('Offline', 'Non raggiungibile'),
  unknown: heroText('Unknown', 'Sconosciuto'),
}

function pickReading(readings: readonly StateReading[]): StateReading | null {
  for (const source of STATE_SOURCE_ORDER) {
    const found = readings.find((r) => r.source === source && r.state !== 'unknown')
    if (found !== undefined) return found
  }
  return null
}

function runningOf(input: HeroModelInput): boolean | null | undefined {
  if (!input.caps.includes('running-state')) return undefined
  const parsed = RunningStateStatusSchema.safeParse(input.slices['running-state'])
  return parsed.success ? parsed.data.running : null
}

function stateOf(
  input: HeroModelInput,
  readings: readonly StateReading[],
): { readonly state: HeroState; readonly assumed: boolean } {
  if (!input.device.online) return { state: 'offline', assumed: false }
  const picked = pickReading(readings)
  if (picked === null) return { state: 'unknown', assumed: false }
  // A heater that is switched off draws nothing: a quiet meter is "off", not "idle".
  const switchOff = readings.some((r) => r.source === 'switch' && r.state === 'off')
  if (picked.source === 'running-state' && picked.state === 'idle' && switchOff) {
    return { state: 'off', assumed: false }
  }
  return { state: picked.state, assumed: picked.assumed }
}

function provenanceOf(cap: string, fragment: HeroFragment): readonly HeroProvenance[] {
  const ids: string[] = []
  if (fragment.reading !== undefined) ids.push('state')
  if (fragment.ownPower !== undefined) ids.push('own-power')
  if (fragment.timedRun !== undefined) ids.push('timed-run')
  if (fragment.powerSupply !== undefined) ids.push('power-supply')
  if (fragment.consumption !== undefined) ids.push('consumption')
  if (fragment.consumables !== undefined) ids.push('consumables')
  if (fragment.facts !== undefined && fragment.facts.length > 0) ids.push('facts')
  if (fragment.tiles !== undefined) ids.push('side-tiles')
  if (fragment.scene !== undefined) ids.push('scene')
  if (fragment.remote !== undefined) ids.push('remote')
  for (const badge of fragment.badges ?? []) ids.push(badge.id)
  for (const row of fragment.rows ?? []) ids.push(row.id)
  return ids.map((partId) => ({ partId, cap }))
}

function consumptionOf(fragments: readonly HeroFragment[]): HeroConsumptionSlot | null {
  let best: { readonly priority: number; readonly slot: HeroConsumptionSlot } | null = null
  for (const fragment of fragments) {
    const c = fragment.consumption
    if (c !== undefined && (best === null || c.priority > best.priority)) best = c
  }
  return best === null ? null : best.slot
}

function tilesOf(fragments: readonly HeroFragment[], side: 'left' | 'right'): HeroSideTile[] {
  return fragments.flatMap((f) => f.tiles?.[side] ?? []).slice(0, HERO_SIDE_TILES_MAX)
}

function sceneOf(role: string | null, type: string, fragments: readonly HeroFragment[]): HeroScene {
  const parts = fragments.flatMap((f) => (f.scene === undefined ? [] : [f.scene]))
  return {
    id: resolveHeroSceneId(role, type),
    mode: parts.find((p) => p.mode !== undefined)?.mode ?? null,
    level: parts.find((p) => p.level !== undefined)?.level ?? null,
  }
}

export function buildHeroModel(input: HeroModelInput): HeroModel {
  const { device } = input
  const ctx: HeroContext = {
    deviceId: device.id,
    type: device.type,
    features: input.features,
    now: input.now,
    running: runningOf(input),
    remoteCommands: input.remoteCommands,
  }
  const contributed = HERO_CAP_CONTRIBUTIONS.filter((c) => input.caps.includes(c.cap)).map((c) => ({
    cap: c.cap,
    fragment: c.contribute(input.slices[c.cap], ctx),
  }))
  const fragments = contributed.map((c) => c.fragment)

  const readings = fragments.flatMap((f) => (f.reading === undefined ? [] : [f.reading]))
  const { state, assumed } = stateOf(input, readings)
  const look = resolveHeroLook(device.role, device.type, state)

  const artworkUrl = fragments.find((f) => f.artworkUrl !== undefined)?.artworkUrl
  const background: HeroBackground =
    artworkUrl === undefined || state === 'offline'
      ? { kind: 'state', token: look.background, animation: look.animation }
      : {
          kind: 'artwork',
          url: artworkUrl,
          fallback: { token: look.background, animation: look.animation },
        }

  const allRows = fragments.flatMap((f) => f.rows ?? [])
  const rows: HeroRow[] = resolveHeroLayout(device.type).rows.flatMap((id) => {
    const row = allRows.find((r) => r.id === id)
    return row === undefined ? [] : [row]
  })

  const ownPower = resolveOwnPower(
    fragments.flatMap((f) => (f.ownPower === undefined ? [] : [f.ownPower])),
  )
  const timedRun = fragments.find((f) => f.timedRun !== undefined)?.timedRun ?? null
  const powerSupply = fragments.find((f) => f.powerSupply !== undefined)?.powerSupply ?? null
  const remote = fragments.find((f) => f.remote !== undefined)?.remote ?? null
  const badges: HeroBadge[] = fragments.flatMap((f) => f.badges ?? [])

  const facts: HeroFact[] = fragments.flatMap((f) => f.facts ?? [])
  const sideTiles: HeroSideTiles = {
    left: tilesOf(fragments, 'left'),
    right: tilesOf(fragments, 'right'),
  }

  const gated: string[] = []
  if (!input.access.canActuate) {
    if (ownPower !== null) gated.push('own-power')
    if (timedRun !== null) gated.push('timed-run')
    if (powerSupply !== null) gated.push('power-supply')
    if (remote !== null) gated.push('remote')
    for (const row of rows) if (row.controls.length > 0) gated.push(row.id)
  }

  return {
    deviceId: device.id,
    type: device.type,
    role: device.role,
    name: device.name,
    state,
    stateAssumed: assumed,
    look,
    background,
    scene: sceneOf(device.role, device.type, fragments),
    facts,
    sideTiles,
    title: STATE_TEXT[state],
    badges,
    remote,
    consumables: fragments.find((f) => f.consumables !== undefined)?.consumables ?? null,
    consumption: consumptionOf(fragments),
    ownPower,
    timedRun,
    powerSupply,
    rows,
    gated,
    provenance: contributed.flatMap((c) => provenanceOf(c.cap, c.fragment)),
  }
}
