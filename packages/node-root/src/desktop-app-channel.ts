/**
 * The data-dir channel between a node and the native desktop app (Electron)
 * that hosts it — ZERO-DEP (node:fs/node:path only), like `root-state.ts`.
 *
 * Why FILES, and why in the node's data dir: with the Windows service the node
 * is NOT a child of Electron, so no pipe, env var or `process.send` can join
 * the two. Both sides already share `<dataDir>/server-root/`, so that is the
 * wire. Two files, one direction each:
 *
 *   desktop-app-state.json        app -> node   version + updater state
 *   desktop-install-request.json  node -> app   "install the downloaded update"
 *
 * The app OWNS the state file (rewritten on every updater transition); the
 * node only reads it, and judges its freshness. The request is consumed once
 * by the app (read + delete) and ignored when older than
 * {@link DESKTOP_INSTALL_REQUEST_MAX_AGE_MS}: a request left behind by an app
 * that was not running must never fire a later, unrelated restart.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export const DESKTOP_APP_STATE_FILE = 'desktop-app-state.json'
export const DESKTOP_INSTALL_REQUEST_FILE = 'desktop-install-request.json'

/** A state file older than this no longer describes the app (read as `stale`). */
export const DESKTOP_APP_STATE_STALE_MS = 15 * 60_000

/** A request older than this is dropped unanswered by the app. */
export const DESKTOP_INSTALL_REQUEST_MAX_AGE_MS = 60_000

/** What the desktop app publishes about itself (app -> node). */
export interface DesktopAppStateFile {
  readonly appVersion: string
  readonly available: boolean
  readonly downloaded: boolean
  readonly version: string | null
  readonly checking: boolean
  readonly error: string | null
  readonly updatedAtMs: number
}

/** The node's ask (node -> app). `nonce` makes two requests distinguishable in logs. */
export interface DesktopInstallRequestFile {
  readonly requestedAtMs: number
  readonly nonce: string
}

export function desktopAppStatePath(rootDir: string): string {
  return path.join(rootDir, DESKTOP_APP_STATE_FILE)
}

export function desktopInstallRequestPath(rootDir: string): string {
  return path.join(rootDir, DESKTOP_INSTALL_REQUEST_FILE)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string'
}

export function isDesktopAppStateFile(v: unknown): v is DesktopAppStateFile {
  if (!isRecord(v)) return false
  return (
    typeof v['appVersion'] === 'string' &&
    typeof v['available'] === 'boolean' &&
    typeof v['downloaded'] === 'boolean' &&
    isNullableString(v['version']) &&
    typeof v['checking'] === 'boolean' &&
    isNullableString(v['error']) &&
    typeof v['updatedAtMs'] === 'number'
  )
}

export function isDesktopInstallRequestFile(v: unknown): v is DesktopInstallRequestFile {
  if (!isRecord(v)) return false
  return typeof v['requestedAtMs'] === 'number' && typeof v['nonce'] === 'string'
}

function writeJsonAtomic(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8')
  fs.renameSync(tmp, target)
}

/** App side: publish the state (tmp sibling + rename). Creates rootDir. */
export function writeDesktopAppState(rootDir: string, state: DesktopAppStateFile): void {
  writeJsonAtomic(desktopAppStatePath(rootDir), state)
}

/** Node side: the published state, or null when absent / unreadable / malformed. */
export function readDesktopAppState(rootDir: string): DesktopAppStateFile | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(desktopAppStatePath(rootDir), 'utf-8'))
    return isDesktopAppStateFile(raw) ? raw : null
  } catch {
    return null
  }
}

/** Node side: ask the app to install (tmp sibling + rename). Creates rootDir. */
export function writeDesktopInstallRequest(
  rootDir: string,
  request: DesktopInstallRequestFile,
): void {
  writeJsonAtomic(desktopInstallRequestPath(rootDir), request)
}

/**
 * App side: read AND delete the request (consume-once). The file is deleted
 * regardless of validity, so a corrupt one cannot linger. Returns the request
 * only when well-formed and not older than `maxAgeMs` at `nowMs`; `null`
 * otherwise (absent, malformed, stale).
 */
export function consumeDesktopInstallRequest(
  rootDir: string,
  nowMs: number,
  maxAgeMs: number = DESKTOP_INSTALL_REQUEST_MAX_AGE_MS,
): DesktopInstallRequestFile | null {
  const target = desktopInstallRequestPath(rootDir)
  let parsed: DesktopInstallRequestFile | null = null
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(target, 'utf-8'))
    if (isDesktopInstallRequestFile(raw)) parsed = raw
  } catch {
    /* absent / unreadable / malformed -> null */
  }
  try {
    fs.rmSync(target, { force: true })
  } catch {
    /* best-effort delete */
  }
  if (parsed === null) return null
  if (nowMs - parsed.requestedAtMs > maxAgeMs) return null
  return parsed
}
