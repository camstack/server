import * as fs from 'node:fs'
import * as path from 'node:path'
import { asJsonObject, asNumber, asString, parseJsonUnknown } from '@camstack/types'

/**
 * RestartCoordinator — shared primitives for the framework live-update flow.
 *
 * Spec: docs/superpowers/specs/2026-05-14-framework-live-update-design.md (P2)
 *
 * Three responsibilities:
 *   1) Marker schema + read/write/clear on `<dataDir>/.restart-pending`.
 *   2) Boot-side handoff: `readPendingRestart()` returns the payload exactly
 *      once and atomically clears the marker so a crashed second boot
 *      doesn't re-fire the completion event.
 *   3) Environment-agnostic `scheduleSelfRestart()` — Electron calls
 *      `app.relaunch()`+`app.exit(0)`, everything else `process.exit(0)`.
 *
 * The cap method that writes the marker lives in the addons cap (P3); this
 * module is the zero-dep primitive both the cap (writer) and PostBootService
 * (reader) call into.
 */

/** Filename of the restart marker, written under `<dataDir>`. */
export const RESTART_MARKER_FILE = '.restart-pending'

/** Discriminated union of reasons the hub can be asked to restart. */
export type RestartKind = 'framework-update' | 'framework-bulk-update' | 'manual' | 'system'

/**
 * On-disk shape. All fields stable + load-bearing for the completion event.
 * Future kinds add new optional fields; existing readers ignore them.
 */
export interface PendingRestartMarker {
  readonly kind: RestartKind
  readonly packageName?: string
  readonly fromVersion?: string
  readonly toVersion?: string
  readonly requestedBy?: string
  readonly requestedAt: number
}

/** Resolve the marker path inside a data directory. */
export function getRestartMarkerPath(dataDir: string): string {
  return path.join(dataDir, RESTART_MARKER_FILE)
}

/**
 * Write the marker atomically. Existing marker is overwritten — the most
 * recent restart request wins.
 *
 * Uses write-then-rename so a crash mid-write leaves either the old marker
 * intact or no marker at all (never a half-written file).
 */
