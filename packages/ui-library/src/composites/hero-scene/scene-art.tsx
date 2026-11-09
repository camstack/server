import type { ReactNode } from 'react'
import { HOME_SCENES_WITH_ART, HomeSceneArt } from './scene-art-home'
import type { HeroSceneId } from './types'

/**
 * The illustrated centre of a hero scene (layout A): the drum with clothes, the
 * dishwasher's spray arm, the fountain, the feeder's auger. Drawn in theme tokens
 * only: the machine is `surface` / `border`, the accent is `currentColor` (the scene's
 * tone), and every motion is a transform or opacity keyframe that stops under
 * `prefers-reduced-motion`. A still scene (`running: false`) draws the same picture with
 * nothing moving — an empty drum, a settled water line.
 */
export interface SceneArtProps {
  readonly scene: HeroSceneId
  readonly running: boolean
  /** 0..1 — the fountain's water level, the feeder's hopper fill. */
  readonly level?: number
  /** What the scene is doing when the device says: a lock's or a door's side. */
  readonly mode?: string | null
}

const BODY = 'fill-background-elevated stroke-border'

function Drum({ running, heat }: { readonly running: boolean; readonly heat: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 200 170" aria-hidden="true" className="h-36 w-auto max-w-full">
      <rect x="30" y="8" width="140" height="156" rx="16" className={BODY} strokeWidth="2" />
      <circle cx="52" cy="24" r="4" className="fill-current" />
      <rect x="64" y="20" width="40" height="8" rx="4" className="fill-surface-hover" />
      <circle cx="100" cy="96" r="54" className="fill-surface stroke-border" strokeWidth="4" />
      <g className={running ? 'art-spin' : undefined}>
        <circle
          cx="100"
          cy="96"
          r="44"
          className="fill-none stroke-current"
          strokeWidth="3"
          strokeDasharray="10 8"
        />
        {running ? (
          <>
            <circle cx="74" cy="80" r="9" className="fill-warning opacity-60" />
            <circle cx="122" cy="102" r="12" className="fill-info opacity-60" />
            <circle cx="88" cy="112" r="7" className="fill-foreground-muted opacity-60" />
            <rect
              x="104"
              y="64"
              width="16"
              height="10"
              rx="4"
              className="fill-success opacity-60"
            />
          </>
        ) : null}
      </g>
      {heat && running ? (
        <g className="stroke-current" fill="none" strokeWidth="2" strokeLinecap="round">
          <path className="art-heat" d="M150 40 q4 -6 0 -12 q-4 -6 0 -12" />
          <path className="art-heat" d="M162 40 q4 -6 0 -12 q-4 -6 0 -12" />
          <path className="art-heat" d="M174 40 q4 -6 0 -12 q-4 -6 0 -12" />
        </g>
      ) : null}
    </svg>
  )
}

function Dishwasher({ running }: { readonly running: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 200 170" aria-hidden="true" className="h-36 w-auto max-w-full">
      <rect x="30" y="8" width="140" height="156" rx="12" className={BODY} strokeWidth="2" />
      <rect x="40" y="22" width="120" height="132" rx="6" className="fill-surface" />
      <g className="stroke-border" strokeWidth="3">
        <path d="M56 60 v-22 M72 60 v-22 M88 60 v-22 M104 60 v-22 M120 60 v-22 M136 60 v-22" />
      </g>
      {running ? (
        <g className="fill-info">
          <circle className="art-bubble" cx="62" cy="120" r="2.5" />
          <circle className="art-bubble" cx="84" cy="120" r="2.5" />
          <circle className="art-bubble" cx="104" cy="120" r="2.5" />
          <circle className="art-bubble" cx="126" cy="120" r="2.5" />
          <circle className="art-bubble" cx="146" cy="120" r="2.5" />
        </g>
      ) : null}
      <g className={running ? 'art-spin' : undefined}>
        <rect x="54" y="122" width="92" height="8" rx="4" className="fill-current" />
        <circle cx="100" cy="126" r="7" className="fill-current" />
      </g>
    </svg>
  )
}

