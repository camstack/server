/**
 * macOS only: electron-updater downloads the zip, then hands it to the NATIVE
 * updater (Squirrel.Mac) through a local proxy and a native `checkForUpdates()`.
 * Only when Squirrel itself fetches the zip does it STAGE the update, and only
 * a staged update is installed on quit or by `quitAndInstall`.
 *
 * Observed on a notarized 0.1.3 → 0.1.4: electron-updater reported the update
 * downloaded and the proxy listening, but the native updater never requested it
 * — no error, no staging — so a clean quit installed nothing and "install now"
 * waited for a native event that never came. electron-updater fires its own
 * `update-downloaded` BEFORE the native one, so "downloaded" in our state never
 * proved "installable".
 *
 * This watch makes the gap visible and bounded: it re-asks the native updater
 * while it has not staged, logs every native error and the final give-up, and
 * answers `isStaged()` so an install request can say why it is waiting.
 * Pure: no electron import, the native updater is a port.
 */
export interface NativeUpdaterPort {
  on(event: string, listener: (...args: unknown[]) => void): void
  checkForUpdates(): void
}

export interface NativeStagingLog {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface NativeStagingWatchOptions {
  readonly native: NativeUpdaterPort
  readonly log: NativeStagingLog
  /** How long to wait for Squirrel to fetch the update before asking again. */
  readonly retryDelayMs: number
  readonly maxRetries: number
}

export interface NativeStagingWatch {
  /** electron-updater handed the zip over: expect the native updater to stage it. */
  expectStaging(): void
  isStaged(): boolean
  /**
   * Ask the native updater again if it has not staged. Returns whether it had
   * already staged. Always logs the not-staged case, with `reason`.
   */
  nudgeIfNotStaged(reason: string): boolean
}

export function createNativeStagingWatch(options: NativeStagingWatchOptions): NativeStagingWatch {
  const { native, log, retryDelayMs, maxRetries } = options
  let staged = false
  let timer: ReturnType<typeof setTimeout> | null = null

  native.on('update-downloaded', () => {
    staged = true
    if (timer !== null) clearTimeout(timer)
    timer = null
    log.info('[updater] native updater staged the update — it will install on quit')
  })
  native.on('error', (err: unknown) => {
    log.error(`[updater] native updater error: ${err instanceof Error ? err.message : String(err)}`)
  })

  const schedule = (attempt: number): void => {
    timer = setTimeout(() => {
      timer = null
      if (staged) return
      if (attempt >= maxRetries) {
        log.error(
          `[updater] native updater never staged the update after ${maxRetries} re-checks — it will NOT install on quit`,
        )
        return
      }
      log.warn(
        `[updater] native updater has not fetched the downloaded update after ${retryDelayMs} ms — checking again (${attempt + 1}/${maxRetries})`,
      )
      native.checkForUpdates()
      schedule(attempt + 1)
    }, retryDelayMs)
    timer.unref?.()
  }

  return {
    expectStaging: () => {
      if (staged || timer !== null) return
      schedule(0)
    },
    isStaged: () => staged,
    nudgeIfNotStaged: (reason) => {
      if (staged) return true
      log.warn(`[updater] ${reason}: native updater has not staged the update yet — asking it now`)
      native.checkForUpdates()
      return false
    },
  }
}