export function writePendingRestart(dataDir: string, marker: PendingRestartMarker): void {
  fs.mkdirSync(dataDir, { recursive: true })
  const markerPath = getRestartMarkerPath(dataDir)
  const tmpPath = `${markerPath}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(marker, null, 2), 'utf-8')
  fs.renameSync(tmpPath, markerPath)
}

/**
 * Read + consume the marker. Returns the parsed payload on success and
 * clears the file in the same tick (rename → unlink), so a crash between
 * read and emit won't replay the completion event on the next boot.
 *
 * Failure modes:
 *   - no marker present     → returns null
 *   - file unreadable / IO  → logs to console, returns null, leaves marker
 *   - JSON malformed        → logs, clears the marker, returns null
 *   - missing required `kind` / `requestedAt` → logs, clears, returns null
 *
 * "Clear on parse failure" is intentional: a stuck unparseable marker would
 * otherwise block every subsequent restart's completion event.
 *
 * NOTE: the `console.error` calls below are deliberate, documented
 * residuals. This is a stateless bootstrap utility invoked during hub
 * startup before `LogManager` / the Moleculer broker exist — there is no
 * `IScopedLogger` or `$hub.log` transport in scope. Threading a logger
 * parameter through every caller is out of scope for the D8 log-forwarding
 * work (which only touches `packages/kernel/src`).
 */
export function readPendingRestart(dataDir: string): PendingRestartMarker | null {
  const markerPath = getRestartMarkerPath(dataDir)
  if (!fs.existsSync(markerPath)) return null

  let raw: string
  try {
    raw = fs.readFileSync(markerPath, 'utf-8')
  } catch (err) {
    console.error('[restart-coordinator] Marker unreadable — leaving in place:', err)
    return null
  }

  let parsed: Record<string, unknown> | null
  try {
    parsed = asJsonObject(parseJsonUnknown(raw))
  } catch (err) {
    console.error('[restart-coordinator] Marker JSON invalid — clearing:', err)
    clearPendingRestart(dataDir)
    return null
  }
  if (parsed === null) {
    console.error('[restart-coordinator] Marker not an object — clearing')
    clearPendingRestart(dataDir)
    return null
  }

  const kindRaw = asString(parsed['kind'])
  const requestedAt = asNumber(parsed['requestedAt'])
  if (!isRestartKind(kindRaw) || requestedAt <= 0) {
    console.error('[restart-coordinator] Marker missing kind/requestedAt — clearing')
    clearPendingRestart(dataDir)
    return null
  }

  const marker: PendingRestartMarker = {
    kind: kindRaw,
    requestedAt,
    ...(typeof parsed['packageName'] === 'string' ? { packageName: parsed['packageName'] } : {}),
    ...(typeof parsed['fromVersion'] === 'string' ? { fromVersion: parsed['fromVersion'] } : {}),
    ...(typeof parsed['toVersion'] === 'string' ? { toVersion: parsed['toVersion'] } : {}),
    ...(typeof parsed['requestedBy'] === 'string' ? { requestedBy: parsed['requestedBy'] } : {}),
  }

  clearPendingRestart(dataDir)
  return marker
}

/** Remove the marker if present. No-op if missing. */
export function clearPendingRestart(dataDir: string): void {
  const markerPath = getRestartMarkerPath(dataDir)
  fs.rmSync(markerPath, { force: true })
}

function isRestartKind(value: string): value is RestartKind {
  return value === 'framework-update' || value === 'manual' || value === 'system'
}

/**
 * Schedule a self-restart appropriate for the runtime:
 *   - Electron: `app.relaunch()` then `app.exit(0)` — the bundle handles the spawn.
 *   - Docker / standalone Node: `process.exit(0)` — the supervisor (compose
 *     `restart: unless-stopped`, systemd, pm2, …) brings the process back up.
 *
 * Caller is expected to have:
 *   1) Written the marker via `writePendingRestart`.
 *   2) Returned the cap-method response to the caller (so the WS doesn't
 *      drop mid-reply).
 *   3) Closed the Fastify instance gracefully (`await fastify.close()`).
 *
 * The 500ms delay is the same beat used by P3's cap method — kept here as a
 * default so non-cap callers (signal handlers, future flows) share the same
 * shutdown pacing.
 */
export interface ScheduleSelfRestartOptions {
  /** Delay before exit (ms). Default 500 — gives in-flight RPC time to drain. */
  readonly delayMs?: number
  /** Override exit code. Default 0 (clean exit → supervisor restart). */
  readonly exitCode?: number
}

export function scheduleSelfRestart(options: ScheduleSelfRestartOptions = {}): void {
  const delayMs = options.delayMs ?? 500
  const exitCode = options.exitCode ?? 0

  setTimeout(() => {
    // Dev (tsx watch): a clean `process.exit()` is NOT respawned by the file
    // watcher — it only restarts on a source change, so the hub would stay
    // down until an unrelated edit. When `CAMSTACK_RESTART_TOUCH_FILE` points
    // at the watched entry file, touch it so tsx performs a clean reload that
    // re-reads the freshly-installed dist from the data dir. Only the `serve`
    // (watch) npm script sets this; `serve:once` and production leave it unset
    // and fall through to the real exit path below. A touch failure (missing
    // file, permissions) also falls through, so we never silently fail to
    // restart.
    const touchTarget = process.env['CAMSTACK_RESTART_TOUCH_FILE']
    if (touchTarget !== undefined && touchTarget.length > 0) {
      try {
        const now = new Date()
        fs.utimesSync(touchTarget, now, now)
        return
      } catch (err) {
        console.error(
          '[restart-coordinator] dev touch-reload failed; falling through to process exit:',
          err,
        )
      }
    }

    if (process.versions.electron !== undefined) {
      // Electron — bundle controls the relaunch lifecycle. `require` is the
      // only way to get the `app` handle from a runtime check.
      const electron = require('electron') as {
        app: { relaunch: () => void; exit: (code: number) => void }
      }
      electron.app.relaunch()
      electron.app.exit(exitCode)
      return
    }
    process.exit(exitCode)
  }, delayMs)
}