function Fountain({
  running,
  level,
}: {
  readonly running: boolean
  readonly level: number
}): ReactNode {
  const top = 168 - Math.round(60 + 40 * level)
  return (
    <svg viewBox="0 0 200 180" aria-hidden="true" className="h-36 w-auto max-w-full">
      <defs>
        <clipPath id="hs-art-tank">
          <rect x="30" y="58" width="140" height="104" rx="22" />
        </clipPath>
      </defs>
      <rect
        x="30"
        y="58"
        width="140"
        height="104"
        rx="22"
        className="fill-surface stroke-border"
        strokeWidth="2"
      />
      <g clipPath="url(#hs-art-tank)">
        <g transform={`translate(0 ${String(top - 96)})`}>
          <g className={running ? 'art-wave' : undefined}>
            <path
              d="M0 96 q20 -8 40 0 t40 0 t40 0 t40 0 t40 0 t40 0 V180 H0z"
              className="fill-info opacity-60"
            />
          </g>
          <path
            d="M0 100 q20 -7 40 0 t40 0 t40 0 t40 0 t40 0 t40 0 V180 H0z"
            className="fill-info opacity-40"
          />
        </g>
      </g>
      <rect
        x="88"
        y="132"
        width="24"
        height="24"
        rx="6"
        className="fill-background stroke-border"
      />
      <g className={running ? 'art-spin-fast' : undefined}>
        <path
          d="M100 136 v16 M92 144 h16 M94.5 138.5 l11 11 M105.5 138.5 l-11 11"
          className="stroke-info"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </g>
      <rect
        x="150"
        y="70"
        width="12"
        height="46"
        rx="4"
        className="fill-surface-hover stroke-border"
      />
      <rect x="152" y="96" width="8" height="18" rx="2" className="fill-warning opacity-80" />
      <circle cx="44" cy="148" r="3.5" className="fill-success" />
      <rect
        x="92"
        y="20"
        width="16"
        height="22"
        rx="4"
        className="fill-surface-hover stroke-border"
      />
      <path
        className={running ? 'art-stream stroke-info' : 'stroke-info opacity-30'}
        d="M100 42 C100 48, 100 50, 100 58"
        strokeWidth="5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}

function Feeder({
  running,
  level,
}: {
  readonly running: boolean
  readonly level: number
}): ReactNode {
  const fillTop = 94 - Math.round(60 * level)
  return (
    <svg viewBox="0 0 200 180" aria-hidden="true" className="h-36 w-auto max-w-full">
      <defs>
        <clipPath id="hs-art-hopper">
          <path d="M50 14 h100 v54 l-34 26 h-32 l-34 -26z" />
        </clipPath>
      </defs>
      <path
        d="M50 14 h100 v54 l-34 26 h-32 l-34 -26z"
        className="fill-surface stroke-border"
        strokeWidth="2"
      />
      <g clipPath="url(#hs-art-hopper)" className="fill-current">
        <rect x="40" y={fillTop} width="120" height={100 - fillTop} className="opacity-50" />
        <circle cx="76" cy={fillTop + 2} r="5" />
        <circle cx="104" cy={fillTop} r="5" />
        <circle cx="132" cy={fillTop + 2} r="5" />
      </g>
      <circle cx="100" cy="102" r="12" className="fill-background stroke-border" strokeWidth="2" />
      <g className={running ? 'art-spin-fast' : undefined}>
        <path
          d="M100 92 v20 M90 102 h20"
          className="stroke-current"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </g>
      <rect x="92" y="114" width="16" height="14" className="fill-surface stroke-border" />
      {running ? (
        <g className="fill-current">
          <circle className="art-kibble" cx="97" cy="122" r="3.5" />
          <circle className="art-kibble" cx="103" cy="122" r="3" />
          <circle className="art-kibble" cx="100" cy="122" r="3.5" />
        </g>
      ) : null}
      <path
        d="M52 150 h96 l-10 22 h-76z"
        className="fill-surface-hover stroke-border"
        strokeWidth="2"
      />
      <g className={running ? 'art-pile fill-current' : 'fill-current'}>
        <circle cx="86" cy="150" r="5" />
        <circle cx="96" cy="147" r="5" />
        <circle cx="106" cy="149" r="5" />
        <circle cx="114" cy="151" r="4.5" />
      </g>
    </svg>
  )
}

/**
 * The outdoor unit: housing, a grille with the fan (spins while the compressor runs, like
 * the pump of the fountain), warm air rising off the top (`art-heat`), and the water
 * circuit leaving the side (`art-stream`, warm supply over a cool return).
 */
function HeatPump({ running }: { readonly running: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 200 170" aria-hidden="true" className="h-36 w-auto max-w-full">
      <rect x="28" y="26" width="112" height="128" rx="14" className={BODY} strokeWidth="2" />
      <circle cx="46" cy="42" r="3.5" className="fill-current" />
      <rect x="56" y="38" width="40" height="8" rx="4" className="fill-surface-hover" />
      <circle cx="84" cy="98" r="44" className="fill-surface stroke-border" strokeWidth="3" />
      <circle cx="84" cy="98" r="36" className="fill-none stroke-border" strokeWidth="1.5" />
      <g className={running ? 'art-spin-fast' : undefined}>
        <path
          d="M84 98 q-8 -18 0 -32 q10 12 0 32z M84 98 q18 -8 32 0 q-12 10 -32 0z M84 98 q8 18 0 32 q-10 -12 0 -32z M84 98 q-18 8 -32 0 q12 -10 32 0z"
          className="fill-current opacity-80"
        />
        <circle cx="84" cy="98" r="5" className="fill-background stroke-border" strokeWidth="2" />
      </g>
      {running ? (
        <g className="stroke-current" fill="none" strokeWidth="2" strokeLinecap="round">
          <path className="art-heat" d="M52 22 q4 -6 0 -12 q-4 -6 0 -12" />
          <path className="art-heat" d="M84 22 q4 -6 0 -12 q-4 -6 0 -12" />
          <path className="art-heat" d="M116 22 q4 -6 0 -12 q-4 -6 0 -12" />
        </g>
      ) : null}
      <path d="M140 70 H176 V150" className="fill-none stroke-border" strokeWidth="7" />
      <path d="M140 118 H160 V150" className="fill-none stroke-border" strokeWidth="7" />
      <path
        d="M140 70 H176 V150"
        className={running ? 'art-stream stroke-warning' : 'stroke-warning opacity-30'}
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M160 150 V118 H140"
        className={running ? 'art-stream stroke-info' : 'stroke-info opacity-30'}
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="176" cy="154" r="4" className="fill-success" />
    </svg>
  )
}

/** The scene ids that have an illustration; every other scene keeps its icon in the centre. */
export const SCENES_WITH_ART: ReadonlySet<HeroSceneId> = new Set<HeroSceneId>([
  'washer',
  'dryer',
  'dishwasher',
  'pet-fountain',
  'pet-feeder',
  'heat-pump',
  ...HOME_SCENES_WITH_ART,
])

export function SceneArt({ scene, running, level = 0.7, mode = null }: SceneArtProps): ReactNode {
  switch (scene) {
    case 'washer':
      return <Drum running={running} heat={false} />
    case 'dryer':
      return <Drum running={running} heat />
    case 'dishwasher':
      return <Dishwasher running={running} />
    case 'pet-fountain':
      return <Fountain running={running} level={level} />
    case 'pet-feeder':
      return <Feeder running={running} level={level} />
    case 'heat-pump':
      return <HeatPump running={running} />
    default:
      return <HomeSceneArt scene={scene} running={running} level={level} mode={mode} />
  }
}
