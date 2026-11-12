import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'
import type { ClimateRole } from './ClimateRoleGlyph'

/**
 * The ambient layer behind a scene: what the device is doing, drawn as motion
 * and colour. One table maps (role, activity) to a stack of layers; a new
 * environmental card adds its role to the table and reuses the layers.
 */
export type AmbientRole = ClimateRole | 'fan' | 'switch-heater' | 'heat-pump' | 'water-heater'
/** What a climate-like device is doing. */
export type ClimateAmbientActivity = 'off' | 'cool' | 'heat' | 'idle' | 'window' | 'unknown'
/** Climate's activities plus a moving appliance's `run` (a fan). */
export type AmbientActivity = ClimateAmbientActivity | 'run'

export const AMBIENT_LAYERS = [
  'wash-up',
  'wash-down',
  'glow-low',
  'breathe',
  'particles-rise',
  'particles-fall',
  'air',
  'serpentine',
  'wisps-floor',
  'wisps-unit',
  'radiator',
  'heater',
  'pipe',
  'draft',
  'breeze',
] as const
export type AmbientLayer = (typeof AMBIENT_LAYERS)[number]
export type AmbientPace = 'live' | 'slow'

export interface AmbientFxProps {
  readonly role: AmbientRole
  readonly activity: AmbientActivity
  /** The air stream sways from side to side. */
  readonly swing: boolean
  /** How fast the air moves, 0..100 (a fan's speed); absent is the default pace. */
  readonly speed?: number
}

type AmbientStack = readonly AmbientLayer[]
type LiveActivity = 'heat' | 'cool' | 'run'

const COLD_AIR: AmbientStack = ['wash-down', 'particles-fall']

/** What a role shows while it is heating or cooling. */
const LIVE: Readonly<Record<AmbientRole, Readonly<Partial<Record<LiveActivity, AmbientStack>>>>> = {
  ac: { heat: ['wash-down', 'air'], cool: ['wash-down', 'air'] },
  thermostat: { heat: ['wash-up', 'particles-rise'], cool: COLD_AIR },
  floor: { heat: ['wash-up', 'serpentine', 'wisps-floor'], cool: ['wash-down', 'serpentine'] },
  radiator: { heat: ['wash-up', 'radiator', 'wisps-unit'], cool: COLD_AIR },
  heater: { heat: ['wash-up', 'heater', 'wisps-unit'], cool: COLD_AIR },
  hpcircuit: { heat: ['wash-up', 'pipe'], cool: ['wash-down', 'pipe'] },
  fan: { run: ['breeze'] },
  'switch-heater': { heat: ['glow-low', 'wisps-unit'] },
  'heat-pump': { heat: ['wash-up', 'breathe'], cool: ['wash-down', 'breathe'] },
  'water-heater': { heat: ['wash-up', 'glow-low'] },
}

/** What a role keeps in standby: the appliance at rest, air and water moving slowly. */
const STANDBY: Readonly<Record<AmbientRole, AmbientStack>> = {
  ac: ['air'],
  thermostat: [],
  floor: ['serpentine'],
  radiator: ['radiator'],
  heater: ['heater'],
  hpcircuit: ['pipe'],
  fan: [],
  'switch-heater': [],
  'heat-pump': [],
  'water-heater': [],
}

const TONE: Readonly<Record<AmbientActivity, string>> = {
  off: 'text-foreground-muted',
  idle: 'text-foreground-muted',
  unknown: 'text-foreground-muted',
  cool: 'text-info',
  heat: 'text-primary',
  run: 'text-info',
  window: 'text-info',
}

/** The layers a (role, activity) pair draws, back to front; empty is a still scene. */
export function ambientLayers(role: AmbientRole, activity: AmbientActivity): AmbientStack {
  if (activity === 'off' || activity === 'unknown') return []
  if (activity === 'window') return ['draft']
  if (activity === 'idle') return ['breathe', ...STANDBY[role]]
  return LIVE[role][activity] ?? []
}

/** How fast the stack moves: in standby the air and the water slow down, the rest holds still. */
export function ambientPace(activity: AmbientActivity): AmbientPace {
  return activity === 'idle' ? 'slow' : 'live'
}

const streaks = (n: number): ReactElement[] => Array.from({ length: n }, (_, i) => <i key={i} />)

