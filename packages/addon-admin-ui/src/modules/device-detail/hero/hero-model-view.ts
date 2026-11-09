/**
 * Hero model -> component props. Pure: it selects and renames what the model
 * already says; it decides nothing about a device type (D1023, D14).
 */
import {
  HERO_CAP_COVERAGE,
  LATER_PHASE,
  type HeroFact,
  type HeroModel,
  type HeroSideTile,
  type HeroState,
  type HeroText,
  type HeroTone,
} from '@camstack/types'
import type { BadgeVariant, HeroSceneParams, SceneTile } from '@camstack/ui-library'

export type HeroLang = 'en' | 'it'

export function heroLang(language: string): HeroLang {
  return language.toLowerCase().startsWith('it') ? 'it' : 'en'
}

export function pickText(text: HeroText, lang: HeroLang): string {
  return text[lang]
}

/** A state in which nothing moves: the scene is drawn dim. */
const QUIET_STATES: ReadonlySet<HeroState> = new Set(['off', 'offline', 'standby', 'unknown'])

const MOVING_STATE_WORD: Readonly<Record<HeroState, string>> = {
  on: 'on',
  off: 'off',
  running: 'run',
  idle: 'idle',
  standby: 'standby',
  alert: 'error',
  offline: 'offline',
  unknown: 'off',
}

/** The state string the scene resolves its backdrop from. */
export function sceneStateOf(model: HeroModel): string {
  if (QUIET_STATES.has(model.state)) return MOVING_STATE_WORD[model.state]
  return model.scene.mode ?? MOVING_STATE_WORD[model.state]
}

export interface SceneProps {
  readonly scene: HeroModel['scene']['id']
  readonly state: string
  readonly level?: HeroSceneParams['level']
}

export function sceneOf(model: HeroModel): SceneProps {
  const base = { scene: model.scene.id, state: sceneStateOf(model) }
  return model.scene.level === null ? base : { ...base, level: model.scene.level }
}

/** A clock time in the viewer's own time zone ("17:42"). */
export function clockText(at: number, lang: HeroLang): string {
  return new Date(at).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })
}

function tile(side: HeroSideTile, lang: HeroLang): SceneTile {
  return {
    label: pickText(side.label, lang),
    value: side.at === undefined ? pickText(side.value, lang) : clockText(side.at, lang),
    ...(side.tone === 'warning' || side.tone === 'danger' || side.tone === 'success'
      ? { tone: side.tone }
      : {}),
  }
}

export function tilesOf(tiles: readonly HeroSideTile[], lang: HeroLang): readonly SceneTile[] {
  return tiles.map((t) => tile(t, lang))
}

/** Badge variant per tone. */
export function badgeVariantOf(tone: HeroTone): BadgeVariant {
  return tone === 'muted' ? 'neutral' : tone
}

export function factsOf(model: HeroModel): readonly HeroFact[] {
  return model.facts
}

/**
 * Caps bound to the device whose legacy hero parts the model does not carry yet
 * (`LATER_PHASE` in the coverage table). Their presence keeps the legacy hero.
 */
export function uncoveredCaps(boundCaps: readonly string[]): readonly string[] {
  return boundCaps.filter((cap) => {
    const coverage = HERO_CAP_COVERAGE[cap]
    return coverage !== undefined && coverage !== 'contributes' && coverage.none === LATER_PHASE
  })
}

/** The model has something to draw: a known state, a slot or a row. */
export function modelSaysAnything(model: HeroModel): boolean {
  return (
    model.provenance.some((p) => p.partId === 'state') ||
    model.rows.length > 0 ||
    model.facts.length > 0 ||
    model.sideTiles.left.length > 0 ||
    model.sideTiles.right.length > 0 ||
    model.ownPower !== null ||
    model.powerSupply !== null ||
    model.timedRun !== null
  )
}

/**
 * Whether the hero model draws this device. `false` keeps the legacy hero, which
 * still has parts (brightness, climate modes, ...) the model does not carry.
 */
export function heroModelCovers(model: HeroModel, boundCaps: readonly string[]): boolean {
  return modelSaysAnything(model) && uncoveredCaps(boundCaps).length === 0
}
