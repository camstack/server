/**
 * The animated parts of the media-player hero: the power orb and the running
 * indicator. Motion is transform / opacity only, plays only while the state
 * says so, and stops under `prefers-reduced-motion` (the state is still told
 * by colour, icon and text, never by motion alone).
 */
import { HelpCircle, Loader2, Pause, Power } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import type { PowerView, RunningView } from '@camstack/types'

export const MEDIA_HERO_KEYFRAMES = `
@keyframes mph-eq { 0%, 100% { transform: scaleY(.3) } 50% { transform: scaleY(1) } }
@keyframes mph-halo { 0% { transform: scale(.92); opacity: .55 } 100% { transform: scale(1.4); opacity: 0 } }
.mph-eq { transform-origin: bottom; animation: mph-eq 1s ease-in-out infinite; }
.mph-eq:nth-child(2) { animation-duration: .8s; animation-delay: -.3s; }
.mph-eq:nth-child(3) { animation-duration: 1.2s; animation-delay: -.6s; }
.mph-eq:nth-child(4) { animation-duration: .9s; animation-delay: -.1s; }
.mph-halo { animation: mph-halo 2.8s ease-out infinite; }
@keyframes mph-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes mph-out { from { opacity: 1 } to { opacity: 0 } }
.mph-fade-in { animation: mph-in .6s ease-out both; }
.mph-fade-out { animation: mph-out .6s ease-out both; }
@media (prefers-reduced-motion: reduce) {
  .mph-eq, .mph-halo, .mph-fade-in, .mph-fade-out { animation: none !important; }
  .mph-fade-out { opacity: 0; }
  .mph-eq:nth-child(odd) { transform: scaleY(.6); }
  .mph-halo { opacity: 0; }
}
`

const ORB_TONE: Readonly<Record<PowerView, string>> = {
  on: 'border-success bg-success/15 text-success shadow-lg shadow-success/30',
  standby: 'border-warning bg-warning/10 text-warning',
  off: 'border-border bg-surface-hover text-foreground-subtle',
  unknown: 'border-dashed border-border bg-transparent text-foreground-subtle',
}

interface PowerOrbProps {
  readonly power: PowerView
  /** Present = the orb is the power switch. */
  readonly onPress: (() => void) | undefined
  readonly label: string
  readonly busy: boolean
}

/** The device's power: a glowing ring when on, amber in standby, flat when off, dashed when unknown. */
export function PowerOrb({ power, onPress, label, busy }: PowerOrbProps): ReactNode {
  const body = (
    <>
      {power === 'unknown' ? (
        <HelpCircle className="h-7 w-7" aria-hidden="true" />
      ) : (
        <Power className="h-7 w-7" aria-hidden="true" />
      )}
    </>
  )
  const classes = cn(
    'relative z-10 inline-flex h-16 w-16 items-center justify-center rounded-full border-2',
    'transition-all duration-500 motion-reduce:transition-none',
    ORB_TONE[power],
  )
  return (
    <div className="relative flex h-20 w-20 items-center justify-center" data-power={power}>
      {power === 'on' && (
        <span
          aria-hidden="true"
          data-testid="media-power-halo"
          className="mph-halo absolute h-16 w-16 rounded-full bg-success/25"
        />
      )}
      {onPress === undefined ? (
        <span className={classes} data-testid="media-power" role="img" aria-label={label}>
          {body}
        </span>
      ) : (
        // ui-check-ok: round state-toned control (transport key / mute / power orb); no IconButton size
        <button
          type="button"
          aria-label={label}
          title={label}
          disabled={busy}
          data-testid="media-power"
          onClick={(e) => {
            e.stopPropagation()
            if (!busy) onPress()
          }}
          className={cn(
            classes,
            'hover:brightness-110 active:scale-95',
            busy && 'cursor-not-allowed opacity-40',
          )}
        >
          {body}
        </button>
      )}
    </div>
  )
}

const EQ_BARS = [0, 1, 2, 3] as const

interface RunningIndicatorProps {
  readonly running: RunningView
}

/** Equalizer while playing, a spinner while buffering, a pause glyph when paused; nothing otherwise. */
export function RunningIndicator({ running }: RunningIndicatorProps): ReactNode {
  if (running === 'playing') {
    return (
      <span
        className="inline-flex h-4 items-end gap-0.5 text-primary"
        data-testid="media-running"
        data-running="playing"
        aria-hidden="true"
      >
        {EQ_BARS.map((bar) => (
          <span key={bar} className="mph-eq h-4 w-1 rounded-full bg-primary" />
        ))}
      </span>
    )
  }
  if (running === 'buffering') {
    return (
      <Loader2
        className="h-4 w-4 animate-spin text-foreground-muted motion-reduce:animate-none"
        data-testid="media-running"
        data-running="buffering"
        aria-hidden="true"
      />
    )
  }
  if (running === 'paused') {
    return (
      <Pause
        className="h-4 w-4 text-foreground-muted"
        data-testid="media-running"
        data-running="paused"
        aria-hidden="true"
      />
    )
  }
  return null
}