const LOOP_PATH = 'M-10 20H300a20 20 0 0 1 0 40H40a20 20 0 0 0 0 40H350'
const SERPENTINE_PATH = 'M12 8H312a7 7 0 0 1 0 14H28a7 7 0 0 0 0 14H328'

function flowing(className: string, viewBox: string, d: string): ReactElement {
  return (
    <svg className={className} viewBox={viewBox} preserveAspectRatio="none">
      <path className="dc-p0" vectorEffect="non-scaling-stroke" d={d} />
      <path className="dc-p1" vectorEffect="non-scaling-stroke" d={d} />
    </svg>
  )
}

const RADIATOR = (
  <svg className="dc-fx-unit" viewBox="0 0 96 56">
    <path d="M4 10h88M4 46h88" />
    <rect x={10} y={4} width={12} height={48} rx={5} />
    <rect x={26} y={4} width={12} height={48} rx={5} />
    <rect x={42} y={4} width={12} height={48} rx={5} />
    <rect x={58} y={4} width={12} height={48} rx={5} />
    <rect x={74} y={4} width={12} height={48} rx={5} />
  </svg>
)

const HEATER = (
  <svg className="dc-fx-unit" viewBox="0 0 96 56">
    <rect x={8} y={4} width={80} height={42} rx={9} />
    <path d="M22 46v6M74 46v6" />
    <path className="dc-fx-coil" d="M22 16h52M22 25h52M22 34h52" />
  </svg>
)

function drawLayer(layer: AmbientLayer, swing: boolean): ReactElement {
  switch (layer) {
    case 'wash-up':
      return <div className="dc-fx-wash" data-from="bottom" />
    case 'wash-down':
      return <div className="dc-fx-wash" data-from="top" />
    case 'glow-low':
      return <div className="dc-fx-wash" data-from="bottom" data-low />
    case 'breathe':
      return <div className="dc-fx-breathe" />
    case 'particles-rise':
      return (
        <div className="dc-fx-p" data-dir="rise">
          {streaks(6)}
        </div>
      )
    case 'particles-fall':
      return (
        <div className="dc-fx-p" data-dir="fall">
          {streaks(6)}
        </div>
      )
    case 'air':
      return (
        <div className="dc-fx-air" data-sway={swing}>
          {streaks(6)}
        </div>
      )
    case 'serpentine':
      return flowing('dc-fx-serp', '0 0 340 44', SERPENTINE_PATH)
    case 'wisps-floor':
      return (
        <div className="dc-fx-wisps" data-at="floor">
          {streaks(5)}
        </div>
      )
    case 'wisps-unit':
      return (
        <div className="dc-fx-wisps" data-at="unit">
          {streaks(3)}
        </div>
      )
    case 'radiator':
      return RADIATOR
    case 'heater':
      return HEATER
    case 'pipe':
      return flowing('dc-fx-pipe', '0 0 340 120', LOOP_PATH)
    case 'draft':
      return <div className="dc-fx-draft">{streaks(4)}</div>
    case 'breeze':
      return <div className="dc-fx-breeze">{streaks(4)}</div>
  }
}

/**
 * A speed 0..100 as one of five paces (`data-speed`), so the stylesheet sets
 * how fast blades and air move without an inline style. Zero is still.
 */
export type SpeedBand = 0 | 1 | 2 | 3 | 4 | 5
export function speedBand(speed: number): SpeedBand {
  if (speed <= 0) return 0
  if (speed <= 20) return 1
  if (speed <= 40) return 2
  if (speed <= 60) return 3
  if (speed <= 80) return 4
  return 5
}

/** The ambient layer of a scene; renders nothing when the scene is still. */
export function AmbientFx({ role, activity, swing, speed }: AmbientFxProps): ReactElement | null {
  const layers = ambientLayers(role, activity)
  if (layers.length === 0) return null
  return (
    <div
      aria-hidden
      data-fx={layers.join(' ')}
      data-pace={ambientPace(activity)}
      data-speed={speed === undefined ? undefined : speedBand(speed)}
      className={cn('dc-fx', TONE[activity])}
    >
      {layers.map((layer) => (
        <div key={layer} className="dc-fx-layer" data-fx-layer={layer}>
          {drawLayer(layer, swing)}
        </div>
      ))}
    </div>
  )
}
