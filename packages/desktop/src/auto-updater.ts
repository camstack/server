/**
 * Wraps `electron-updater` for the Agent app.
 * - Checks GH Releases on launch + every 6h.
 * - Tracks a small update-state object surfaced to the tray + agent UI.
 * - Installs on app restart (or on-demand via `installAndRestart`).
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { app, autoUpdater as nativeAutoUpdater, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { DesktopProduct } from './product/desktop-product'
import { createNativeStagingWatch, type NativeStagingWatch } from './native-staging-watch'
import { updateChannelForProduct } from './product/update-channel'

/** How long Squirrel.Mac gets to fetch a downloaded update before it is asked again. */
const NATIVE_STAGING_RETRY_MS = 30_000
const NATIVE_STAGING_MAX_RETRIES = 3

/** Update lifecycle snapshot shared with the tray menu + agent UI. */
export interface UpdateState {
  readonly available: boolean
  readonly downloaded: boolean
  readonly version: string | null
  readonly checking: boolean
  /**
   * Why the last check did NOT produce an answer, or `null` if it
   * succeeded.
   *
   * Without this field an IMPOSSIBLE check was indistinguishable from "no
   * update": the error ended up in `console.error`, `checking` went back to
   * false, and the page redrew "Check for updates" as if nothing had happened.
   *
   * Cost, 2026-08-27: the releases repo is PRIVATE, so the feed
   * answers 404 to an app without credentials. The app checked every six hours, always
   * failed, and nobody could notice — the operator restarted
   * the app and pressed the button several times before anyone went to look at the
   * feed by hand. A branch that silently discards work logs it, and if there is a
   * UI it SHOWS it.
   */
  readonly error: string | null
}

interface UpdaterHandle {
  checkForUpdates: () => Promise<void>
  installAndRestart: () => void
  getState: () => UpdateState
}

interface UpdaterCallbacks {
  /** Fired on every state transition (checking → available → downloaded). */
  onStateChange?: (state: UpdateState) => void
  onUpdateDownloaded?: (version: string) => void
  onError?: (err: Error) => void
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

const IDLE_STATE: UpdateState = {
  available: false,
  downloaded: false,
  version: null,
  checking: false,
  error: null,
}

/**
 * @param product WHICH of the two builds this binary is. It selects the feed:
 *   both products publish to the same GitHub release, and electron-updater
 *   reads ONE file per channel per platform, so without this the reduced
 *   product and the full one read — and overwrite — each other's
 *   `latest-mac.yml`. Measured on v1.2.338, where the full app's mac feed named
 *   `CamStackViewer-1.2.338-arm64.dmg`. See `product/update-channel.ts` and
 *   ADR-0584.
 *
 *   The channel is ALREADY in the packaged `app-update.yml` (electron-builder
 *   writes the publish config there verbatim). Setting it here as well is not
 *   redundant: it is the half of the pair that lives in code, so the two sides
 *   can be asserted equal by a test and a guard rather than hoped equal.
 */
export function initAutoUpdater(
  product: DesktopProduct,
  callbacks: UpdaterCallbacks = {},
): UpdaterHandle {
  // Dev builds have no update feed — return an inert handle so callers don't
  // need to branch on `app.isPackaged`.
  if (!app.isPackaged) {
    return {
      checkForUpdates: async () => {
        /* no-op in dev */
      },
      installAndRestart: () => {
        /* no-op in dev */
      },
      getState: () => IDLE_STATE,
    }
  }

  // Order matters: the `channel` setter sets `allowDowngrade = true` on the way
  // through (documented in electron-updater), and this product has no use for
  // downgrades — both builds carry the version of the tag that produced them.
  autoUpdater.channel = updateChannelForProduct(product)
  autoUpdater.allowDowngrade = false
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  // macOS: "downloaded" (electron-updater) is not "installable" (staged by the
  // native updater). See native-staging-watch.ts.
  const nativeWatch: NativeStagingWatch | null =
    process.platform === 'darwin'
      ? createNativeStagingWatch({
          native: nativeAutoUpdater,
          log: console,
          retryDelayMs: NATIVE_STAGING_RETRY_MS,
          maxRetries: NATIVE_STAGING_MAX_RETRIES,
        })
      : null

  let state: UpdateState = IDLE_STATE
  const setState = (patch: Partial<UpdateState>): void => {
    state = { ...state, ...patch }
    callbacks.onStateChange?.(state)
  }

  autoUpdater.on('checking-for-update', () => {
    // The previous error is cleared HERE, not at the end: while the check is
    // in progress, the old outcome no longer describes anything.
    setState({ checking: true, error: null })
  })

  autoUpdater.on('update-available', (info: { version?: string }) => {
    setState({ available: true, checking: false, version: info.version ?? null })
  })

  autoUpdater.on('update-not-available', () => {
    setState({ available: false, downloaded: false, checking: false })
  })

  autoUpdater.on('update-downloaded', (info: { version?: string }) => {
    setState({ available: true, downloaded: true, checking: false, version: info.version ?? null })
    nativeWatch?.expectStaging()
    callbacks.onUpdateDownloaded?.(info.version ?? 'unknown')
  })

  autoUpdater.on('error', (err: Error) => {
    console.error('[updater] error', err.message)
    setState({ checking: false, error: err.message })
    callbacks.onError?.(err)
  })

  const check = async (): Promise<void> => {
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      console.error('[updater] check failed', err)
      setState({ checking: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  // First check after 10s (let the agent settle), then every 6h.
  setTimeout(() => void check(), 10_000)
  setInterval(() => void check(), SIX_HOURS_MS)

  return {
    checkForUpdates: check,
    installAndRestart: () => {
      console.log(
        `[updater] install and restart requested (downloaded=${state.downloaded}, nativeStaged=${nativeWatch?.isStaged() ?? 'n/a'})`,
      )
      nativeWatch?.nudgeIfNotStaged('install and restart')
      autoUpdater.quitAndInstall(false, true)
    },
    getState: () => state,
  }
}

export function shutdownAutoUpdater(): void {
  autoUpdater.removeAllListeners()
}

export function notifyUpdateReady(version: string): void {
  void dialog.showMessageBox({
    type: 'info',
    title: 'CamStack Agent — Update ready',
    message: `Version ${version} has been downloaded.`,
    detail: 'It will be installed the next time the agent restarts.',
    buttons: ['OK'],
  })
}
