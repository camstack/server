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
  Power,
  Siren,
  WashingMachine,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { Button } from '../../primitives/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../primitives/tooltip'
import { SceneBackdrop } from './backdrops'
import { SceneArt, SCENES_WITH_ART } from './scene-art'
import { HERO_SCENE_CSS } from './hero-scene-css'
import { KEYFRAMES as AIRFLOW_KEYFRAMES } from '../device-controls/ac-panel'
import { resolveSceneVisual, TONE_CLASS } from './scene-map'
import type { HeroSceneId, HeroSceneParams, SceneTile } from './types'

/** Default glyph per scene — the type icon shown in front of a row's mini scene. */
export const HERO_SCENE_ICON: Readonly<Record<HeroSceneId, LucideIcon>> = {
  ac: AirVent,
  thermostat: Thermometer,
  heater: Flame,
  'heat-pump': Flame,
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

/** "COOLING · fan Auto": the first part is the state in the scene's tone, the rest reads as detail. */
function CaptionText({ text }: { readonly text: string }): ReactNode {
  const at = text.indexOf(' · ')
  if (at === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <span className="font-normal normal-case text-foreground-muted">{text.slice(at)}</span>
    </>
  )
}

/** The device's own on/off, read at the top of the scene; `action` makes that value the switch. */
export interface HeroScenePower {
  /** The state word ("On", "Off"), printed before the caption. */
  readonly value: string
  readonly on: boolean
  /** Absent: the value is only read (a session that may not act). */
  readonly action?: {
    /** The verb the press performs ("Turn off"): the tooltip and the accessible name. */
    readonly label: string
    readonly onPress: () => void
    readonly disabled?: boolean
  }
}

export interface HeroSceneProps extends HeroSceneParams {
  readonly scene: HeroSceneId
  /** Scene-specific state (see `resolveSceneVisual`). */
  readonly state?: string
  /** `hero`: the full-width box with tiles and centre slot. `mini`: 44×44 for a row. */
  readonly size?: 'hero' | 'mini'
  /** A short state caption at the top of the scene ("Cooling", "Rinsing"), in the scene's tone. */
  readonly caption?: string
  /** The device's own on/off: its value leads the caption and, with an `action`, is the switch. */
  readonly power?: HeroScenePower
  /** Command controls drawn along the scene's foot (a cover's open / stop / close, a player's transport). */
  readonly controls?: ReactNode
  /** Draws the centre slot in the scene's tone (a setpoint, a countdown) instead of the text colour. */
  readonly toneCentre?: boolean
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
          className="flex min-w-0 flex-col gap-0.5 rounded-lg bg-surface-hover px-2 py-1.5"
        >
          <span className="text-[10px] leading-tight text-foreground-muted">{tile.label}</span>
          <span
            className={cn(
              'whitespace-nowrap text-sm font-semibold leading-tight tabular-nums',
              tile.tone === undefined ? 'text-foreground' : TONE_CLASS[tile.tone],
            )}
          >
            {tile.value}
          </span>
        </div>
      ))}
    </div>
  )
}

function SceneCaption({
  caption,
  power,
}: {
  readonly caption: string | undefined
  readonly power: HeroScenePower | undefined
}): ReactNode {
  const text = (
    <>
      {power === undefined ? null : (
        <span data-testid="scene-power-value" className="mr-1.5">
          {power.value}
        </span>
      )}
      {caption === undefined ? null : <CaptionText text={caption} />}
    </>
  )
  const action = power?.action
  if (power === undefined || action === undefined)
    return <span className="min-w-0 truncate py-1">{text}</span>
  return (
    <Tooltip className="block max-w-full min-w-0">
      <TooltipTrigger>
        <Button
          variant="ghost"
          size="sm"
          role="switch"
          aria-checked={power.on}
          aria-label={action.label}
          data-testid="scene-power-toggle"
          disabled={action.disabled === true}
          className="h-auto max-w-full gap-1.5 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-current"
          onClick={action.onPress}
        >
          <Power className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{text}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent className="bottom-auto top-full mb-0 mt-1 normal-case">
        {action.label}
      </TooltipContent>
    </Tooltip>
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
  caption,
  power,
  controls,
  toneCentre,
  leftTiles,
  rightTiles,
  children,
  icon,
  className,
  ...params
}: HeroSceneProps): ReactNode {
  const visual = resolveSceneVisual({ scene, state, ...params })
  const art = SCENES_WITH_ART.has(scene)
  const backdrop = (
    <SceneBackdrop
      visual={visual}
      level={params.level}
      points={params.points}
      timer={params.timer}
      withArt={size !== 'mini' && art && children === undefined}
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
        'relative w-full overflow-hidden rounded-xl border border-current/40 bg-surface/30',
        controls === undefined && (art ? 'h-48' : 'h-44'),
        tone,
        className,
      )}
    >
      <style>{AIRFLOW_KEYFRAMES}</style>
      <style>{HERO_SCENE_CSS}</style>
      {backdrop}
      {caption === undefined && power === undefined ? null : (
        <div
          data-testid="scene-caption"
          className="absolute inset-x-0 top-1 z-20 flex justify-center px-2 text-[11px] font-semibold uppercase tracking-wide"
        >
          <SceneCaption caption={caption} power={power} />
        </div>
      )}
      <div
        className={cn(
          'relative z-10 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2 pt-4 text-foreground',
          controls === undefined ? 'h-full' : art ? 'h-48' : 'h-44',
        )}
      >
        <Tiles tiles={leftTiles} />
        <div
          data-testid="scene-centre"
          className={cn('flex min-w-0 items-center justify-center', toneCentre === true && tone)}
        >
          {children ??
            (art ? (
              <span className={tone}>
                <SceneArt scene={scene} running={!visual.dim} level={params.level} mode={state} />
              </span>
            ) : null)}
        </div>
        <div className="flex min-w-0 justify-end">
          <Tiles tiles={rightTiles} />
        </div>
      </div>
      {controls === undefined ? null : (
        <div
          data-testid="scene-controls"
          className="relative z-20 flex flex-col items-center justify-center gap-2 px-3 pb-3 text-foreground"
        >
          {controls}
        </div>
      )}
    </div>
  )
}
