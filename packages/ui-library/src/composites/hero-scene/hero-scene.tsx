import {
  Activity,
  AirVent,
  Blinds,
  Camera,
  CircleDot,
  CloudSun,
  DoorOpen,
  Download,
  Fan,
  Flame,
  Lightbulb,
  Lock,
  Network,
  Plug,
  Radio,
  Shirt,
  SlidersHorizontal,
  Speaker,
  Thermometer,
  Tv,
  UtensilsCrossed,
  User,
  Waves,
  type LucideIcon,
  Droplets,
  Bot,
  Sprout,
  ShieldCheck,
  Dot,
  Siren,
  WashingMachine,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { SceneBackdrop } from './backdrops'
import { HERO_SCENE_CSS } from './hero-scene-css'
import { KEYFRAMES as AIRFLOW_KEYFRAMES } from '../device-controls/ac-panel'
import { resolveSceneVisual, TONE_CLASS } from './scene-map'
import type { HeroSceneId, HeroSceneParams, SceneTile } from './types'

/** Default glyph per scene — the type icon shown in front of a row's mini scene. */
export const HERO_SCENE_ICON: Readonly<Record<HeroSceneId, LucideIcon>> = {
  ac: AirVent,
  thermostat: Thermometer,
  heater: Flame,
  fan: Fan,
  washer: WashingMachine,
  dryer: Shirt,
  dishwasher: Droplets,
  'pet-fountain': Waves,
  'pet-feeder': UtensilsCrossed,
  vacuum: Bot,
  'lawn-mower': Sprout,
  tv: Tv,
  speaker: Speaker,
  camera: Camera,
  light: Lightbulb,
  cover: Blinds,
  lock: Lock,
  alarm: ShieldCheck,
  siren: Siren,
  'sensor-sparkline': Activity,
  contact: DoorOpen,
  presence: User,
  weather: CloudSun,
  plug: Plug,
  button: CircleDot,
  update: Download,
  'control-dial': SlidersHorizontal,
  'event-stream': Radio,
  gateway: Network,
  generic: Dot,
}

const MAX_TILES_PER_SIDE = 2

export interface HeroSceneProps extends HeroSceneParams {
  readonly scene: HeroSceneId
  /** Scene-specific state (see `resolveSceneVisual`). */
  readonly state?: string
  /** `hero`: the full-width box with tiles and centre slot. `mini`: 44×44 for a row. */
  readonly size?: 'hero' | 'mini'
  readonly leftTiles?: readonly SceneTile[]
  readonly rightTiles?: readonly SceneTile[]
  /** Centre slot (hero) — the camera thumbnail, the setpoint control, a readout. */
  readonly children?: ReactNode
  /** Mini only: the glyph in front of the animation. Defaults to the scene's icon. */
  readonly icon?: ReactNode
  readonly className?: string
}

function Tiles({ tiles }: { tiles: readonly SceneTile[] | undefined }): ReactNode {
  const shown = (tiles ?? []).slice(0, MAX_TILES_PER_SIDE)
  if (shown.length === 0) return <div />
  return (
    <div className="flex min-w-0 flex-col justify-center gap-2">
      {shown.map((tile) => (
        <div
          key={tile.label}
          data-testid="scene-tile"
          className="flex min-w-0 flex-col rounded-lg bg-surface/80 px-2.5 py-2"
        >
          <span className="truncate text-[11px] text-foreground-subtle">{tile.label}</span>
          <span className="truncate text-sm font-semibold tabular-nums text-foreground">
            {tile.value}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * A rectangular scene: an animated backdrop chosen by scene id + state, side
 * tiles and a centre slot. The same ids render at mini size inside a DeviceRow.
 */
export function HeroScene({
  scene,
  state,
  size = 'hero',
  leftTiles,
  rightTiles,
  children,
  icon,
  className,
  ...params
}: HeroSceneProps): ReactNode {
  const visual = resolveSceneVisual({ scene, state, ...params })
  const backdrop = (
    <SceneBackdrop
      visual={visual}
      level={params.level}
      points={params.points}
      timer={params.timer}
    />
  )
  const tone = TONE_CLASS[visual.tone]

  if (size === 'mini') {
    const Glyph = HERO_SCENE_ICON[scene]
    return (
      <div
        data-scene={scene}
        data-scene-size="mini"
        className={cn(
          'relative flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface/30',
          tone,
          className,
        )}
      >
        <style>{AIRFLOW_KEYFRAMES}</style>
        <style>{HERO_SCENE_CSS}</style>
        {backdrop}
        <span className="relative z-10 text-foreground">
          {icon ?? <Glyph className="h-5 w-5" aria-hidden />}
        </span>
      </div>
    )
  }

  return (
    <div
      data-scene={scene}
      data-scene-size="hero"
      className={cn(
        'relative h-44 w-full overflow-hidden rounded-xl border border-border bg-surface/30',
        tone,
        className,
      )}
    >
      <style>{AIRFLOW_KEYFRAMES}</style>
      <style>{HERO_SCENE_CSS}</style>
      {backdrop}
      <div className="relative z-10 grid h-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-3 text-foreground">
        <Tiles tiles={leftTiles} />
        <div data-testid="scene-centre" className="flex min-w-0 items-center justify-center">
          {children}
        </div>
        <div className="flex min-w-0 justify-end">
          <Tiles tiles={rightTiles} />
        </div>
      </div>
    </div>
  )
}
