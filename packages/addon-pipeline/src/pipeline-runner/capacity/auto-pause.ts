/**
 * auto-pause — the ramp quiets the node itself, and always gives it back.
 *
 * The capacity number is only meaningful on a quiet node: live cameras share
 * the pools and the event loop with the driver, so a contaminated run measures
 * neither capacity nor current load. That was a requirement of the measurement,
 * not a precondition for the operator to satisfy by hand — the first cut left
 * the pause in a separate script and only made the ramp REFUSE to start, which
 * is the same work moved onto a person.
 *
 * ## The hazard this is built around
 *
 * Pausing detection is trivial. Guaranteeing the un-pause is not, and getting
 * it wrong leaves cameras **blind while their config says otherwise** — the
 * worst failure this system has. So:
 *
 *  - the restore manifest is written to DISK **before** the first camera is
 *    paused, so a crash, a SIGKILL or a container swap mid-ramp still leaves a
 *    record of exactly what to put back;
 *  - restore runs in a `finally`, so it survives an exception, an abort and an
 *    early return;
 *  - the manifest is only deleted once every camera is verified restored;
 *  - a manifest found at startup means a previous run died — it is replayed,
 *    not ignored.
 *
 * A pause that cannot prove it was undone is worse than no measurement.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** What one camera looked like before the ramp touched it. */
export interface PausedCamera {
  readonly deviceId: number
  /** The `detectionMode` to put back. */
  readonly detectionMode: string
}

export interface PauseManifest {
  /** Wall-clock when the pause was taken — a stale manifest is still valid to
   *  replay, but its age tells the operator how long cameras were down. */
  readonly takenAtMs: number
  readonly nodeId: string
  readonly cameras: readonly PausedCamera[]
}

/** Where the manifest lives. One per node, under the addon's data dir. */
export function manifestPath(dataDir: string): string {
  return path.join(dataDir, 'capacity-pause-manifest.json')
}

/**
 * Persist the manifest. Called BEFORE any camera is paused — writing it after
 * would leave the window where a crash strands every camera it had already
 * touched.
 *
 * Written then fsync'd via a temp file + rename so a torn write cannot produce
 * a manifest that parses to fewer cameras than were actually paused.
 */
export function writeManifest(dataDir: string, manifest: PauseManifest): void {
  const target = manifestPath(dataDir)
  const tmp = `${target}.tmp`
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8')
  fs.renameSync(tmp, target)
}

/** Read a manifest left by a previous run, or null. Never throws: a corrupt
 *  manifest must not stop the process that would otherwise restore cameras. */
export function readManifest(dataDir: string): PauseManifest | null {
  try {
    const raw = fs.readFileSync(manifestPath(dataDir), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!isManifest(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

/** Remove it — only after every camera is verified back. */
export function clearManifest(dataDir: string): void {
  try {
    fs.rmSync(manifestPath(dataDir), { force: true })
  } catch {
    // A manifest we cannot delete replays next boot and restores already-live
    // cameras, which is a no-op. Failing to delete is safe; failing to restore
    // is not.
  }
}

function isManifest(v: unknown): v is PauseManifest {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Record<string, unknown>
  if (typeof m['takenAtMs'] !== 'number' || typeof m['nodeId'] !== 'string') return false
  if (!Array.isArray(m['cameras'])) return false
  return m['cameras'].every(
    (c) =>
      typeof c === 'object' &&
      c !== null &&
      typeof (c as Record<string, unknown>)['deviceId'] === 'number' &&
      typeof (c as Record<string, unknown>)['detectionMode'] === 'string',
  )
}

/**
 * Which cameras need pausing, and what to record for them.
 *
 * A camera already `disabled` is left OUT of the manifest: restoring it to
 * `disabled` is harmless, but including it would make the manifest claim
 * responsibility for a state the ramp did not cause — and on replay that is
 * indistinguishable from a camera the operator disabled deliberately.
 */
export function planPause(
  cameras: readonly { readonly deviceId: number; readonly detectionMode: string }[],
): readonly PausedCamera[] {
  return cameras
    .filter((c) => c.detectionMode !== 'disabled')
    .map((c) => ({ deviceId: c.deviceId, detectionMode: c.detectionMode }))
}
