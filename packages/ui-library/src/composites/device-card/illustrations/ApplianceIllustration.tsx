import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'

export type ApplianceKind = 'washer' | 'dryer' | 'dish'

export interface ApplianceIllustrationProps {
  readonly kind: ApplianceKind
  /** The cycle runs: the drum turns (the dishwasher's spray arm sweeps). */
  readonly running: boolean
  /** The machine is in a cycle (running or paused): the door is lit. */
  readonly lit: boolean
  /** 0..100 of the cycle done, drawn as the ring; null draws no ring. */
  readonly progress: number | null
  readonly label: string
  readonly className?: string
}

const DRYER_HOLES = [0, 60, 120, 180, 240, 300].map((deg) => ({
  cx: Number((60 + 18 * Math.cos((deg * Math.PI) / 180)).toFixed(1)),
  cy: Number((74 + 18 * Math.sin((deg * Math.PI) / 180)).toFixed(1)),
}))

function Drum({
  kind,
  lit,
  progress,
}: Pick<ApplianceIllustrationProps, 'kind' | 'lit' | 'progress'>): ReactElement {
  return (
    <>
      <circle cx={60} cy={74} r={41} fill="none" strokeWidth={3} className="stroke-border" />
      {progress === null ? null : (
        <circle
          cx={60}
          cy={74}
          r={41}
          fill="none"
          strokeWidth={3}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${Math.round(progress)} 100`}
          transform="rotate(-90 60 74)"
          className="dc-ring stroke-primary"
          data-testid="dc-appliance-ring"
        />
      )}
      <circle
        cx={60}
        cy={74}
        r={34}
        strokeWidth={4}
        className={lit ? 'fill-primary/15 stroke-primary' : 'fill-none stroke-foreground-muted'}
      />
      <g className={cn('dc-drum', lit ? 'text-primary' : 'text-foreground-muted')}>
        {kind === 'dryer' ? (
          <>
            {DRYER_HOLES.map((h) => (
              <circle key={`${h.cx}-${h.cy}`} cx={h.cx} cy={h.cy} r={3.2} fill="currentColor" />
            ))}
            <circle cx={60} cy={74} r={4} fill="currentColor" />
          </>
        ) : (
          <path
            d="M40 74a20 20 0 0 1 40 0"
            fill="none"
            stroke="currentColor"
            strokeWidth={4}
            strokeLinecap="round"
          />
        )}
      </g>
    </>
  )
}

function Racks({
  lit,
  progress,
}: Pick<ApplianceIllustrationProps, 'lit' | 'progress'>): ReactElement {
  const tone = lit ? 'fill-primary/15 stroke-primary' : 'fill-none stroke-foreground-muted'
  return (
    <>
      <line
        x1={12}
        y1={13}
        x2={70}
        y2={13}
        strokeWidth={3}
        strokeLinecap="round"
        className="stroke-border"
      />
      {progress === null ? null : (
        <line
          x1={12}
          y1={13}
          x2={70}
          y2={13}
          strokeWidth={3}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${Math.round(progress)} 100`}
          className="dc-ring stroke-primary"
          data-testid="dc-appliance-ring"
        />
      )}
      <rect
        x={80}
        y={9}
        width={26}
        height={8}
        rx={2}
        fill="none"
        strokeWidth={2}
        className="stroke-border"
      />
      <g strokeWidth={2.5} className={tone}>
        <path d="M24 58a12 12 0 0 1 24 0Z" />
        <path d="M50 58a12 12 0 0 1 24 0Z" />
        <path d="M76 58a12 12 0 0 1 20 0Z" />
        <rect x={26} y={74} width={14} height={14} rx={3} />
        <rect x={46} y={74} width={14} height={14} rx={3} />
        <rect x={66} y={78} width={26} height={10} rx={3} />
      </g>
      <line x1={14} y1={59} x2={106} y2={59} strokeWidth={2} className="stroke-foreground-muted" />
      <line x1={14} y1={89} x2={106} y2={89} strokeWidth={2} className="stroke-foreground-muted" />
      <g className={cn('dc-drum', lit ? 'text-primary' : 'text-foreground-muted')}>
        <line
          x1={36}
          y1={106}
          x2={84}
          y2={106}
          stroke="currentColor"
          strokeWidth={4}
          strokeLinecap="round"
        />
        <circle cx={60} cy={106} r={3.5} fill="currentColor" />
      </g>
    </>
  )
}

/**
 * A washer, a dryer or a dishwasher seen from the front: the drum (the racks)
 * behind the door, the cycle's progress as a ring (a bar on the dishwasher's
 * panel). The drum turns while it runs; reduced motion keeps it still.
 */
export function ApplianceIllustration({
  kind,
  running,
  lit,
  progress,
  label,
  className,
}: ApplianceIllustrationProps): ReactElement {
  return (
    <svg
      viewBox="0 0 120 128"
      role="img"
      aria-label={label}
      data-kind={kind}
      data-run={running}
      data-testid="dc-appliance-art"
      className={cn('dc-appl h-32 w-30', className)}
    >
      <rect
        x={4}
        y={4}
        width={112}
        height={120}
        rx={kind === 'dish' ? 10 : 14}
        fill="none"
        strokeWidth={3}
        className="stroke-foreground-muted"
      />
      <line
        x1={4}
        y1={kind === 'dish' ? 22 : 24}
        x2={116}
        y2={kind === 'dish' ? 22 : 24}
        strokeWidth={2}
        className="stroke-border"
      />
      {kind === 'dryer' ? (
        <rect
          x={80}
          y={10}
          width={26}
          height={8}
          rx={2}
          fill="none"
          strokeWidth={2}
          className="stroke-border"
        />
      ) : null}
      {kind === 'dish' ? (
        <Racks lit={lit} progress={progress} />
      ) : (
        <Drum kind={kind} lit={lit} progress={progress} />
      )}
    </svg>
  )
}
