/**
 * App -> node half of the desktop data-dir channel (ADR-0971): the app writes
 * its version and updater state to `<dataDir>/server-root/desktop-app-state.json`
 * so the node (a child process OR a Windows service) can report it to the hub.
 *
 * The layout and the atomic write live in `@camstack/node-root`, shared with
 * the reader; this module only maps the updater snapshot onto the file shape.
 */
import { serverRootDir, writeDesktopAppState, type DesktopAppStateFile } from '@camstack/node-root'
import type { UpdateState } from './auto-updater'

/** Pure: the file content for one updater snapshot. */
export function buildDesktopAppState(
  appVersion: string,
  update: UpdateState,
  nowMs: number,
): DesktopAppStateFile {
  return {
    appVersion,
    available: update.available,
    downloaded: update.downloaded,
    version: update.version,
    checking: update.checking,
    error: update.error,
    updatedAtMs: nowMs,
  }
}

/**
 * Write the state file (atomic tmp + rename). Throws on an unwritable data dir;
 * the caller logs it — a failed publish must not take the app down, but it must
 * not be silent either (the node then reads the file as stale, which is true).
 */
export function publishDesktopAppState(
  dataDir: string,
  appVersion: string,
  update: UpdateState,
  nowMs: number = Date.now(),
): void {
  writeDesktopAppState(serverRootDir(dataDir), buildDesktopAppState(appVersion, update, nowMs))
}
