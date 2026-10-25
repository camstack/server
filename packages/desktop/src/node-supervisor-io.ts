/**
 * Filesystem-backed adapters over the PURE supervisor logic
 * (`node-supervisor.ts`) — runtime-updatable node packages, phase 3.
 *
 * These read the node's data-dir server-root files (the restart-intent marker
 * + `state.json`) that the node's `@camstack/node-root`-backed update service
 * writes. The data-dir layout constants come straight from `@camstack/node-root`
 * (bundled into this shell's dist at build time), so there is one source of
 * truth. Kept out of `node-supervisor.ts` so that module stays import-free and
 * unit-testable; the composition here is trivial (path + fs) and exercised by
 * the manual Mac verification plan.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  RESTART_INTENT_FILE,
  SERVER_ROOT_DIRNAME,
  SERVER_ROOT_STATE_FILE,
} from '@camstack/node-root'
import {
  toNodeRootStateView,
  type NodeRootStateView,
  type RestartIntentMarker,
} from './node-supervisor'

function serverRootDir(dataDir: string): string {
  return path.join(dataDir, SERVER_ROOT_DIRNAME)
}

function isRestartIntentMarker(v: unknown): v is RestartIntentMarker {
  if (typeof v !== 'object' || v === null) return false
  const m: Record<string, unknown> = { ...v }
  return typeof m['requestedAtMs'] === 'number' && typeof m['reason'] === 'string'
}

/**
 * Read AND delete the restart-intent marker for `dataDir` (consume-once). The
 * marker is deleted regardless of validity so a corrupt/stale file can never
 * mis-classify a future exit. Returns the parsed marker, or null when absent /
 * unreadable / malformed.
 */
export function consumeRestartIntent(dataDir: string): RestartIntentMarker | null {
  const markerPath = path.join(serverRootDir(dataDir), RESTART_INTENT_FILE)
  let parsed: RestartIntentMarker | null = null
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(markerPath, 'utf-8'))
    if (isRestartIntentMarker(raw)) parsed = raw
  } catch {
    /* absent / unreadable / malformed → null */
  }
  try {
    fs.rmSync(markerPath, { force: true })
  } catch {
    /* best-effort delete */
  }
  return parsed
}

/** Read the node root-package `state.json` into the tray view (null if absent/corrupt). */
export function readNodeRootStateView(dataDir: string): NodeRootStateView | null {
  const statePath = path.join(serverRootDir(dataDir), SERVER_ROOT_STATE_FILE)
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
    return toNodeRootStateView(raw)
  } catch {
    return null
  }
}
