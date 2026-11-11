import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'
import type { ClimateRole } from './ClimateRoleGlyph'

export type ClimateActivity = 'off' | 'cool' | 'heat' | 'idle' | 'window' | 'unknown'

export interface ClimateFxProps {
  readonly role: ClimateRole
  readonly activity: ClimateActivity
  readonly swing: boolean
}

const TONE: Readonly<Record<ClimateActivity, string>> = {
  off: 'text-foreground-muted',
  idle: 'text-foreground-muted',
  unknown: 'text-foreground-muted',
  cool: 'text-info',
  heat: 'text-primary',
  window: 'text-info',
}

const streaks = (n: number): ReactElement[] => Array.from({ length: n }, (_, i) => <i key={i} />)

/** Which animation a (role, activity) pair plays; null is a still scene. */
export function climateFxKind(role: ClimateRole, activity: ClimateActivity): string | null {
  if (activity === 'off' || activity === 'unknown') return null
  if (activity === 'window') return 'draft'
  if (role === 'hpcircuit') return 'pipe'
  if (activity === 'idle') return role === 'ac' ? 'air' : 'breathe'
  if (role === 'ac') return 'air'
  if (role === 'thermostat') return 'particles'
  if (activity !== 'heat') return 'breathe'
  return role === 'floor' ? 'floor' : 'unit'
}

/** The animation behind a climate scene: what the role is doing right now. */
export function ClimateFx({ role, activity, swing }: ClimateFxProps): ReactElement | null {
  const kind = climateFxKind(role, activity)
  if (kind === null) return null
  const slow = activity === 'idle'
  return (
    <div aria-hidden data-fx={kind} className={cn('dc-fx', TONE[activity])}>
      {kind === 'draft' ? <div className="dc-fx-draft">{streaks(4)}</div> : null}
      {kind === 'air' ? (
        <div className="dc-fx-air" data-sway={swing} data-slow={slow}>
          {streaks(6)}
        </div>
      ) : null}
      {kind === 'particles' ? (
        <div className="dc-fx-p" data-dir={activity === 'heat' ? 'rise' : 'fall'}>
          {streaks(6)}
        </div>
      ) : null}
      {kind === 'breathe' ? <div className="dc-fx-breathe" /> : null}
      {kind === 'floor' ? (
        <>
          <div className="dc-fx-glow" />
          <div className="dc-fx-wisps" data-at="floor">
            {streaks(5)}
          </div>
        </>
      ) : null}
      {kind === 'unit' ? (
        <>
          {role === 'heater' ? <div className="dc-fx-glow" data-low /> : null}
          <div className="dc-fx-wisps" data-at="unit">
            {streaks(3)}
          </div>
        </>
      ) : null}
      {kind === 'pipe' ? (
        <svg className="dc-fx-pipe" viewBox="0 0 340 120" data-slow={slow}>
          <path className="dc-p0" d="M-10 20H300a20 20 0 0 1 0 40H40a20 20 0 0 0 0 40H350" />
          <path className="dc-p1" d="M-10 20H300a20 20 0 0 1 0 40H40a20 20 0 0 0 0 40H350" />
        </svg>
      ) : null}
    </div>
  )
}
