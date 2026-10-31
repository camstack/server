import type { ReactNode } from 'react'
import { Lock, LockOpen, DoorOpen } from 'lucide-react'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useUiText } from '../../contexts/ui-text'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice'
import { cn } from '../../lib/cn'
import type { LockControlStatus, LockState } from '@camstack/types'
import { DeviceFeature } from '@camstack/types'
import type { DeviceControlProps } from './control-registry'
import { SlideToggle } from './atoms'

// ── Cap type ──────────────────────────────────────────────────────────────────

type LockControlCap = {
  lock: (i: Record<string, never>) => Promise<void>
  unlock: (i: Record<string, never>) => Promise<void>
  open: (i: Record<string, never>) => Promise<void>
}

// ── State helpers ─────────────────────────────────────────────────────────────

/**
 * `locked` and `locking` are both "closed" — the slide targets "Unlock".
 * `unlocked` and `unlocking` are both "open" — the slide targets "Lock".
 * `jammed` keeps the last logical locked/closed position visually but
 * disables all interactions.
 */
function isLockedState(state: LockControlStatus['state']): boolean {
  return state === 'locked' || state === 'locking'
}

function isJammedState(state: LockControlStatus['state']): boolean {
  return state === 'jammed'
}

// ── Lock glyph ────────────────────────────────────────────────────────────────

/**
 * Per-state visual config for the padlock glyph.
 * `colorClass` is the Tailwind treatment applied to the circle wrapper.
 * `icon` determines which padlock variant to render.
 *
 * Exhaustive over `LockState` — adding a new state member without updating
 * this table is a compile error.
 */
type GlyphConfig = {
  readonly colorClass: string
  readonly icon: 'locked' | 'open'
}

const LOCK_STATE_GLYPH = {
  locked: { colorClass: 'border-success/30 bg-success/10 text-success', icon: 'locked' },
  locking: { colorClass: 'border-success/30 bg-success/10 text-success', icon: 'locked' },
  unlocked: { colorClass: 'border-warning/30 bg-warning/10 text-warning', icon: 'open' },
  unlocking: { colorClass: 'border-warning/30 bg-warning/10 text-warning', icon: 'open' },
  jammed: { colorClass: 'border-danger/30 bg-danger/10 text-danger', icon: 'locked' },
  'door-open': { colorClass: 'border-warning/30 bg-warning/10 text-warning', icon: 'open' },
} satisfies Record<LockState, GlyphConfig>

interface LockGlyphProps {
  readonly state: LockControlStatus['state']
}

/**
 * The padlock icon that reflects current lock state:
 *  - locked / locking   → closed padlock, success color (green)
 *  - unlocked/unlocking → open padlock, warning color (amber)
 *  - jammed             → closed padlock, danger color (red) — distinct treatment
 *
 * `data-testid="lock-glyph"` and `data-state={state}` for test assertions.
 */
function LockGlyph({ state }: LockGlyphProps): ReactNode {
  const config = LOCK_STATE_GLYPH[state]

  return (
    <div
      data-testid="lock-glyph"
      data-state={state}
      className={cn(
        'flex h-16 w-16 items-center justify-center rounded-full border-2',
        config.colorClass,
      )}
    >
      {config.icon === 'locked' ? (
        <Lock className="h-8 w-8" aria-hidden="true" />
      ) : (
        <LockOpen className="h-8 w-8" aria-hidden="true" />
      )}
    </div>
  )
}

// ── State label ───────────────────────────────────────────────────────────────

interface StateLabelProps {
  readonly state: LockControlStatus['state']
}

function StateLabel({ state }: StateLabelProps): ReactNode {
  const jammed = isJammedState(state)
  return (
    <span
      className={cn(
        'text-sm font-medium capitalize',
        jammed ? 'text-danger' : 'text-foreground-muted',
      )}
    >
      {state}
    </span>
  )
}

