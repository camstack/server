import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { AirflowViz, FanBlades } from '../device-controls/ac-panel'
import { levelClass } from './hero-scene-css'
import type { BackdropKind, SceneSpeed, SceneVisual } from './types'

/** Backdrop periods handed to the ac-panel pieces we reuse (seconds). */
const PERIOD: Readonly<Record<SceneSpeed, number>> = { slow: 2.2, normal: 1.6, fast: 1.0 }

const COLUMNS: readonly number[] = [0, 1, 2, 3, 4, 5]

interface BackdropProps {
  readonly visual: SceneVisual
  readonly level?: number
  readonly points?: readonly number[]
  readonly timer?: boolean
  /**
   * The scene draws its own illustration in the centre (`SCENES_WITH_ART`). A backdrop
   * that draws a centred FIGURE (a drum, a ring, a ripple) would then sit behind it at
   * the card's centre — not the illustration's, which side tiles push off-centre — and
   * show as a second machine poking out. Such a scene keeps only the ambient backdrops.
   */
  readonly withArt?: boolean
}

/** Backdrops that draw a figure at the card's centre, rather than an ambient field. */
const CENTRED_FIGURE_KINDS: ReadonlySet<BackdropKind> = new Set<BackdropKind>([
  'drum',
  'ripple',
  'ring',
  'orbit',
  'fan',
  'breathe',
  // The idle grid sits along the scene's foot: under an illustration it would run
  // behind the command controls (a cover's open / stop / close), so the art stands alone.
  'none',
])

function Particles({ direction, drop }: { direction: 'fall' | 'rise'; drop?: boolean }): ReactNode {
  return (
    <div className={cn('absolute inset-0', direction === 'fall' ? 'hs-fall' : 'hs-rise')}>
      {COLUMNS.map((i) => (
        <span key={i} className={cn('hs-p', drop ? 'h-1.5 w-1.5' : 'h-7 w-1')} />
      ))}
    </div>
  )
}

function Centered({ children }: { children: ReactNode }): ReactNode {
  return <div className="absolute inset-0 flex items-center justify-center">{children}</div>
}

function Ripple(): ReactNode {
  return (
    <Centered>
      {[0, 1, 2].map((i) => (
        <span key={i} className="hs-ring -ml-12 -mt-12 h-24 w-24" />
      ))}
    </Centered>
  )
}

function Drum(): ReactNode {
  return (
    <Centered>
      <div className="relative h-20 w-20 rounded-full border-4 border-current opacity-60">
        <div className="hs-spin absolute inset-1 rounded-full">
          <span className="absolute left-1/2 top-0 h-3 w-3 -translate-x-1/2 rounded-full bg-current" />
          <span className="absolute bottom-1 left-2 h-2 w-2 rounded-full bg-current opacity-70" />
          <span className="absolute bottom-3 right-1 h-2.5 w-2.5 rounded-full bg-current opacity-50" />
        </div>
      </div>
    </Centered>
  )
}

function Sweep(): ReactNode {
  return (
    <div className="absolute inset-0 flex flex-col justify-center gap-6 px-6">
      {[0, 1, 2].map((i) => (
        <div key={i} className="hs-lane flex justify-center border-b border-current/30">
          <span className="hs-lane-dot h-2 w-8 rounded-full bg-current opacity-70" />
        </div>
      ))}
    </div>
  )
}

function Bars(): ReactNode {
  return (
    <div className="absolute inset-x-0 bottom-0 flex h-3/5 items-end justify-center gap-2">
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <span key={i} className="hs-bar h-full w-2 rounded-t-full bg-current opacity-60" />
      ))}
    </div>
  )
}

function Glow(): ReactNode {
  return (
    <Centered>
      <span className="hs-glow h-28 w-28 rounded-full bg-current blur-3xl" />
    </Centered>
  )
}

function RingScene({ moving }: { moving: boolean }): ReactNode {
  return (
    <Centered>
      <span className="relative flex h-20 w-20 items-center justify-center">
        <span className="absolute inset-0 rounded-full border-2 border-current opacity-40" />
        {moving ? <span className="hs-ring -ml-10 -mt-10 h-20 w-20" /> : null}
        <span className="hs-glow h-10 w-10 rounded-full bg-current blur-xl" />
      </span>
    </Centered>
  )
}

function Slats({ level, moving }: { level?: number; moving: boolean }): ReactNode {
  return (
    <div className={cn('absolute inset-0', levelClass(level))}>
      <div className={cn('hs-slat-block absolute inset-x-6 top-0 h-full', moving && 'hs-shimmer')}>
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <span key={i} className="block h-[12.5%] border-b border-current/40 bg-current/15" />
        ))}
      </div>
    </div>
  )
}

