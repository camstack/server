import * as fs from 'node:fs'
import * as path from 'node:path'

/** Where a UI bundle is served from. */
export interface UiServingState {
  readonly staticDir: string
  readonly indexPath: string
}

/** The `viewer-ui` / `admin-ui` capability shape (remote-proxied, so async). */
export interface StaticUiProvider {
  getStaticDir(): Promise<{ readonly staticDir: string }>
  getVersion(): Promise<{ readonly version: string }>
}

export type UiServingLogLevel = 'info' | 'warn' | 'error'

export interface LazyUiServingOptions {
  /** Short name for log lines, e.g. `Viewer UI`. */
  readonly label: string
  /** Hub-scoped provider lookup; `null` while the capability is unregistered. */
  readonly lookup: () => StaticUiProvider | null
  /** Called once per newly served directory (warm caches, remember the index). */
  readonly onServed?: (state: UiServingState, version: string) => void
  /** Log sink; called once per state change, never per request. */
  readonly log: (level: UiServingLogLevel, message: string) => void
  /** Minimum gap between two resolution attempts. */
  readonly minAttemptGapMs?: number
  /** Longest a request waits on an attempt before answering with what is served (503 if nothing). */
  readonly requestWaitMs?: number
  readonly now?: () => number
}

export interface LazyUiServing {
  /** Current serving state, or `null` -> the route answers 503. */
  get(): Promise<UiServingState | null>
}

const DEFAULT_ATTEMPT_GAP_MS = 2_000
const DEFAULT_REQUEST_WAIT_MS = 4_000

/** Wait for `work`, but never longer than `ms`: a hung provider RPC must not hang every request. */
async function waitAtMost(work: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  try {
    await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Lazy, single-flight resolution of a forked UI provider (D876).
 *
 * A request that finds nothing served triggers (or joins) ONE attempt; the next
 * request tries again, at most once per `minAttemptGapMs`. Once served, the
 * provider object identity is compared on each request: a re-registered
 * provider (addon update/restart) or a vanished index re-resolves, so the
 * served directory follows the provider. No timers, no retry loop.
 */
export function createLazyUiServing(options: LazyUiServingOptions): LazyUiServing {
  const gapMs = options.minAttemptGapMs ?? DEFAULT_ATTEMPT_GAP_MS
  const waitMs = options.requestWaitMs ?? DEFAULT_REQUEST_WAIT_MS
  const now = options.now ?? Date.now
  let state: UiServingState | null = null
  let servedProvider: StaticUiProvider | null = null
  let inFlight: Promise<void> | null = null
  let lastAttemptAt = Number.NEGATIVE_INFINITY
  let lastNotice = ''

  const notice = (level: UiServingLogLevel, message: string): void => {
    if (message === lastNotice) return
    lastNotice = message
    options.log(level, message)
  }

  const attempt = async (): Promise<void> => {
    try {
      const provider = options.lookup()
      if (!provider) {
        if (!state) {
          notice(
            'warn',
            `${options.label}: capability not registered yet, answering 503 until it is`,
          )
        }
        return
      }
      const { staticDir } = await provider.getStaticDir()
      const indexPath = path.join(staticDir, 'index.html')
      if (!fs.existsSync(staticDir) || !fs.existsSync(indexPath)) {
        if (state && state.staticDir !== staticDir) state = null
        notice('warn', `${options.label}: dist not found at ${staticDir}`)
        return
      }
      if (state?.staticDir === staticDir) {
        servedProvider = provider
        return
      }
      // The version only labels the log line: a failing read must not keep the
      // OLD directory served behind a provider we already marked as current.
      const version = await provider
        .getVersion()
        .then((v) => v.version)
        .catch(() => 'unknown')
      const next: UiServingState = { staticDir, indexPath }
      state = next
      servedProvider = provider
      notice('info', `${options.label} served from: ${staticDir} (v${version})`)
      options.onServed?.(next, version)
    } catch (err) {
      notice(
        'error',
        `${options.label}: resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const startAttempt = (): Promise<void> => {
    if (inFlight) return inFlight
    lastAttemptAt = now()
    inFlight = attempt().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  const needsAttempt = (): boolean => {
    if (!state) return true
    if (!fs.existsSync(state.indexPath)) return true
    const current = options.lookup()
    return current !== null && current !== servedProvider
  }

  return {
    async get() {
      if (inFlight) {
        await waitAtMost(inFlight, waitMs)
      } else if (needsAttempt() && now() - lastAttemptAt >= gapMs) {
        await waitAtMost(startAttempt(), waitMs)
      }
      return state && fs.existsSync(state.indexPath) ? state : null
    },
  }
}
