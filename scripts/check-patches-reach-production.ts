#!/usr/bin/env tsx
/**
 * A patch is only worth something if it reaches production. (D478)
 *
 * ## The failure this catches
 *
 * `patches/` is applied by `patch-package` on the repo root's `postinstall`,
 * which runs in a developer's and a CI runner's `node_modules` and nowhere
 * else. Whether the patched behaviour exists on a live node depends entirely on
 * how the patched package travels, and this repository ships both answers:
 *
 *  - `moleculer` is INLINED by rolldown into `@camstack/system/dist`, so the
 *    patch is inside the published tarball and inside the live closure. Fine —
 *    and provably so.
 *  - `werift` is NOT bundled: three addons resolve it at runtime from the
 *    framework closure, and the closure installs it from npm. From the day the
 *    patch was written until 2026-09-12 the hub, the agent-a agent and
 *    the Mac-mini agent all ran it UNPATCHED, while `session.ts`, two comments
 *    in `trpc.router.ts` and an ADR each described the patched behaviour as the
 *    one in effect. The repo's own specs passed the whole time: they load the
 *    DEV `node_modules`, which `patch-package` had just fixed.
 *
 * A spec over `node_modules` proves the patch is correct. Nothing proved it
 * ships. This guard is that proof, and it is deliberately unsympathetic: a
 * patch with no entry in `patches/patch-reach.json` fails, because a patch
 * nobody can say ships is a patch that does not.
 *
 * ## What it checks
 *
 * For every file in `patches/`:
 *  1. it has exactly one entry in `patch-reach.json`, and every entry has a
 *     patch file (no orphans either way);
 *  2. the entry's `version` matches the `<pkg>+<version>.patch` filename;
 *  3. every declared marker really is an ADDED line of that patch. A marker
 *     that the patch does not introduce would be found in the unpatched file
 *     too, and every check below it would be vacuous. This is the assertion
 *     that keeps the guard from becoming the thing it replaces;
 *  4. per `reach`:
 *     - `bundled`   — each `bundledInto` artifact exists and contains every
 *       marker, AND the patched package is not listed as an external of that
 *       package's vite build (the one edit that would silently un-bundle it);
 *     - `closure-postinstall` — `@camstack/server` carries the `postinstall`
 *       and ships the applier in `files`; the built payload under
 *       `dist/closure-patches/` (when present) is byte-identical to
 *       `patches/`; and every workspace package that declares the patched
 *       package pins the EXACT patched version, so npm cannot resolve a
 *       different one into the closure;
 *     - `dev-only`  — no PUBLISHABLE workspace package declares the patched
 *       package in `dependencies` or `peerDependencies`. The moment one does,
 *       `dev-only` is a false claim.
 *
 * ## Disarm-verified
 *
 * Each branch was confirmed to fail with the fix removed (see D478): the
 * `bundled` branch by grepping for the `pinsTooMuch` identifier rolldown
 * inlines away, the `closure-postinstall` branch by reverting werift in a
 * staged closure, the pin branch by restoring `^0.22.9`, and the marker check
 * by misspelling a marker.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PATCHES_DIR = path.join(ROOT, 'patches')
const MANIFEST_NAME = 'patch-reach.json'
const SERVER_PKG = path.join(ROOT, 'server', 'backend', 'package.json')
const SHIPPED_PAYLOAD = path.join(ROOT, 'server', 'backend', 'dist', 'closure-patches')
const APPLIER_REL = 'scripts/closure-postinstall.mjs'

type Reach = 'bundled' | 'closure-postinstall' | 'dev-only'

interface PatchEntry {
  readonly patch: string
  readonly package: string
  readonly version?: string
  readonly reach: Reach
  readonly bundledInto?: readonly string[]
  readonly markers?: readonly string[] | Readonly<Record<string, readonly string[]>>
  readonly declaredBy?: readonly string[]
}

interface WorkspacePkg {
  readonly dir: string
  readonly name: string
  readonly private: boolean
  readonly ranges: Readonly<Record<string, string>>
}

const failures: string[] = []
const fail = (msg: string): void => {
  failures.push(msg)
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Every marker declared by an entry, flattened — whatever shape it used. */
function markersOf(entry: PatchEntry): readonly string[] {
  const markers = entry.markers
  if (markers === undefined) return []
  if (Array.isArray(markers)) return markers
  return Object.values(markers).flat()
}

/** The lines a patch ADDS — the only text a marker may legitimately name. */
function addedLinesOf(diff: string): string {
  return diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n')
}

