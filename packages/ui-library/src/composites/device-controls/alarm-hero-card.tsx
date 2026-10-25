import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Shield, ShieldCheck, ShieldAlert, ShieldOff } from 'lucide-react'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice'
import { useUiText, type UiTextFn } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'
import type { AlarmPanelStatus, AlarmState, AlarmArmMode } from '@camstack/types'
import type { DeviceControlProps } from './control-registry'

// ── Cap surface ───────────────────────────────────────────────────────────────
// Named cap type; the accessor performs the documented cap-access boundary
// narrowing (mirrors lock-hero-card.tsx). Inputs omit `deviceId` — the device
// proxy injects it before forwarding.

type AlarmPanelCap = {
  arm: (i: { mode: AlarmArmMode; code?: string }) => Promise<void>
  disarm: (i: { code?: string }) => Promise<void>
}

// ── State → visual config (exhaustive over AlarmState) ──────────────────────────

interface StateConfig {
  readonly colorClass: string
  readonly icon: 'disarmed' | 'armed' | 'pending' | 'triggered'
}

const ALARM_STATE_CONFIG = {
  disarmed: {
    colorClass: 'border-border bg-surface-subtle text-foreground-subtle',
    icon: 'disarmed',
  },
  armed_home: {
    colorClass: 'border-success/30 bg-success/10 text-success',
    icon: 'armed',
  },
  armed_away: {
    colorClass: 'border-success/30 bg-success/10 text-success',
    icon: 'armed',
  },
  armed_night: {
    colorClass: 'border-success/30 bg-success/10 text-success',
    icon: 'armed',
  },
  armed_vacation: {
    colorClass: 'border-success/30 bg-success/10 text-success',
    icon: 'armed',
  },
  armed_custom_bypass: {
    colorClass: 'border-success/30 bg-success/10 text-success',
    icon: 'armed',
  },
  arming: {
    colorClass: 'border-warning/30 bg-warning/10 text-warning',
    icon: 'pending',
  },
  disarming: {
    colorClass: 'border-warning/30 bg-warning/10 text-warning',
    icon: 'pending',
  },
  pending: {
    colorClass: 'border-warning/30 bg-warning/10 text-warning',
    icon: 'pending',
  },
  triggered: {
    colorClass: 'border-danger/30 bg-danger/10 text-danger',
    icon: 'triggered',
  },
} satisfies Record<AlarmState, StateConfig>

// ── Arm-mode button labels (exhaustive over AlarmArmMode) ───────────────────────

function armModeLabel(mode: AlarmArmMode, t: UiTextFn): string {
  switch (mode) {
    case 'home':
      return t('uiLibrary.alarmHeroCard.modeHome', 'Home')
    case 'away':
      return t('uiLibrary.alarmHeroCard.modeAway', 'Away')
    case 'night':
      return t('uiLibrary.alarmHeroCard.modeNight', 'Night')
    case 'vacation':
      return t('uiLibrary.alarmHeroCard.modeVacation', 'Vacation')
    case 'custom_bypass':
      return t('uiLibrary.alarmHeroCard.modeBypass', 'Bypass')
  }
}

function alarmStateLabel(state: AlarmState, t: UiTextFn): string {
  switch (state) {
    case 'disarmed':
      return t('uiLibrary.alarmHeroCard.stateDisarmed', 'Disarmed')
    case 'armed_home':
      return t('uiLibrary.alarmHeroCard.stateArmedHome', 'Armed Home')
    case 'armed_away':
      return t('uiLibrary.alarmHeroCard.stateArmedAway', 'Armed Away')
    case 'armed_night':
      return t('uiLibrary.alarmHeroCard.stateArmedNight', 'Armed Night')
    case 'armed_vacation':
      return t('uiLibrary.alarmHeroCard.stateArmedVacation', 'Armed Vacation')
    case 'armed_custom_bypass':
      return t('uiLibrary.alarmHeroCard.stateArmedBypass', 'Armed (Bypass)')
    case 'arming':
      return t('uiLibrary.alarmHeroCard.stateArming', 'Arming…')
    case 'disarming':
      return t('uiLibrary.alarmHeroCard.stateDisarming', 'Disarming…')
    case 'pending':
      return t('uiLibrary.alarmHeroCard.statePending', 'Pending')
    case 'triggered':
      return t('uiLibrary.alarmHeroCard.stateTriggered', 'Triggered')
  }
}

