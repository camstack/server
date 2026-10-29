/**
 * Node -> app half of the desktop data-dir channel (ADR-0971): the node writes
 * `<dataDir>/server-root/desktop-install-request.json` ("install the downloaded
 * update and restart"); the app consumes it once, here.
 *
 * Two safeguards, both because a file outlives the moment it was written for:
 *  - consume-once: the request is deleted as it is read, so one click installs
 *    once and a restart of the app does not replay it;
 *  - freshness: a request older than 60 s (the app was not running when it was
 *    written) is dropped, never honoured at a later, unrelated launch.
 * And it acts only on an update that is DOWNLOADED — a request for nothing
 * must not quit the app.
 */
import * as fs from 'node:fs'
import {
  consumeDesktopInstallRequest,
  desktopInstallRequestPath,
  serverRootDir,
} from '@camstack/node-root'

export type InstallRequestOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'install'; readonly nonce: string }
  | { readonly kind: 'not-downloaded'; readonly nonce: string }

/**
 * Consume a pending request (if any) and decide. `none` covers absent, malformed
 * and stale — all deleted, none acted on.
 */
export function takeInstallRequest(
  dataDir: string,
  updateDownloaded: boolean,
  nowMs: number = Date.now(),
): InstallRequestOutcome {
  const request = consumeDesktopInstallRequest(serverRootDir(dataDir), nowMs)
  if (request === null) return { kind: 'none' }
  return updateDownloaded
    ? { kind: 'install', nonce: request.nonce }
    : { kind: 'not-downloaded', nonce: request.nonce }
}

export interface InstallRequestWatchOptions {
  readonly dataDir: string
  /** Called on every poll/watch tick; must consume via {@link takeInstallRequest}. */
  readonly onTick: () => void
  readonly pollMs?: number
}

const DEFAULT_POLL_MS = 5_000

/**
 * Run `onTick` when the request file appears (fs.watch on the directory) and on
 * a slow poll as the fallback — fs.watch is unreliable on network drives and
 * some Linux filesystems. Returns a disposer.
 */
export function watchInstallRequests(options: InstallRequestWatchOptions): () => void {
  const { dataDir, onTick, pollMs = DEFAULT_POLL_MS } = options
  const dir = serverRootDir(dataDir)
  const target = desktopInstallRequestPath(dir)
  let watcher: fs.FSWatcher | null = null
  try {
    fs.mkdirSync(dir, { recursive: true })
    watcher = fs.watch(dir, (_event, filename) => {
      if (filename === null || target.endsWith(String(filename))) onTick()
    })
    watcher.on('error', () => {
      /* the poll below keeps working */
    })
  } catch {
    /* no watch support here — the poll is the whole mechanism */
  }
  const timer = setInterval(onTick, pollMs)
  return () => {
    clearInterval(timer)
    watcher?.close()
  }
}
