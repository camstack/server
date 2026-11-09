import type { ReactNode } from 'react'
import type { SceneArtProps } from './scene-art'

/**
 * The illustrated centre of the robot, media, home and sensor scenes of hero layout A.
 * Same rules as `scene-art.tsx`: the device body is `surface` / `border`, the accent is
 * `currentColor` (the scene's tone), motion is a transform or opacity keyframe that
 * stops under `prefers-reduced-motion`.
 */
const BODY = 'fill-background-elevated stroke-border'
const SVG = 'h-32 w-auto max-w-full'

function Vacuum({ running }: { readonly running: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 220 130" aria-hidden="true" className={SVG}>
      <rect x="10" y="8" width="200" height="114" rx="10" className={BODY} strokeWidth="2" />
      <g className="fill-border">
        <rect x="26" y="26" width="168" height="10" rx="2" />
        <rect x="26" y="52" width="168" height="10" rx="2" />
        <rect x="26" y="78" width="168" height="10" rx="2" />
        <rect x="26" y="104" width="168" height="8" rx="2" />
      </g>
      <path
        d="M40 31 H180 M180 57 H40 M40 83 H180"
        className="stroke-current fill-none"
        strokeWidth="2"
        strokeDasharray="4 5"
        opacity="0.7"
      />
      <g className={running ? 'art-sweep' : undefined}>
        <circle cx="62" cy="57" r="16" className="fill-surface stroke-current" strokeWidth="3" />
        <circle cx="62" cy="50" r="3.5" className="fill-success" />
        <path d="M56 62 l8 6" className="stroke-current" strokeWidth="2" />
      </g>
    </svg>
  )
}

function Mower({ running }: { readonly running: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 220 130" aria-hidden="true" className={SVG}>
      <rect x="10" y="8" width="200" height="114" rx="10" className={BODY} strokeWidth="2" />
      <g className="fill-success" opacity="0.35">
        <rect x="26" y="22" width="168" height="12" />
        <rect x="26" y="46" width="168" height="12" />
        <rect x="26" y="70" width="168" height="12" />
        <rect x="26" y="94" width="168" height="12" />
      </g>
      <g className={running ? 'art-sweep' : undefined}>
        <rect
          x="60"
          y="44"
          width="50"
          height="30"
          rx="8"
          className="fill-surface stroke-current"
          strokeWidth="3"
        />
        <circle cx="72" cy="78" r="5" className="fill-current" />
        <circle cx="100" cy="78" r="5" className="fill-current" />
        <circle cx="105" cy="52" r="3" className="fill-success" />
      </g>
    </svg>
  )
}

function Tv({ running }: { readonly running: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 200 130" aria-hidden="true" className={SVG}>
      <rect x="14" y="8" width="172" height="104" rx="10" className={BODY} strokeWidth="3" />
      <rect x="24" y="18" width="152" height="84" rx="5" className="fill-surface" />
      <g className="fill-current">
        <rect
          className={running ? 'hs-bar' : undefined}
          x="78"
          y="72"
          width="10"
          height="18"
          rx="2"
        />
        <rect
          className={running ? 'hs-bar' : undefined}
          x="96"
          y="62"
          width="10"
          height="28"
          rx="2"
        />
        <rect
          className={running ? 'hs-bar' : undefined}
          x="114"
          y="48"
          width="10"
          height="42"
          rx="2"
        />
      </g>
      <rect x="76" y="118" width="48" height="5" rx="2.5" className="fill-border" />
    </svg>
  )
}

function Speaker({ running }: { readonly running: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 200 130" aria-hidden="true" className={SVG}>
      {running ? (
        <g className="stroke-current fill-none" strokeWidth="2">
          <circle className="hs-glow" cx="100" cy="66" r="52" />
          <circle className="hs-glow" cx="100" cy="66" r="62" />
        </g>
      ) : null}
      <rect
        x="68"
        y="22"
        width="64"
        height="86"
        rx="14"
        className="fill-surface stroke-current"
        strokeWidth="3"
      />
      <ellipse
        cx="100"
        cy="30"
        rx="32"
        ry="6"
        className="fill-none stroke-current"
        strokeWidth="2"
      />
    </svg>
  )
}

