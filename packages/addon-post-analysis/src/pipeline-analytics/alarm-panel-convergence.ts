/**
 * Converge the alarm-panel declaration after a boot that could not make it.
 *
 * `declareAlarmPanel` was a boot ONE-SHOT: it reconciled once from
 * `onInitialize`, logged a warning if the reconcile threw, and then left
 * `alarmPanelDevice` null for the whole life of the process. There was no
 * second pass.
 *
 * On a COLD CONTAINER START the `pipeline-analytics` child forks before the
 * parent has registered its `integrations` service, so the FIRST port call
 * `DeclaredDevices.ensureIntegration` makes answers
 * `Service 'integrations.integrations.getByAddonId' is not found`. The reconcile
 * therefore throws before it ever reads the device index, the panel is never
 * held, `wireAlarmPanel` returns early — and `notificationRules.getAlarmConfig`
 * answers `{ deviceId: null, coverage: [] }`, i.e. an EMPTY Alarm tab, on a hub
 * whose panel (device 1023) exists and is perfectly healthy.
 *
 * Measured on the live hub: twelve cold boots between 2026-08-11 and 2026-08-13
 * lost the panel exactly this way. Every one of them was healed only by an
 * unrelated redeploy of the addon, which forks the child against an already-warm
 * parent. Between the two, the armed-rule coverage the operator reads was blank.
 *
 * `DeclaredDevices.reconcile` is documented as idempotent and "safe to call on
 * every boot AND on every convergence tick" — the throw is meant to be retried,
 * and `addon-terminal` already ticks its camera declarations for this reason
 * (`addon.ts:188`). This is that tick for the panel: bounded, self-cancelling on
 * the first success, and loud when it gives up rather than silently leaving the
 * alarm surface empty.
 */

import type { IScopedLogger } from '@camstack/types'

/**
 * One declaration pass. Resolves `true` once there is nothing left to converge
 * to — the panel is held and wired, OR this node does not own the declaration.
 * Resolves `false` when the pass ran but the panel still is not there; throws
 * when the pass itself could not run.
 */
export type AlarmPanelAttempt = () => Promise<boolean>

/** A cancellable repeat, so a test can drive the ticks itself. */
export interface AlarmPanelTimer {
  readonly clear: () => void
}

export type AlarmPanelScheduler = (tick: () => void, intervalMs: number) => AlarmPanelTimer

export interface AlarmPanelConvergencePorts {
  readonly attempt: AlarmPanelAttempt
  readonly logger: IScopedLogger
  /** Defaults to {@link ALARM_PANEL_RETRY_MS}. */
  readonly retryMs?: number
  /** Defaults to {@link ALARM_PANEL_MAX_ATTEMPTS}. */
  readonly maxAttempts?: number
  /** Defaults to an `unref`'d `setInterval`. */
  readonly scheduler?: AlarmPanelScheduler
}

export interface AlarmPanelConvergence {
  /** Stop retrying. Idempotent — `onShutdown` calls it unconditionally. */
  readonly stop: () => void
}

/**
 * Long enough that a hub still bringing its services up is not hammered, short
 * enough that the Alarm tab fills in before an operator has finished opening it.
 */
const ALARM_PANEL_RETRY_MS = 15_000

/**
 * ~10 minutes. A parent that has not registered `integrations` by then is not
 * merely slow, and an unbounded retry would be a timer this process never
 * stops paying for.
 */
const ALARM_PANEL_MAX_ATTEMPTS = 40

const defaultScheduler: AlarmPanelScheduler = (tick, intervalMs) => {
  const handle = setInterval(tick, intervalMs)
  handle.unref?.()
  return { clear: (): void => clearInterval(handle) }
}

/**
 * Retry `attempt` until it lands, the budget runs out, or {@link
 * AlarmPanelConvergence.stop} is called.
 *
 * Call this ONLY after a boot attempt has already failed — a boot that declared
 * the panel needs no timer at all.
 */
export function startAlarmPanelConvergence(
  ports: AlarmPanelConvergencePorts,
): AlarmPanelConvergence {
  const retryMs = ports.retryMs ?? ALARM_PANEL_RETRY_MS
  const maxAttempts = ports.maxAttempts ?? ALARM_PANEL_MAX_ATTEMPTS
  const schedule = ports.scheduler ?? defaultScheduler

  let attempts = 0
  // A slow pass must not overlap the next tick: `reconcile` creates devices,
  // and two concurrent creates for one stableId is the collision the adopt
  // guard exists to avoid.
  let inFlight = false
  let stopped = false

  const timer = schedule((): void => {
    void tick()
  }, retryMs)

  const stop = (): void => {
    if (stopped) return
    stopped = true
    timer.clear()
  }

  async function tick(): Promise<void> {
    if (stopped || inFlight) return
    inFlight = true
    attempts += 1
    try {
      if (await ports.attempt()) {
        ports.logger.info('alarm panel declared on a retry — the Alarm tab is populated again', {
          meta: { attempts },
        })
        stop()
        return
      }
    } catch (err) {
      // Expected while the parent is still coming up. One line per attempt, so
      // "the panel is missing and nothing is trying" is never the reading.
      ports.logger.warn('alarm panel declaration retry failed — will try again', {
        meta: { attempts, error: err instanceof Error ? err.message : String(err) },
      })
    } finally {
      inFlight = false
    }
    if (!stopped && attempts >= maxAttempts) {
      ports.logger.error(
        'alarm panel could not be declared — giving up; the Alarm tab stays empty until this addon is restarted',
        { meta: { attempts } },
      )
      stop()
    }
  }

  return { stop }
}