/** The slice `state` is "armed_*" iff the panel is currently armed. */
function isArmedState(state: AlarmState): boolean {
  return state.startsWith('armed_')
}

/** Arming/disarming are in-flight transitions — no segment is "active". */
function isTransitioningState(state: AlarmState): boolean {
  return state === 'arming' || state === 'disarming'
}

// ── State glyph ─────────────────────────────────────────────────────────────

interface AlarmGlyphProps {
  readonly icon: StateConfig['icon']
  /** Tailwind size classes. The hero is large; the row badge is not. */
  readonly sizeClass?: string
}

function AlarmGlyph({ icon, sizeClass = 'h-8 w-8' }: AlarmGlyphProps): ReactNode {
  if (icon === 'disarmed') return <ShieldOff className={sizeClass} aria-hidden="true" />
  if (icon === 'triggered') return <ShieldAlert className={sizeClass} aria-hidden="true" />
  if (icon === 'pending') return <Shield className={sizeClass} aria-hidden="true" />
  return <ShieldCheck className={sizeClass} aria-hidden="true" />
}

// ── Segmented control ─────────────────────────────────────────────────────────

interface SegmentProps {
  readonly label: string
  readonly active: boolean
  readonly busy: boolean
  readonly onSelect: () => void
}

function Segment({ label, active, busy, onSelect }: SegmentProps): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation()
        if (!busy) onSelect()
      }}
      className={cn(
        'flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors',
        active
          ? 'bg-primary text-primary-foreground shadow-sm'
          : 'text-foreground-muted hover:bg-surface-hover',
        busy && 'opacity-40 cursor-not-allowed',
      )}
    >
      {label}
    </button>
  )
}

// ── AlarmSegments (shared Disarm + arm-mode strip) ──────────────────────────

interface AlarmSegmentsProps {
  /** Current lifecycle state — drives which segment is highlighted. */
  readonly state: AlarmState
  /** Arm modes the panel advertises (one arm segment per entry). */
  readonly availableModes: readonly AlarmArmMode[]
  /** True while the provider is unavailable — disables every segment. */
  readonly busy: boolean
  readonly onDisarm: () => void
  readonly onArm: (mode: AlarmArmMode) => void
}

/**
 * The segmented Disarm + arm-per-mode strip shared by the hero and the
 * row-sized inline control. No glyph, no label, no card chrome — purely the
 * segment row. Transitioning states (arming/disarming) leave NO segment
 * highlighted so the Disarm button does not look active mid-arm.
 */
function AlarmSegments({
  state,
  availableModes,
  busy,
  onDisarm,
  onArm,
}: AlarmSegmentsProps): ReactNode {
  const t = useUiText()
  const armed = isArmedState(state)
  const transitioning = isTransitioningState(state)
  return (
    <div
      className={cn(
        'flex min-w-0 items-stretch gap-1 rounded-lg border border-border bg-surface-subtle p-1',
      )}
    >
      <Segment
        label={t('uiLibrary.alarmHeroCard.disarm', 'Disarm')}
        active={!armed && !transitioning}
        busy={busy}
        onSelect={onDisarm}
      />
      {availableModes.map((mode) => (
        <Segment
          key={mode}
          label={armModeLabel(mode, t)}
          active={!transitioning && state === `armed_${mode}`}
          busy={busy}
          onSelect={() => onArm(mode)}
        />
      ))}
    </div>
  )
}

// ── Shared cap subscription + handlers ──────────────────────────────────────

