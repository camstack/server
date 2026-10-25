/**
 * The initialize() stall watchdog.
 *
 * ## What it is guarding
 *
 * A runner publishes its capability manifest ONLY once every hosted addon's
 * `initialize()` has returned: `addon-runner.ts` appends to `runnerManifest`
 * AFTER the await, and `refreshChildCaps('post-init')` runs after the whole
 * loop. So an `initialize()` that does not return is not a slow feature — it
 * takes every capability that addon owns OFF the cluster. Callers get
 * `no provider registered for cap "…"`, and the admin UI renders "provider not
 * available".
 *
 * ## Why a log line and not a bound
 *
 * 2026-08-14: `pipeline-analytics` awaited a timelapse back-fill render inside
 * `initialize()`. The window was 19:00→05:00, the export rendered for over half
 * an hour, and for that whole time `notification-rules`, `pipeline-analytics`,
 * `zone-analytics`, `audio-metrics`, `videoclips`, `face-gallery`,
 * `plate-gallery` and `addon-widgets-source` had ZERO providers cluster-wide.
 * The runner was healthy and chatty throughout — its 30 s tick kept logging —
 * which is exactly why nothing looked wrong. Not one line said the manifest had
 * never been published, and the diagnosis cost hours of log correlation.
 *
 * Killing the runner mid-init would be worse than the stall (a half-initialised
 * addon respawning in a loop), so this does not bound anything. It makes the
 * stall NAMED, periodic, and attributable to the addon and the exact
 * capabilities it is holding hostage — which is the one thing that was missing.
 */

/** First warning after this long without `initialize()` returning. */
export const INIT_WATCHDOG_FIRST_MS = 60_000

/** And every this often afterwards, for as long as it stays stuck. */
export const INIT_WATCHDOG_REPEAT_MS = 300_000

/** The warn sink — narrow on purpose, so this module needs no logger type. */
export type InitWatchdogWarn = (message: string, meta: Record<string, unknown>) => void

export interface InitWatchdogOptions {
  /** The addon whose `initialize()` is being awaited. */
  readonly addonId: string
  /**
   * The capability names the addon's manifest declares. They are what the
   * cluster is missing while the stall lasts, so they belong in the line — a
   * reader must not have to open the manifest to learn what is offline.
   */
  readonly declaredCapabilities: readonly string[]
  readonly warn: InitWatchdogWarn
  readonly now?: () => number
  readonly firstMs?: number
  readonly repeatMs?: number
}

export interface InitWatchdogHandle {
  /** Stop warning. Safe to call more than once, and after the last warning. */
  clear(): void
}

/**
 * Start warning if `initialize()` has not returned within `firstMs`.
 *
 * The caller MUST `clear()` in a `finally`, so a throwing initialize (which the
 * runner turns into `process.exit(1)`) does not keep the timer alive.
 */
export function startInitWatchdog(options: InitWatchdogOptions): InitWatchdogHandle {
  const now = options.now ?? Date.now
  const firstMs = options.firstMs ?? INIT_WATCHDOG_FIRST_MS
  const repeatMs = options.repeatMs ?? INIT_WATCHDOG_REPEAT_MS
  const startedAt = now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let cleared = false

  const schedule = (ms: number): void => {
    timer = setTimeout(fire, ms)
    // Never keep the process alive for a diagnostic.
    timer.unref?.()
  }

  function fire(): void {
    if (cleared) return
    const elapsedMs = now() - startedAt
    options.warn(
      `addon "${options.addonId}" initialize() has not returned after ${Math.round(elapsedMs / 1000)}s — ` +
        `its capability manifest is NOT published, so every caller of ` +
        `${options.declaredCapabilities.length > 0 ? options.declaredCapabilities.join(', ') : '(none declared)'} ` +
        `sees "no provider registered"`,
      {
        addonId: options.addonId,
        elapsedMs,
        unpublishedCapabilities: [...options.declaredCapabilities],
      },
    )
    schedule(repeatMs)
  }

  schedule(firstMs)

  return {
    clear(): void {
      cleared = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    },
  }
}