function collectWorkspacePackages(): readonly WorkspacePkg[] {
  const out: WorkspacePkg[] = []
  for (const group of ['packages', 'server']) {
    const base = path.join(ROOT, group)
    if (!fs.existsSync(base)) continue
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const pkgJson = path.join(base, entry.name, 'package.json')
      if (!fs.existsSync(pkgJson)) continue
      const pkg = asRecord(readJson(pkgJson))
      out.push({
        dir: `${group}/${entry.name}`,
        name: typeof pkg['name'] === 'string' ? pkg['name'] : `${group}/${entry.name}`,
        private: pkg['private'] === true,
        ranges: {
          ...(asRecord(pkg['dependencies']) as Record<string, string>),
          ...(asRecord(pkg['peerDependencies']) as Record<string, string>),
        },
      })
    }
  }
  return out
}

function checkBundled(entry: PatchEntry, markers: readonly string[]): void {
  const artifacts = entry.bundledInto ?? []
  if (artifacts.length === 0) {
    fail(`${entry.patch}: reach "bundled" but no "bundledInto" artifact declared`)
    return
  }
  for (const rel of artifacts) {
    const file = path.join(ROOT, rel)
    if (!fs.existsSync(file)) {
      fail(
        `${entry.patch}: declared bundle artifact is missing: ${rel} — ` +
          'this guard runs AFTER `npm run build`; run it',
      )
      continue
    }
    const text = fs.readFileSync(file, 'utf-8')
    for (const marker of markers) {
      if (!text.includes(marker)) {
        fail(
          `${entry.patch}: ${rel} does not carry ${JSON.stringify(marker)} — ` +
            `the patch to ${entry.package} is NOT in what ships`,
        )
      }
    }
    // The one edit that would un-bundle it silently: adding the package to the
    // vite preset's externals for the package that owns this artifact.
    const owner = rel.split('/').slice(0, 2).join('/')
    const viteConfig = path.join(ROOT, owner, 'vite.config.ts')
    if (fs.existsSync(viteConfig)) {
      const config = fs.readFileSync(viteConfig, 'utf-8')
      const quoted = [`'${entry.package}'`, `"${entry.package}"`]
      if (quoted.some((q) => config.includes(q))) {
        fail(
          `${owner}/vite.config.ts names ${entry.package} — a bundled patch ` +
            'must not be an external of the build that carries it',
        )
      }
    }
  }
}

function checkClosurePostinstall(
  entry: PatchEntry,
  diff: string,
  workspaces: readonly WorkspacePkg[],
): void {
  const serverPkg = asRecord(readJson(SERVER_PKG))
  const scripts = asRecord(serverPkg['scripts'])
  if (typeof scripts['postinstall'] !== 'string' || !scripts['postinstall'].includes(APPLIER_REL)) {
    fail(
      `${entry.patch}: reach "closure-postinstall" needs @camstack/server to run ` +
        `${APPLIER_REL} from its postinstall — it does not`,
    )
  }
  const files = Array.isArray(serverPkg['files']) ? (serverPkg['files'] as readonly unknown[]) : []
  if (!files.includes(APPLIER_REL)) {
    fail(
      `${entry.patch}: @camstack/server's "files" must include ${APPLIER_REL}, ` +
        'or the applier is not in the published tarball',
    )
  }
  if (!fs.existsSync(path.join(ROOT, 'server', 'backend', APPLIER_REL))) {
    fail(`${entry.patch}: ${APPLIER_REL} does not exist`)
  }

  // The shipped copy must be the SAME bytes as patches/. Built output, so only
  // checked when it is there — the byte comparison is what keeps `patches/`
  // the single authority instead of a second copy that can drift.
  const shipped = path.join(SHIPPED_PAYLOAD, entry.patch)
  if (fs.existsSync(SHIPPED_PAYLOAD)) {
    if (!fs.existsSync(shipped)) {
      fail(`${entry.patch}: declared closure-postinstall but absent from dist/closure-patches/`)
    } else if (fs.readFileSync(shipped, 'utf-8') !== diff) {
      fail(`${entry.patch}: dist/closure-patches/ copy differs from patches/ — rebuild`)
    }
  }

  // A range that lets npm resolve a version the patch was not taken from is
  // the same defect one release later: the applier refuses, the validator
  // refuses, and the update does not apply. Forbid the range instead.
  const pinned = entry.version
  if (typeof pinned !== 'string') {
    fail(`${entry.patch}: reach "closure-postinstall" requires an exact "version"`)
    return
  }
  const declarers = workspaces.filter((w) => w.ranges[entry.package] !== undefined)
  if (declarers.length === 0) {
    fail(
      `${entry.patch}: no workspace package declares ${entry.package} — ` +
        'nothing puts it in the closure, so "closure-postinstall" is the wrong reach',
    )
  }
  for (const declarer of declarers) {
    const range = declarer.ranges[entry.package]
    if (range !== pinned) {
      fail(
        `${declarer.dir} declares ${entry.package}@${String(range)} — a patched ` +
          `closure dependency must be pinned EXACTLY to ${pinned}, or npm can ` +
          'install a version the patch does not apply to',
      )
    }
  }
  const declared = new Set(entry.declaredBy ?? [])
  for (const declarer of declarers) {
    if (declared.size > 0 && !declared.has(declarer.dir)) {
      fail(
        `${declarer.dir} declares ${entry.package} but is not in "declaredBy" for ` +
          `${entry.patch} — the manifest must name every package that pulls it in`,
      )
    }
  }
  for (const name of declared) {
    if (!declarers.some((d) => d.dir === name)) {
      fail(`${entry.patch}: "declaredBy" names ${name}, which no longer declares ${entry.package}`)
    }
  }
}