interface UseAlarmControl {
  readonly display: AlarmPanelStatus | undefined
  readonly capPresent: boolean
  readonly busy: boolean
  readonly handleDisarm: () => void
  readonly handleArm: (mode: AlarmArmMode) => void
  /** The message of the last rejected arm/disarm, or null once cleared. */
  readonly error: string | null
  /** Dismiss the current error without waiting for the next slice change. */
  readonly clearError: () => void
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Subscribes to the alarm-panel cap ONCE and exposes the disarm/arm handlers
 * with optimistic state updates. Both the hero and the inline control consume
 * this, so the cap is never double-subscribed.
 *
 * A rejected `arm`/`disarm` (the panel refusing, per D630) is never swallowed:
 * the optimistic patch is rolled back to the real slice and the rejection's
 * message is surfaced through `error`, which callers render. `error` also
 * clears on its own the next time a real slice arrives — a fresh server push
 * means the refusal is no longer the last word on the panel's state.
 *
 * A rejection is only ever the LATEST press's business. Each call captures a
 * fresh token; if a second press starts before the first's promise settles,
 * the first press's eventual rejection must not roll back or error over the
 * second press's still-pending optimistic state — the token check makes a
 * stale rejection a no-op instead.
 */
function useAlarmControl(
  trpc: DeviceControlProps['trpc'],
  deviceId: number,
  optimistic: boolean | undefined,
): UseAlarmControl {
  const { cap, slice, available } = useDeviceCapability<AlarmPanelCap, AlarmPanelStatus>({
    trpc,
    deviceId,
    cap: (d) => d.alarmPanel as AlarmPanelCap | undefined,
    slice: (d) => d.state.alarmPanel,
  })

  const { display, applyOptimistic, rollback } = useOptimisticSlice<AlarmPanelStatus>(slice, {
    enabled: optimistic ?? true,
  })

  const [error, setError] = useState<string | null>(null)
  const clearError = (): void => setError(null)

  // Bumped on every arm/disarm press. A `.catch` compares its own snapshot
  // against the current value before acting — a newer press already bumped
  // it, so the stale rejection is dropped.
  const latestCallRef = useRef(0)

  // A fresh push from the server supersedes any refusal shown for the
  // attempt that preceded it — clear on the NEXT successful slice change.
  useEffect(() => {
    setError(null)
  }, [slice])

  const busy = !available

  const handleDisarm = (): void => {
    if (cap === undefined || busy) return
    const call = ++latestCallRef.current
    applyOptimistic({ state: 'disarming' })
    cap.disarm({}).catch((err: unknown) => {
      if (latestCallRef.current !== call) return
      rollback()
      setError(messageOf(err))
    })
  }

  const handleArm = (mode: AlarmArmMode): void => {
    if (cap === undefined || busy) return
    const call = ++latestCallRef.current
    applyOptimistic({ state: 'arming' })
    cap.arm({ mode }).catch((err: unknown) => {
      if (latestCallRef.current !== call) return
      rollback()
      setError(messageOf(err))
    })
  }

  return {
    display,
    capPresent: cap !== undefined,
    busy,
    handleDisarm,
    handleArm,
    error,
    clearError,
  }
}

// ── AlarmInlineControl (row-sized) ──────────────────────────────────────────

/**
 * Row-sized alarm control: the shared Disarm + arm-mode segment strip only —
 * no glyph, no state label, no card padding. Cap-gated on `alarm-panel`.
 * Drops into a 200 px control column without towering over sibling rows.
 */
/**
 * The row/card-sized alarm control — ONE LINE, always.
 *
 * Two earlier attempts were wrong in instructive ways. The first rendered only
 * the segment strip, so the sole sign a panel was armed was which of four
 * buttons happened to be highlighted — and in a grid card the strip overflowed
 * and cut that button off. The second let the strip WRAP, which stopped the
 * overflow by making the row two and three lines tall.
 *
 * A state badge plus four buttons does not fit a phone-width row, and no amount
 * of sizing makes it. So the row shows what a row is for — **the state** — and
 * offers the modes through a select, which is one line at any width. The four
 * segments live in the hero, where there is room for them.
 *
 * A refusal (D630) still has to be visible here, one line or not — it is a
 * small danger badge (icon only, `title` carries the full message, same
 * pattern as `OfflineBadge`) appended after the select. It never grows the
 * row past one line.
 */
export function AlarmInlineControl({ trpc, deviceId, optimistic }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { display, capPresent, busy, handleDisarm, handleArm, error } = useAlarmControl(
    trpc,
    deviceId,
    optimistic,
  )

  if (!capPresent) return null
  if (display === undefined) return null

  const config = ALARM_STATE_CONFIG[display.state]
  const current = isArmedState(display.state) ? display.state.replace('armed_', '') : ''

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap',
          config.colorClass,
          isTransitioningState(display.state) && 'animate-pulse',
        )}
      >
        <AlarmGlyph icon={config.icon} sizeClass="h-3 w-3" />
        {alarmStateLabel(display.state, t)}
      </span>
      <select
        aria-label={t('uiLibrary.alarmHeroCard.alarmMode', 'Alarm mode')}
        disabled={busy}
        value={current}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          e.stopPropagation()
          const next = e.target.value
          if (next === '') handleDisarm()
          else handleArm(next as AlarmArmMode)
        }}
        className={cn(
          'min-w-0 shrink rounded-md border border-border bg-surface-subtle px-1.5 py-0.5 text-xs text-foreground-muted',
          busy && 'cursor-not-allowed opacity-40',
        )}
      >
        <option value="">{t('uiLibrary.alarmHeroCard.disarm', 'Disarm')}</option>
        {display.availableModes.map((mode) => (
          <option key={mode} value={mode}>
            {armModeLabel(mode, t)}
          </option>
        ))}
      </select>
      {error !== null && (
        <span
          data-testid="alarm-inline-error"
          role="alert"
          title={error}
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger"
        >
          <ShieldAlert className="h-3 w-3" aria-hidden="true" />
        </span>
      )}
    </div>
  )
}

