import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'

/** What the robot is drawn doing. */
export type RobotActivity = 'clean' | 'pause' | 'ret' | 'sleep' | 'charge' | 'err' | 'idle'

export interface RobotIllustrationProps {
  readonly mower: boolean
  readonly activity: RobotActivity
  /** 0..100 of the lawn cut (mower only); null draws no cut stripes. */
  readonly progress?: number | null
  readonly className?: string
}

const BOT_TONE: Readonly<Record<RobotActivity, string>> = {
  clean: 'text-primary',
  pause: 'text-primary',
  ret: 'text-primary',
  idle: 'text-primary',
  sleep: 'text-foreground-muted',
  charge: 'text-success',
  err: 'text-danger',
}

const STRIPES = [0, 1, 2, 3, 4]

function Vacuum(): ReactElement {
  return (
    <>
      <circle className="dc-r-ping" r={26} fill="none" stroke="currentColor" strokeWidth={2} />
      <circle r={19} strokeWidth={3} stroke="currentColor" className="fill-surface" />
      <path
        d="M-15 -8 A19 19 0 0 1 15 -8"
        fill="none"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
        opacity={0.55}
      />
      <g className="dc-r-turret">
        <circle
          r={6}
          fill="currentColor"
          fillOpacity={0.25}
          stroke="currentColor"
          strokeWidth={2}
        />
        <circle cy={-4} r={1.6} fill="currentColor" />
      </g>
    </>
  )
}

function Mower(): ReactElement {
  return (
    <>
      <circle className="dc-r-ping" r={28} fill="none" stroke="currentColor" strokeWidth={2} />
      <rect
        x={-22}
        y={-14}
        width={44}
        height={28}
        rx={9}
        strokeWidth={3}
        stroke="currentColor"
        className="fill-surface"
      />
      <circle cx={-13} cy={15} r={4} fill="currentColor" />
      <circle cx={13} cy={15} r={4} fill="currentColor" />
      <g className="dc-r-turret">
        <path d="M-8 0 H8 M0 -8 V8" stroke="currentColor" strokeWidth={3} strokeLinecap="round" />
      </g>
    </>
  )
}

/**
 * The robot seen from above on its floor (a vacuum on dashed lanes, a mower
 * on a striped lawn whose cut stripes darken with the progress). Cleaning: it
 * travels the lanes, the turret spins, a ring pings. Returning: it heads to the
 * dock. Docked: it sleeps (Zzz) or charges (bolt, dock pulse). Error: it
 * blinks where it stopped. Reduced motion keeps it still.
 */
export function RobotIllustration({
  mower,
  activity,
  progress = null,
  className,
}: RobotIllustrationProps): ReactElement {
  const cut = progress === null ? 0 : Math.round(progress / 20)
  return (
    <svg
      viewBox="0 0 220 130"
      aria-hidden
      data-vst={activity}
      data-mow={mower}
      data-testid="dc-robot-art"
      className={cn('dc-robot h-auto w-32', className)}
    >
      <rect
        x={6}
        y={6}
        width={208}
        height={118}
        rx={12}
        fill="none"
        strokeWidth={2}
        className="stroke-border"
      />
      {mower ? (
        <g className="fill-success">
          {STRIPES.map((i) => (
            <rect
              key={i}
              x={16}
              y={16 + i * 21}
              width={166}
              height={17}
              rx={3}
              opacity={i < cut ? 0.5 : 0.22}
              data-cut={i < cut}
            />
          ))}
        </g>
      ) : (
        <path
          d="M24 34 H180 M180 64 H24 M24 94 H180"
          fill="none"
          strokeWidth={2}
          strokeDasharray="4 5"
          className="stroke-border"
        />
      )}
      <rect
        x={190}
        y={mower ? 48 : 52}
        width={mower ? 18 : 16}
        height={mower ? 34 : 26}
        rx={4}
        className={cn('dc-r-dock', activity === 'charge' ? 'fill-success' : 'fill-border')}
      />
      <g className="dc-r-mover">
        <g className={cn('dc-r-bot', BOT_TONE[activity])}>{mower ? <Mower /> : <Vacuum />}</g>
      </g>
      <g className="dc-r-zzz fill-foreground-muted text-[9px] font-bold">
        <text x={196} y={40}>
          z
        </text>
        <text x={203} y={32}>
          z
        </text>
        <text x={209} y={25}>
          z
        </text>
      </g>
      <path
        className="dc-r-bolt fill-warning stroke-warning"
        d={mower ? 'M199 46 l-6 12 h4 l-3 10 9-14 h-4z' : 'M199 50 l-6 12 h4 l-3 10 9-14 h-4z'}
      />
    </svg>
  )
}
