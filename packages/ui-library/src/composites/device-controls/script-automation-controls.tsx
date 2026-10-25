import type { ReactNode } from 'react'
import { AlertTriangle, CircleStop, Play, Zap } from 'lucide-react'
import type { AutomationControlStatus, ScriptRunnerStatus } from '@camstack/types'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice'
import { cn } from '../../lib/cn'
import { defaultUiText, useUiText, type UiTextFn } from '../../contexts/ui-text'
import type { DeviceControlProps } from './control-registry'

/**
 * Script and Automation controls.
 *
 * Both device types carried real caps (`script-runner`, `automation-control`)
 * with real runtime state from the day they shipped, and both resolved to
 * control kind `dummy` — so the one thing an operator wants from a script
 * ("run it") and from an automation ("is this on?") rendered as "Controls
 * coming soon".
 *
 * The two are deliberately in one file: they are the same shape (a thing that
 * runs, a last-run instant, an error) differing in one button, and splitting
 * them would duplicate the timestamp and error rendering that is most of the
 * work.
 *
 * **What the upstream provider does NOT give you**, and why this UI is careful:
 * the Home Assistant provider — the only thing that creates these devices —
 * never writes `lastError` or `lastRunSuccess` for a script, and never writes
 * `isRunning` for an automation. Those fields are carried over from the
 * previous slice forever. So the error line renders only when a message
 * actually exists, and the automation card does NOT claim to show whether a
 * run is in progress. Rendering a permanently-empty "Last error: —" would read
 * as "verified, no errors", which is the opposite of the truth.
 */

// ── Cap surfaces ────────────────────────────────────────────────────────────
// Inputs omit `deviceId` — the device proxy injects it before forwarding.

type ScriptRunnerCap = {
  run: (i: { variables?: Record<string, unknown> }) => Promise<void>
  stop: (i: Record<string, never>) => Promise<void>
}

type AutomationControlCap = {
  enable: (i: Record<string, never>) => Promise<void>
  disable: (i: Record<string, never>) => Promise<void>
  trigger: (i: { skipCondition?: boolean }) => Promise<void>
}

// ── Shared bits ─────────────────────────────────────────────────────────────

/**
 * "3 min ago", or nothing at all.
 *
 * **0 means NEVER RUN** on both status schemas, and it must not render as the
 * epoch. "1 Jan 1970" next to a script is the kind of detail that sends an
 * operator looking for a clock problem that does not exist.
 */
export function lastRunLabel(
  atMs: number,
  nowMs: number,
  t: UiTextFn = defaultUiText,
): string | null {
  if (atMs <= 0) return null
  const deltaSec = Math.max(0, Math.round((nowMs - atMs) / 1000))
  if (deltaSec < 60) return t('uiLibrary.scriptAutomationControls.justNow', 'just now')
  if (deltaSec < 3600)
    return t('uiLibrary.scriptAutomationControls.minAgo', '{{count}} min ago', {
      count: Math.floor(deltaSec / 60),
    })
  if (deltaSec < 86_400)
    return t('uiLibrary.scriptAutomationControls.hAgo', '{{count}} h ago', {
      count: Math.floor(deltaSec / 3600),
    })
  return new Date(atMs).toLocaleDateString()
}

interface LastRunProps {
  readonly atMs: number
  readonly neverLabel: string
}

function LastRun({ atMs, neverLabel }: LastRunProps): ReactNode {
  const t = useUiText()
  const label = lastRunLabel(atMs, Date.now(), t)
  return (
    <span className="text-xs text-foreground-subtle" data-testid="last-run">
      {label === null ? neverLabel : label}
    </span>
  )
}

interface LastErrorProps {
  readonly error: string | null
}

/** Rendered ONLY when a message exists — see the file docblock. */
function LastError({ error }: LastErrorProps): ReactNode {
  if (error === null || error === '') return null
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-danger"
      title={error}
      data-testid="last-error"
    >
      <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{error}</span>
    </span>
  )
}

// ── Script ──────────────────────────────────────────────────────────────────

interface UseScriptControl {
  readonly display: ScriptRunnerStatus | undefined
  readonly capPresent: boolean
  readonly busy: boolean
  readonly running: boolean
  readonly run: () => void
  readonly stop: () => void
}

/**
 * Subscribes to `script-runner` ONCE, so the hero and the inline control never
 * double-subscribe. Mirrors `useAlarmControl`.
 */
function useScriptControl(
  trpc: DeviceControlProps['trpc'],
  deviceId: number,
  optimistic: boolean | undefined,
): UseScriptControl {
  const { cap, slice, available } = useDeviceCapability<ScriptRunnerCap, ScriptRunnerStatus>({
    trpc,
    deviceId,
    cap: (d) => d.scriptRunner as ScriptRunnerCap | undefined,
    slice: (d) => d.state.scriptRunner,
  })
  const { display, applyOptimistic } = useOptimisticSlice<ScriptRunnerStatus>(slice, {
    enabled: optimistic ?? true,
  })
  const busy = !available
  const running = display?.isRunning === true

  return {
    display,
    capPresent: cap !== undefined,
    busy,
    running,
    run: () => {
      if (cap === undefined || busy || running) return
      applyOptimistic({ isRunning: true })
      void cap.run({})
    },
    stop: () => {
      if (cap === undefined || busy || !running) return
      applyOptimistic({ isRunning: false })
      void cap.stop({})
    },
  }
}