const MIN_SPARK_POINTS = 2
const FALLBACK_POINTS: readonly number[] = [4, 6, 5, 8, 7, 9, 8, 11, 10]

/** Normalised polyline `d` in a 100×40 viewBox. */
export function sparkPath(points: readonly number[] | undefined): string {
  const src = points !== undefined && points.length >= MIN_SPARK_POINTS ? points : FALLBACK_POINTS
  const min = Math.min(...src)
  const span = Math.max(...src) - min || 1
  return src
    .map((v, i) => {
      const x = (i / (src.length - 1)) * 100
      const y = 36 - ((v - min) / span) * 32
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
}

function Spark({ points }: { points?: readonly number[] }): ReactNode {
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="absolute inset-x-4 inset-y-6">
      <path
        className="hs-draw"
        d={sparkPath(points)}
        pathLength={100}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

function Stream(): ReactNode {
  const rows = [0, 1, 2, 3, 4, 5, 6, 7]
  return (
    <div className="absolute inset-x-8 inset-y-0 overflow-hidden">
      <div className="hs-feed flex flex-col gap-3 pt-3">
        {rows.concat(rows).map((n, i) => (
          <span
            key={i}
            className={cn(
              'block h-1.5 rounded-full bg-current/40',
              n % 2 === 0 ? 'w-3/4' : 'w-1/2',
            )}
          />
        ))}
      </div>
    </div>
  )
}

function Orbit(): ReactNode {
  return (
    <Centered>
      <span className="absolute h-3 w-3 rounded-full bg-current opacity-70" />
      <span className="hs-orbit absolute h-24 w-24 rounded-full border border-dashed border-current/40">
        <span className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rounded-full bg-current" />
        <span className="absolute -bottom-1 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-current opacity-60" />
      </span>
    </Centered>
  )
}

function DimGrid(): ReactNode {
  return (
    <div className="absolute inset-0 flex items-end justify-center gap-2 pb-4 opacity-30">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <span key={i} className="h-6 w-1 rounded-full bg-current" />
      ))}
    </div>
  )
}

/** The one background animation a resolved scene visual draws. */
export function SceneBackdrop({ visual, level, points, timer, withArt }: BackdropProps): ReactNode {
  const figureHidden = withArt === true && CENTRED_FIGURE_KINDS.has(visual.kind)
  const speedClass = visual.speed === 'fast' ? 'hs-fast' : visual.speed === 'slow' ? 'hs-slow' : ''
  return (
    <div
      aria-hidden
      data-backdrop={visual.kind}
      className={cn(
        'hs-fx pointer-events-none absolute inset-0 overflow-hidden opacity-70',
        speedClass,
      )}
    >
      {figureHidden ? null : <BackdropBody visual={visual} level={level} points={points} />}
      {timer === true ? (
        <span
          className={cn(
            'hs-timer absolute inset-x-0 bottom-0 h-1 bg-current opacity-60',
            levelClass(level),
          )}
        />
      ) : null}
    </div>
  )
}

function BackdropBody({ visual, level, points }: BackdropProps): ReactNode {
  switch (visual.kind) {
    case 'airflow':
      return (
        <AirflowViz
          mode={visual.airflowMode ?? 'off'}
          accent="currentColor"
          periodSec={PERIOD[visual.speed]}
          swaying={false}
        />
      )
    case 'fan':
      return (
        <Centered>
          <span className="opacity-50">
            <FanBlades color="currentColor" periodSec={PERIOD[visual.speed] * 0.7} size={136} />
          </span>
        </Centered>
      )
    case 'rise':
      return <Particles direction="rise" />
    case 'fall':
      return <Particles direction="fall" />
    case 'drop':
      return <Particles direction="fall" drop />
    case 'drum':
      return <Drum />
    case 'ripple':
      return <Ripple />
    case 'sweep':
      return <Sweep />
    case 'bars':
      return <Bars />
    case 'breathe':
      return <Glow />
    case 'slats':
      return <Slats level={level} moving={!visual.dim} />
    case 'ring':
      return <RingScene moving={visual.tone === 'danger' || visual.tone === 'warning'} />
    case 'spark':
      return <Spark points={points} />
    case 'stream':
      return <Stream />
    case 'orbit':
      return <Orbit />
    case 'none':
      return <DimGrid />
  }
}
