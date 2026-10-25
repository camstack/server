#!/usr/bin/env tsx
/**
 * Viewer ship-chain guard — refuses a commit whose EMBEDDED WEB VIEWER lags the
 * viewer version the repository pins.
 *
 * ## The failure this catches
 *
 * The viewer reaches operators over TWO independent ship chains, and only one
 * of them is convenient:
 *
 *   - the native app, via `npm run update:*` (an EAS OTA). Instant, and it
 *     touches nothing in this repository;
 *   - the WEB viewer the hub serves at `/viewer`, which is a static export
 *     copied into `packages/addon-pipeline-orchestrator/assets/viewer/` by
 *     `npm run build:orchestrator` and shipped by `camstack deploy`.
 *
 * Nothing compared them. On 2026-07-31 the hub was serving viewer **1.0.186,
 * built 24 July**, while the app had shipped through **1.0.204** — eighteen
 * versions. The landscape timeline and the loading-spinner change were live on
 * mobile and absent in every browser, and the operator reported them as "not
 * implemented". Each OTA had quietly widened the gap.
 *
 * This is structural, not an oversight: the OTA is one command and rebuilding
 * the web bundle is three, so the fast path silently becomes the only path.
 * A guard is the only thing that makes the slow half visible.
 *
 * ## What it compares
 *
 * `assets/viewer/.viewer-version` carries `<version>+<commit>` stamped at build
 * time by `scripts/copy-dist-to-orchestrator.js`. The pinned viewer version is
 * the `version` in the submodule's `package.json`. Equal ⇒ the bundle on disk
 * was built from the pinned viewer.
 *
 * Deliberately NOT compared: the commit hash. A viewer commit that changes only
 * the iOS project or a workflow does not change the web bundle, and failing on
 * that would train everyone to bypass the guard — which is how a guard stops
 * being one.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MARKER = path.join(ROOT, 'packages/addon-pipeline-orchestrator/assets/viewer/.viewer-version')
const VIEWER_PKG = path.join(ROOT, 'camstack/package.json')

/** `1.0.205+fdba289` → `{ version: '1.0.205', commit: 'fdba289' }`. */
export function parseMarker(raw: string): { version: string; commit?: string } | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const [version, commit] = trimmed.split('+')
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) return null
  return commit ? { version, commit } : { version }
}

/** Compare two semver-ish strings. Returns <0, 0 or >0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10))
  const pb = b.split('.').map((n) => Number.parseInt(n, 10))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export interface ViewerBuildVerdict {
  readonly ok: boolean
  readonly message: string
}

export function checkViewerBuild(input: {
  readonly markerRaw: string | null
  readonly pinnedVersion: string | null
}): ViewerBuildVerdict {
  // The submodule is not checked out (CI clones without it, and the image's
  // `git archive` excludes it). Nothing to compare — never a failure.
  if (input.pinnedVersion === null) {
    return { ok: true, message: 'viewer submodule not checked out — skipped' }
  }
  if (input.markerRaw === null) {
    return {
      ok: false,
      message:
        'the embedded web viewer has no .viewer-version marker. Run `npm run build:orchestrator` in the viewer repo.',
    }
  }
  const marker = parseMarker(input.markerRaw)
  if (marker === null) {
    return {
      ok: false,
      message: `.viewer-version is unreadable: ${JSON.stringify(input.markerRaw)}`,
    }
  }
  const delta = compareVersions(marker.version, input.pinnedVersion)
  if (delta === 0) {
    return { ok: true, message: `embedded web viewer is ${marker.version}, matching the pin` }
  }
  if (delta > 0) {
    // Ahead of the pin: the bundle was built from an unpinned viewer commit.
    // Not the failure this guard exists for, but still a disagreement worth
    // naming rather than passing silently.
    return {
      ok: false,
      message: `the embedded web viewer (${marker.version}) is AHEAD of the pinned viewer (${input.pinnedVersion}) — pin the submodule.`,
    }
  }
  return {
    ok: false,
    message:
      `the embedded web viewer is ${marker.version} but the repository pins viewer ${input.pinnedVersion}. ` +
      'An OTA does not rebuild it: run `npm run build:orchestrator` in the viewer repo, then ' +
      '`camstack deploy packages/addon-pipeline-orchestrator`. ' +
      '(Serving a stale bundle is how the hub sat 18 versions behind the app for a week.)',
  }
}

function main(): void {
  const markerRaw = fs.existsSync(MARKER) ? fs.readFileSync(MARKER, 'utf-8') : null
  let pinnedVersion: string | null = null
  if (fs.existsSync(VIEWER_PKG)) {
    const parsed: unknown = JSON.parse(fs.readFileSync(VIEWER_PKG, 'utf-8'))
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const v = (parsed as { version?: unknown }).version
      if (typeof v === 'string') pinnedVersion = v
    }
  }

  const verdict = checkViewerBuild({ markerRaw, pinnedVersion })
  if (!verdict.ok) {
    console.error(`\x1b[31m✘ viewer web build\x1b[0m: ${verdict.message}`)
    process.exit(1)
  }
  console.log(`  ✔ ${verdict.message}`)
}

// Only run when invoked directly — the pure helpers above are imported by tests.
if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main()
}