function checkDevOnly(entry: PatchEntry, workspaces: readonly WorkspacePkg[]): void {
  for (const pkg of workspaces) {
    if (pkg.private) continue
    if (pkg.ranges[entry.package] !== undefined) {
      fail(
        `${entry.patch}: reach "dev-only" but the PUBLISHABLE package ${pkg.dir} ` +
          `declares ${entry.package} — the patch now has production reach and ` +
          'nothing applies it there',
      )
    }
  }
}

function main(): void {
  const manifestPath = path.join(PATCHES_DIR, MANIFEST_NAME)
  if (!fs.existsSync(manifestPath)) {
    process.stderr.write(`missing ${manifestPath}\n`)
    process.exit(1)
  }
  const manifest = asRecord(readJson(manifestPath))
  const entries = (Array.isArray(manifest['patches']) ? manifest['patches'] : []) as PatchEntry[]
  const onDisk = fs
    .readdirSync(PATCHES_DIR)
    .filter((f) => f.endsWith('.patch'))
    .toSorted()
  const workspaces = collectWorkspacePackages()

  const declaredNames = new Set(entries.map((e) => e.patch))
  for (const file of onDisk) {
    if (!declaredNames.has(file)) {
      fail(
        `patches/${file} has no entry in ${MANIFEST_NAME} — every patch must say ` +
          'how it reaches production (bundled | closure-postinstall | dev-only)',
      )
    }
  }

  for (const entry of entries) {
    if (!onDisk.includes(entry.patch)) {
      fail(`${MANIFEST_NAME} declares ${entry.patch}, which does not exist in patches/`)
      continue
    }
    const diff = fs.readFileSync(path.join(PATCHES_DIR, entry.patch), 'utf-8')

    // `<pkg>+<version>.patch` — patch-package's own naming; the entry must agree.
    const match = /^(.+)\+(.+)\.patch$/.exec(entry.patch)
    if (match === null) {
      fail(`${entry.patch}: not a patch-package filename (<pkg>+<version>.patch)`)
    } else {
      if (match[1] !== entry.package) {
        fail(
          `${entry.patch}: filename says package ${String(match[1])}, entry says ${entry.package}`,
        )
      }
      if (entry.version !== undefined && match[2] !== entry.version) {
        fail(`${entry.patch}: filename says ${String(match[2])}, entry says ${entry.version}`)
      }
    }

    const markers = markersOf(entry)
    if (entry.reach !== 'dev-only' && markers.length === 0) {
      fail(`${entry.patch}: reach ${entry.reach} needs at least one marker`)
    }
    const added = addedLinesOf(diff)
    for (const marker of markers) {
      if (!added.includes(marker)) {
        fail(
          `${entry.patch}: marker ${JSON.stringify(marker)} is not an ADDED line of ` +
            'the patch — it would be found in the unpatched file too, making every ' +
            'check that uses it vacuous',
        )
      }
    }

    switch (entry.reach) {
      case 'bundled':
        checkBundled(entry, markers)
        break
      case 'closure-postinstall':
        checkClosurePostinstall(entry, diff, workspaces)
        break
      case 'dev-only':
        checkDevOnly(entry, workspaces)
        break
      default:
        fail(`${entry.patch}: unknown reach ${JSON.stringify(entry.reach)}`)
    }
  }

  if (failures.length > 0) {
    for (const line of failures) process.stderr.write(`  ✗ ${line}\n`)
    process.stderr.write(`\n${String(failures.length)} patch-reach violation(s)\n`)
    process.exit(1)
  }
  process.stdout.write(
    `✓ ${String(entries.length)} patch(es) reach production as declared ` +
      `(${entries.map((e) => `${e.package}:${e.reach}`).join(', ')})\n`,
  )
}

main()