/**
 * One button that flips between Run and Stop.
 *
 * Not two buttons: a Stop that is disabled 99% of the time is a permanent
 * invitation to click something that does nothing, and the two actions are
 * mutually exclusive by definition.
 */
interface RunButtonProps {
  readonly running: boolean
  readonly busy: boolean
  readonly large: boolean
  readonly onRun: () => void
  readonly onStop: () => void
}

function RunButton({ running, busy, large, onRun, onStop }: RunButtonProps): ReactNode {
  const t = useUiText()
  const label = running
    ? t('uiLibrary.scriptAutomationControls.stop', 'Stop')
    : t('uiLibrary.scriptAutomationControls.run', 'Run')
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={busy}
      data-testid="script-run"
      data-running={running ? 'true' : 'false'}
      onClick={(e) => {
        e.stopPropagation()
        if (running) onStop()
        else onRun()
      }}
      className={cn(
        'inline-flex items-center gap-1 rounded transition-colors',
        large ? 'h-10 px-4 text-sm' : 'h-5 px-1.5 text-xs',
        running
          ? 'bg-danger text-danger-foreground hover:bg-danger/90'
          : 'bg-primary text-primary-foreground hover:bg-primary/90',
        busy && 'cursor-not-allowed opacity-40',
      )}
    >
      {running ? (
        <CircleStop className={large ? 'h-4 w-4' : 'h-3 w-3'} aria-hidden="true" />
      ) : (
        <Play className={large ? 'h-4 w-4' : 'h-3 w-3'} aria-hidden="true" />
      )}
      <span>{label}</span>
    </button>
  )
}

export function ScriptInlineControl({ trpc, deviceId, optimistic }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { display, capPresent, busy, running, run, stop } = useScriptControl(
    trpc,
    deviceId,
    optimistic,
  )
  if (!capPresent) return null
  if (display === undefined) return null

  return (
    <div className="flex min-w-0 items-center gap-2">
      <RunButton running={running} busy={busy} large={false} onRun={run} onStop={stop} />
      <LastRun
        atMs={display.lastRunAt}
        neverLabel={t('uiLibrary.scriptAutomationControls.neverRun', 'never run')}
      />
    </div>
  )
}

export function ScriptHeroCard({ trpc, deviceId, optimistic }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { display, capPresent, busy, running, run, stop } = useScriptControl(
    trpc,
    deviceId,
    optimistic,
  )
  if (!capPresent) return null
  if (display === undefined) return null

  return (
    <div className="flex flex-col items-stretch gap-4 rounded-lg border border-border bg-surface p-6">
      <div className="flex flex-col items-center gap-2">
        <div
          data-testid="script-state"
          data-running={running ? 'true' : 'false'}
          className={cn(
            'flex h-16 w-16 items-center justify-center rounded-full border-2',
            running
              ? 'border-primary text-primary animate-pulse'
              : 'border-border text-foreground-subtle',
          )}
        >
          <Play className="h-8 w-8" aria-hidden="true" />
        </div>
        <span className="text-sm font-medium">
          {running
            ? t('uiLibrary.scriptAutomationControls.running', 'Running')
            : t('uiLibrary.scriptAutomationControls.idle', 'Idle')}
        </span>
        <LastRun
          atMs={display.lastRunAt}
          neverLabel={t('uiLibrary.scriptAutomationControls.neverRun', 'never run')}
        />
        <LastError error={display.lastError} />
      </div>
      <div className="flex justify-center">
        <RunButton running={running} busy={busy} large={true} onRun={run} onStop={stop} />
      </div>
    </div>
  )
}

// ── Automation ──────────────────────────────────────────────────────────────

interface UseAutomationControl {
  readonly display: AutomationControlStatus | undefined
  readonly capPresent: boolean
  readonly busy: boolean
  readonly setEnabled: (next: boolean) => void
  readonly trigger: () => void
}

function useAutomationControl(
  trpc: DeviceControlProps['trpc'],
  deviceId: number,
  optimistic: boolean | undefined,
): UseAutomationControl {
  const { cap, slice, available } = useDeviceCapability<
    AutomationControlCap,
    AutomationControlStatus
  >({
    trpc,
    deviceId,
    cap: (d) => d.automationControl as AutomationControlCap | undefined,
    slice: (d) => d.state.automationControl,
  })
  const { display, applyOptimistic } = useOptimisticSlice<AutomationControlStatus>(slice, {
    enabled: optimistic ?? true,
  })
  const busy = !available

  return {
    display,
    capPresent: cap !== undefined,
    busy,
    setEnabled: (next) => {
      if (cap === undefined || busy) return
      applyOptimistic({ enabled: next })
      if (next) void cap.enable({})
      else void cap.disable({})
    },
    trigger: () => {
      if (cap === undefined || busy) return
      // No optimistic patch. `isRunning` is never written by the provider, so
      // setting it here would show a spinner that nothing ever clears.
      void cap.trigger({})
    },
  }
}