// ── Open (unlatch) button ─────────────────────────────────────────────────────

interface OpenButtonProps {
  readonly busy: boolean
  readonly onOpen: () => void
}

function OpenButton({ busy, onOpen }: OpenButtonProps): ReactNode {
  const t = useUiText()
  return (
    <button
      type="button"
      aria-label={t('uiLibrary.lockHeroCard.openUnlatch', 'Open (unlatch)')}
      title={t('uiLibrary.lockHeroCard.openUnlatch', 'Open (unlatch)')}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium',
        'text-foreground-muted hover:bg-surface-hover transition-colors',
        busy && 'opacity-40 cursor-not-allowed',
      )}
    >
      <DoorOpen className="h-3.5 w-3.5" aria-hidden="true" />
      {t('uiLibrary.lockHeroCard.open', 'Open')}
    </button>
  )
}

// ── LockHeroCard ──────────────────────────────────────────────────────────────

/**
 * LockHeroCard — padlock hero for lock devices.
 *
 * Renders:
 *  - Padlock glyph: state-colored (locked=green, unlocked=amber, jammed=red)
 *  - SlideToggle (safety gesture): thumb must be dragged past threshold to
 *    confirm lock/unlock — a plain tap never triggers the action (Spec §3).
 *  - Open (unlatch) button: rendered ONLY when device.features includes
 *    DeviceFeature.LockOpen ('lock-open'). Absent otherwise.
 *
 * Cap-gated: returns null when the device has no lockControl cap.
 */
export function LockHeroCard({
  trpc,
  deviceId,
  features,
  optimistic,
}: DeviceControlProps): ReactNode {
  const { cap, slice, available } = useDeviceCapability<LockControlCap, LockControlStatus>({
    trpc,
    deviceId,
    cap: (d) => d.lockControl as LockControlCap | undefined,
    slice: (d) => d.state.lockControl,
  })

  const { display, applyOptimistic } = useOptimisticSlice<LockControlStatus>(slice, {
    enabled: optimistic ?? true,
  })

  // Cap-gate: if the cap is not registered on this device, render nothing.
  if (cap === undefined) return null
  if (display === undefined) return null
  // A slice with no lock state (a helper lock group has none) has nothing to draw.
  if (!(display.state in LOCK_STATE_GLYPH)) return null

  const locked = isLockedState(display.state)
  const jammed = isJammedState(display.state)
  // Busy during jammed (motor failure) or when not available (no connection/cap offline)
  const busy = jammed || !available

  const supportsOpen = features?.includes(DeviceFeature.LockOpen) === true

  const handleToggle = (): void => {
    if (busy) return
    if (locked) {
      applyOptimistic({ state: 'unlocking' })
      void cap.unlock({})
    } else {
      applyOptimistic({ state: 'locking' })
      void cap.lock({})
    }
  }

  const handleOpen = (): void => {
    if (busy) return
    void cap.open({})
  }

  // The slide label indicates what action the gesture will perform (the target state).
  const slideTargetLabel = locked ? 'Unlock' : 'Lock'

  return (
    <div className="flex flex-col items-stretch gap-4 rounded-lg border border-border bg-surface p-4">
      {/* ── Header: padlock glyph + state label ────────────────────────────── */}
      <div className="flex flex-col items-center gap-2">
        <LockGlyph state={display.state} />
        <StateLabel state={display.state} />
      </div>

      {/* ── Safety slide: lock ↔ unlock ─────────────────────────────────────── */}
      <div className={cn(busy && 'pointer-events-none opacity-40')}>
        <SlideToggle on={locked} targetLabel={slideTargetLabel} onConfirm={handleToggle} />
      </div>

      {/* ── Open (unlatch) button: gated on DeviceFeature.LockOpen ──────────── */}
      {supportsOpen && (
        <div className="flex justify-center">
          <OpenButton busy={busy} onOpen={handleOpen} />
        </div>
      )}
    </div>
  )
}