function Light({ level }: { readonly level: number }): ReactNode {
  const lit = level > 0
  return (
    <svg viewBox="0 0 200 130" aria-hidden="true" className={SVG}>
      {lit ? (
        <g
          className="stroke-current"
          strokeWidth="3"
          strokeLinecap="round"
          opacity={0.4 + level * 0.6}
        >
          <path d="M100 6 v14 M100 112 v10 M52 18 l9 10 M148 18 l-9 10 M30 60 h14 M156 60 h14 M56 100 l8 -8 M144 100 l-8 -8" />
        </g>
      ) : null}
      <circle
        cx="100"
        cy="60"
        r="30"
        className={lit ? 'fill-current hs-glow' : 'fill-surface stroke-border'}
      />
      <rect x="90" y="88" width="20" height="12" rx="3" className="fill-border" />
    </svg>
  )
}

function Cover({ level }: { readonly level: number }): ReactNode {
  const slats = Math.round((1 - Math.min(1, Math.max(0, level))) * 8)
  return (
    <svg viewBox="0 0 200 130" aria-hidden="true" className={SVG}>
      <rect x="54" y="8" width="92" height="114" rx="6" className={BODY} strokeWidth="2" />
      <rect x="62" y="20" width="76" height="94" className="fill-surface" />
      <g className="fill-border">
        {Array.from({ length: slats }, (_, i) => (
          <rect key={i} x="62" y={20 + i * 10} width="76" height="8" />
        ))}
      </g>
      <path d="M92 104 l8 8 l8 -8 z" className="fill-current" />
    </svg>
  )
}

function Lock({ closed }: { readonly closed: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 200 130" aria-hidden="true" className={SVG}>
      <path
        d={closed ? 'M72 58 V44 a28 28 0 0 1 56 0 V58' : 'M72 58 V44 a28 28 0 0 1 52 -10'}
        className="fill-none stroke-current"
        strokeWidth="9"
        strokeLinecap="round"
      />
      <rect x="58" y="56" width="84" height="62" rx="10" className="fill-current opacity-20" />
      <rect
        x="58"
        y="56"
        width="84"
        height="62"
        rx="10"
        className="fill-none stroke-current"
        strokeWidth="4"
      />
      <circle cx="100" cy="82" r="7" className="fill-current" />
      <rect x="97" y="86" width="6" height="16" rx="2" className="fill-current" />
    </svg>
  )
}