// ── AlarmHeroCard ─────────────────────────────────────────────────────────────

/**
 * AlarmHeroCard — segmented arm/disarm hero for AlarmPanel devices.
 *
 * Renders (Spec §3):
 *  - A shield glyph + state label tinted by lifecycle state (disarmed=muted,
 *    armed=green, arming/pending=amber, triggered=red).
 *  - The shared `AlarmSegments` strip: a Disarm button plus one arm button per
 *    `availableModes` entry (Home / Away / Night / …). The currently-active
 *    segment is highlighted; transitioning states highlight none.
 *
 * Cap-gated on `alarm-panel` — returns null when the device lacks the cap.
 * PIN entry (when `requiresCode`) is deferred to a later task; the segments
 * call arm/disarm without a code, and the provider rejects when a code is
 * required — surfaced upstream.
 *
 * A refusal (D630: an open device, a required code, …) is never a swallowed
 * promise — `useAlarmControl` rolls the optimistic state back and hands the
 * rejection's message back as `error`, rendered below the segments.
 */
export function AlarmHeroCard({ trpc, deviceId, optimistic }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { display, capPresent, busy, handleDisarm, handleArm, error, clearError } = useAlarmControl(
    trpc,
    deviceId,
    optimistic,
  )

  if (!capPresent) return null
  if (display === undefined) return null

  const config = ALARM_STATE_CONFIG[display.state]

  return (
    <div className="flex flex-col items-stretch gap-4 rounded-lg border border-border bg-surface p-6">
      {/* ── State glyph + label ─────────────────────────────────────────────── */}
      <div className="flex flex-col items-center gap-2">
        <div
          data-testid="alarm-state"
          data-state={display.state}
          className={cn(
            'flex h-16 w-16 items-center justify-center rounded-full border-2',
            config.colorClass,
            // `arming` and `pending` are the two states this panel has that a
            // mirrored one never produced, and they are the ones an operator is
            // actually watching — "am I still allowed to walk out?". A ring
            // that looks identical to a settled state wastes them.
            isTransitioningState(display.state) && 'animate-pulse',
          )}
        >
          <AlarmGlyph icon={config.icon} />
        </div>
        <span className={cn('text-sm font-medium', config.colorClass, 'border-0 bg-transparent')}>
          {alarmStateLabel(display.state, t)}
        </span>
      </div>

      {/* ── Segmented Disarm / arm-mode controls ────────────────────────────── */}
      <AlarmSegments
        state={display.state}
        availableModes={display.availableModes}
        busy={busy}
        onDisarm={handleDisarm}
        onArm={handleArm}
      />

      {/* ── Refusal (D630) — never a swallowed rejection ────────────────────── */}
      {error !== null && (
        <div
          data-testid="alarm-error"
          role="alert"
          className="flex items-start justify-between gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          <span>{error}</span>
          <button
            type="button"
            aria-label={t('uiLibrary.alarmHeroCard.dismiss', 'Dismiss')}
            onClick={(e) => {
              e.stopPropagation()
              clearError()
            }}
            className="shrink-0 font-medium text-danger/80 hover:text-danger"
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
}