interface EnabledPillProps {
  readonly enabled: boolean
  readonly busy: boolean
  readonly onToggle: (next: boolean) => void
}

function EnabledPill({ enabled, busy, onToggle }: EnabledPillProps): ReactNode {
  const t = useUiText()
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={t('uiLibrary.scriptAutomationControls.automationEnabled', 'Automation enabled')}
      disabled={busy}
      data-testid="automation-enabled"
      onClick={(e) => {
        e.stopPropagation()
        onToggle(!enabled)
      }}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5',
        'text-[11px] font-medium whitespace-nowrap transition-colors',
        enabled
          ? 'border-success/40 bg-success/10 text-success'
          : 'border-border bg-surface-subtle text-foreground-subtle',
        busy && 'cursor-not-allowed opacity-40',
      )}
    >
      {enabled
        ? t('uiLibrary.scriptAutomationControls.enabled', 'Enabled')
        : t('uiLibrary.scriptAutomationControls.disabled', 'Disabled')}
    </button>
  )
}

interface TriggerButtonProps {
  readonly busy: boolean
  readonly large: boolean
  readonly onTrigger: () => void
}

/**
 * Always available, even while the automation is DISABLED.
 *
 * That is the cap's contract, not an oversight: a disabled automation ignores
 * its trigger block but a manual `trigger` still runs it, which is exactly how
 * an operator tests one before switching it on.
 */
function TriggerButton({ busy, large, onTrigger }: TriggerButtonProps): ReactNode {
  const t = useUiText()
  return (
    <button
      type="button"
      aria-label={t('uiLibrary.scriptAutomationControls.trigger', 'Trigger')}
      title={t('uiLibrary.scriptAutomationControls.runNow', 'Run this automation now')}
      disabled={busy}
      data-testid="automation-trigger"
      onClick={(e) => {
        e.stopPropagation()
        onTrigger()
      }}
      className={cn(
        'inline-flex items-center gap-1 rounded transition-colors',
        large ? 'h-10 px-4 text-sm' : 'h-5 px-1.5 text-xs',
        'bg-primary text-primary-foreground hover:bg-primary/90',
        busy && 'cursor-not-allowed opacity-40',
      )}
    >
      <Zap className={large ? 'h-4 w-4' : 'h-3 w-3'} aria-hidden="true" />
      <span>{t('uiLibrary.scriptAutomationControls.trigger', 'Trigger')}</span>
    </button>
  )
}

export function AutomationInlineControl({
  trpc,
  deviceId,
  optimistic,
}: DeviceControlProps): ReactNode {
  const { display, capPresent, busy, setEnabled, trigger } = useAutomationControl(
    trpc,
    deviceId,
    optimistic,
  )
  if (!capPresent) return null
  if (display === undefined) return null

  return (
    <div className="flex min-w-0 items-center gap-2">
      <EnabledPill enabled={display.enabled} busy={busy} onToggle={setEnabled} />
      <TriggerButton busy={busy} large={false} onTrigger={trigger} />
    </div>
  )
}

export function AutomationHeroCard({ trpc, deviceId, optimistic }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { display, capPresent, busy, setEnabled, trigger } = useAutomationControl(
    trpc,
    deviceId,
    optimistic,
  )
  if (!capPresent) return null
  if (display === undefined) return null

  return (
    <div className="flex flex-col items-stretch gap-4 rounded-lg border border-border bg-surface p-6">
      <div className="flex flex-col items-center gap-2">
        <div
          data-testid="automation-state"
          data-enabled={display.enabled ? 'true' : 'false'}
          className={cn(
            'flex h-16 w-16 items-center justify-center rounded-full border-2',
            display.enabled
              ? 'border-success text-success'
              : 'border-border text-foreground-subtle',
          )}
        >
          <Zap className="h-8 w-8" aria-hidden="true" />
        </div>
        <span className="text-sm font-medium">
          {display.enabled
            ? t('uiLibrary.scriptAutomationControls.enabled', 'Enabled')
            : t('uiLibrary.scriptAutomationControls.disabled', 'Disabled')}
        </span>
        {/* `lastTriggeredAt` is the LAST SUCCESSFUL run, per the cap. */}
        <LastRun
          atMs={display.lastTriggeredAt}
          neverLabel={t('uiLibrary.scriptAutomationControls.neverTriggered', 'never triggered')}
        />
        <LastError error={display.lastError} />
      </div>
      <div className="flex items-center justify-center gap-3">
        <EnabledPill enabled={display.enabled} busy={busy} onToggle={setEnabled} />
        <TriggerButton busy={busy} large={true} onTrigger={trigger} />
      </div>
    </div>
  )
}