function Alarm({ armed }: { readonly armed: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 200 130" aria-hidden="true" className={SVG}>
      <path
        d="M100 8 L148 24 V62 C148 92 126 112 100 122 C74 112 52 92 52 62 V24 Z"
        className={armed ? 'fill-current opacity-20' : 'fill-surface'}
      />
      <path
        d="M100 8 L148 24 V62 C148 92 126 112 100 122 C74 112 52 92 52 62 V24 Z"
        className="fill-none stroke-current"
        strokeWidth="5"
        strokeLinejoin="round"
      />
      {armed ? (
        <path
          d="M78 64 l16 16 l30 -34"
          className="fill-none stroke-current"
          strokeWidth="7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
    </svg>
  )
}

function Siren({ running }: { readonly running: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 200 130" aria-hidden="true" className={SVG}>
      {running ? (
        <path className="hs-glow fill-current" d="M100 70 L180 30 V110 Z" opacity="0.35" />
      ) : (
        <path className="fill-current" d="M100 70 L150 48 V92 Z" opacity="0.15" />
      )}
      <path
        d="M72 96 V62 a28 28 0 0 1 56 0 V96 Z"
        className="fill-current opacity-30 stroke-current"
        strokeWidth="3"
      />
      <rect x="56" y="96" width="88" height="10" rx="4" className="fill-border" />
    </svg>
  )
}

function Contact({ closed }: { readonly closed: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 200 130" aria-hidden="true" className={SVG}>
      <rect x="70" y="8" width="60" height="114" rx="4" className={BODY} strokeWidth="2" />
      <path
        d={closed ? 'M76 14 h48 v102 h-48 Z' : 'M76 14 l-14 8 v94 l14 6 Z'}
        className="fill-surface stroke-border"
        strokeWidth="2"
      />
      <circle cx="114" cy="70" r="3" className="fill-border" />
      <rect x={closed ? 132 : 150} y="56" width="6" height="26" rx="2" className="fill-current" />
    </svg>
  )
}

function Presence({ running }: { readonly running: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 200 130" aria-hidden="true" className={SVG}>
      <g className="fill-none stroke-border" strokeWidth="1.5">
        <circle cx="100" cy="66" r="54" />
        <circle cx="100" cy="66" r="36" />
        <circle cx="100" cy="66" r="18" />
      </g>
      <g className={running ? 'art-spin' : undefined}>
        <path d="M100 66 L150 40 A56 56 0 0 1 150 92 Z" className="fill-current opacity-30" />
      </g>
      <circle cx="132" cy="52" r="4.5" className="fill-current" />
    </svg>
  )
}

function Weather(): ReactNode {
  return (
    <svg viewBox="0 0 200 130" aria-hidden="true" className={SVG}>
      <circle cx="82" cy="52" r="24" className="fill-warning" />
      <g className="stroke-warning" strokeWidth="4" strokeLinecap="round">
        <path d="M82 14 v10 M44 52 h10 M52 24 l7 7 M112 24 l-7 7" />
      </g>
      <path
        d="M96 100 a18 18 0 0 1 4 -35 a26 26 0 0 1 48 6 a15 15 0 0 1 -2 29 Z"
        className="fill-border"
      />
    </svg>
  )
}

function Plug({ running }: { readonly running: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 220 130" aria-hidden="true" className={SVG}>
      <path
        d="M6 66 H58 M162 66 H214"
        className={`stroke-current ${running ? 'art-stream' : ''}`}
        strokeWidth="4"
        fill="none"
      />
      <rect
        x="70"
        y="22"
        width="80"
        height="86"
        rx="18"
        className="fill-surface stroke-current"
        strokeWidth="4"
      />
      <circle cx="92" cy="58" r="5" className="fill-current" />
      <circle cx="128" cy="58" r="5" className="fill-current" />
      <rect x="98" y="80" width="24" height="6" rx="3" className="fill-success" />
    </svg>
  )
}

function Button({ running }: { readonly running: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 200 130" aria-hidden="true" className={SVG}>
      {running ? (
        <circle className="hs-glow fill-current" cx="100" cy="66" r="56" opacity="0.2" />
      ) : null}
      <circle cx="100" cy="66" r="46" className="fill-none stroke-current" strokeWidth="5" />
      <circle cx="100" cy="66" r="32" className="fill-current" />
    </svg>
  )
}

function Update(): ReactNode {
  return (
    <svg viewBox="0 0 200 130" aria-hidden="true" className={SVG}>
      <rect x="56" y="18" width="88" height="88" rx="12" className={BODY} strokeWidth="3" />
      <g className="stroke-border" strokeWidth="4" strokeLinecap="round">
        <path d="M76 18 v-10 M100 18 v-10 M124 18 v-10 M76 106 v10 M100 106 v10 M124 106 v10 M56 42 h-10 M56 66 h-10 M56 90 h-10 M144 42 h10 M144 66 h10 M144 90 h10" />
      </g>
      <path
        d="M100 90 V44 M80 62 l20 -20 l20 20"
        className="fill-none stroke-current art-rise"
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function Dial({ level }: { readonly level: number }): ReactNode {
  const frac = Math.min(1, Math.max(0, level))
  const dash = Math.round(frac * 100)
  return (
    <svg viewBox="0 0 200 130" aria-hidden="true" className={SVG}>
      <circle cx="100" cy="66" r="46" className="fill-none stroke-border" strokeWidth="10" />
      <circle
        cx="100"
        cy="66"
        r="46"
        pathLength="100"
        strokeDasharray={`${dash} 100`}
        transform="rotate(-90 100 66)"
        className="fill-none stroke-current"
        strokeWidth="10"
        strokeLinecap="round"
      />
    </svg>
  )
}

function Events({ running }: { readonly running: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 220 130" aria-hidden="true" className={SVG}>
      <path d="M10 66 H210" className="stroke-border" strokeWidth="2" />
      <g className={running ? 'hs-shimmer fill-current' : 'fill-current'}>
        <circle cx="30" cy="66" r="9" opacity="0.5" />
        <circle cx="70" cy="66" r="6" opacity="0.5" />
        <circle cx="112" cy="66" r="11" opacity="0.8" />
        <circle cx="152" cy="66" r="6" opacity="0.5" />
        <circle cx="192" cy="66" r="10" />
      </g>
    </svg>
  )
}

function Gateway(): ReactNode {
  const spokes: ReadonlyArray<readonly [number, number]> = [
    [100, 14],
    [150, 36],
    [150, 96],
    [100, 118],
    [50, 96],
    [50, 36],
  ]
  return (
    <svg viewBox="0 0 200 130" aria-hidden="true" className={SVG}>
      {spokes.map(([x, y]) => (
        <g key={`${x}-${y}`}>
          <path
            d={`M100 66 L${x} ${y}`}
            className="stroke-current"
            strokeWidth="1.5"
            strokeDasharray="4 4"
            opacity="0.6"
          />
          <circle cx={x} cy={y} r="6" className="fill-surface stroke-current" strokeWidth="2.5" />
        </g>
      ))}
      <rect
        x="82"
        y="48"
        width="36"
        height="36"
        rx="8"
        className="fill-surface stroke-current"
        strokeWidth="3"
      />
      <circle cx="100" cy="66" r="4" className="fill-current" />
    </svg>
  )
}

function Terminal(): ReactNode {
  return (
    <svg viewBox="0 0 200 130" aria-hidden="true" className={SVG}>
      <rect x="44" y="20" width="112" height="90" rx="10" className={BODY} strokeWidth="3" />
      <path
        d="M64 50 l16 14 l-16 14"
        className="fill-none stroke-current"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect className="hs-shimmer fill-current" x="90" y="82" width="26" height="6" rx="2" />
    </svg>
  )
}

/** The illustration of one home-family scene; `null` for a scene `scene-art.tsx` draws itself. */
export function HomeSceneArt({ scene, running, level = 0.7, mode }: SceneArtProps): ReactNode {
  switch (scene) {
    case 'vacuum':
      return <Vacuum running={running} />
    case 'lawn-mower':
      return <Mower running={running} />
    case 'tv':
      return <Tv running={running} />
    case 'speaker':
      return <Speaker running={running} />
    case 'light':
      return <Light level={level} />
    case 'cover':
      return <Cover level={level} />
    case 'lock':
      return <Lock closed={mode !== 'open'} />
    case 'alarm':
      return <Alarm armed={running} />
    case 'siren':
      return <Siren running={running} />
    case 'contact':
      return <Contact closed={mode !== 'open'} />
    case 'presence':
      return <Presence running={running} />
    case 'weather':
      return <Weather />
    case 'plug':
      return <Plug running={running} />
    case 'button':
      return <Button running={running} />
    case 'update':
      return <Update />
    case 'control-dial':
      return <Dial level={level} />
    case 'event-stream':
      return <Events running={running} />
    case 'gateway':
      return <Gateway />
    case 'generic':
      return <Terminal />
    default:
      return null
  }
}

export const HOME_SCENES_WITH_ART: readonly SceneArtProps['scene'][] = [
  'vacuum',
  'lawn-mower',
  'tv',
  'speaker',
  'light',
  'cover',
  'lock',
  'alarm',
  'siren',
  'contact',
  'presence',
  'weather',
  'plug',
  'button',
  'update',
  'control-dial',
  'event-stream',
  'gateway',
  'generic',
]
