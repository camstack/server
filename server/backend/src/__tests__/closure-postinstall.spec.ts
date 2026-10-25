/**
 * `scripts/closure-postinstall.mjs` — the applier that carries a patch into the
 * framework closure. (D478)
 *
 * ## Why this spec runs the REAL patch against a REAL package
 *
 * The spec this replaces the habit of: `moleculer-tcp-parser.spec.ts` proves
 * the patch is CORRECT by loading the dev `node_modules`, which `patch-package`
 * has already fixed. That is a real guard and it does fail when the patch is
 * reversed — but it cannot see whether the patch reached a live node, and for
 * `werift` the answer was no, on three nodes, for eight weeks.
 *
 * So this one asks the shipping question instead. It stages a genuine closure
 * layout, puts a genuinely UNPATCHED copy of the package in it (by reversing
 * the repo's own patch onto a copy — never the installed tree), runs the
 * applier exactly as npm's `postinstall` would, and requires the result to be
 * byte-identical to what `patch-package` produces. A hand-written applier that
 * is merely "close enough" would ship a subtly different werift to production,
 * so equality is the assertion, not a marker grep.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const PATCHES_DIR = path.join(REPO_ROOT, 'patches')
const APPLIER = path.join(REPO_ROOT, 'server', 'backend', 'scripts', 'closure-postinstall.mjs')

interface PatchEntry {
  readonly patch: string
  readonly package: string
  readonly version: string
  readonly reach: string
  readonly markers: Readonly<Record<string, readonly string[]>>
}

function closurePatchEntries(): readonly PatchEntry[] {
  const manifest: unknown = JSON.parse(
    fs.readFileSync(path.join(PATCHES_DIR, 'patch-reach.json'), 'utf-8'),
  )
  const list = (manifest as { readonly patches?: readonly PatchEntry[] }).patches ?? []
  return list.filter((e) => e.reach === 'closure-postinstall')
}

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** Patched files only — `werift` is ~5 MB but the closure patch touches six. */
function copyPackagePatchScope(sourceRoot: string, destRoot: string, entry: PatchEntry): void {
  fs.mkdirSync(destRoot, { recursive: true })
  fs.copyFileSync(path.join(sourceRoot, 'package.json'), path.join(destRoot, 'package.json'))
  for (const rel of Object.keys(entry.markers)) {
    const from = path.join(sourceRoot, ...rel.split('/'))
    const to = path.join(destRoot, ...rel.split('/'))
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
  }
}

/**
 * Build `<tmp>/node_modules/{@camstack/server/{scripts,dist/closure-patches},<pkg>}`
 * — the layout the applier sees when npm runs it inside a staging closure.
 */
function stageClosure(entry: PatchEntry, installedDir: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-postinstall-'))
  made.push(dir)
  const server = path.join(dir, 'node_modules', '@camstack', 'server')
  fs.mkdirSync(path.join(server, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(server, 'dist', 'closure-patches'), { recursive: true })
  fs.copyFileSync(APPLIER, path.join(server, 'scripts', 'closure-postinstall.mjs'))
  fs.copyFileSync(
    path.join(PATCHES_DIR, 'patch-reach.json'),
    path.join(server, 'dist', 'closure-patches', 'patch-reach.json'),
  )
  fs.copyFileSync(
    path.join(PATCHES_DIR, entry.patch),
    path.join(server, 'dist', 'closure-patches', entry.patch),
  )
  copyPackagePatchScope(installedDir, path.join(dir, 'node_modules', entry.package), entry)
  return dir
}

function runApplier(closureDir: string): string {
  return execFileSync(
    process.execPath,
    [
      path.join(
        closureDir,
        'node_modules',
        '@camstack',
        'server',
        'scripts',
        'closure-postinstall.mjs',
      ),
    ],
    { encoding: 'utf-8' },
  )
}

/** A copy of the installed package with the repo's patch REVERSED. */
function unpatchedCopyOf(entry: PatchEntry): string | null {
  const installed = path.join(REPO_ROOT, 'node_modules', entry.package)
  if (!fs.existsSync(path.join(installed, 'package.json'))) return null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unpatched-'))
  made.push(dir)
  copyPackagePatchScope(installed, dir, entry)
  execFileSync('patch', ['-R', '-p3', '--silent', '-i', path.join(PATCHES_DIR, entry.patch)], {
    cwd: dir,
  })
  return dir
}

const CASES: readonly [string, PatchEntry][] = closurePatchEntries().map((e) => [e.patch, e])

// `[name, entry]` rather than the entry alone: vitest stringifies the whole
// parameter into the test title, and these entries carry a paragraph of prose.
describe.each(CASES)('closure patch %s', (_name, entry) => {
  const installed = path.join(REPO_ROOT, 'node_modules', entry.package)
  const present = fs.existsSync(path.join(installed, 'package.json'))

  it.runIf(present)('reproduces patch-package byte for byte on an unpatched copy', () => {
    const unpatched = unpatchedCopyOf(entry)
    expect(unpatched).not.toBeNull()
    if (unpatched === null) return

    // Every patched file really is unpatched to start with — otherwise the
    // assertion below would hold against an applier that does nothing.
    for (const [rel, markers] of Object.entries(entry.markers)) {
      const before = fs.readFileSync(path.join(unpatched, ...rel.split('/')), 'utf-8')
      for (const marker of markers) expect(before, `${rel} before`).not.toContain(marker)
    }

    const closure = stageClosure(entry, unpatched)
    const out = runApplier(closure)
    expect(out).toContain(`APPLIED ${entry.package}@${entry.version}`)

    for (const rel of Object.keys(entry.markers)) {
      const applied = fs.readFileSync(
        path.join(closure, 'node_modules', entry.package, ...rel.split('/')),
        'utf-8',
      )
      const reference = fs.readFileSync(path.join(installed, ...rel.split('/')), 'utf-8')
      expect(applied, `${rel} must equal patch-package's output`).toBe(reference)
    }
  })

  it.runIf(present)('is idempotent — a second run changes nothing', () => {
    const unpatched = unpatchedCopyOf(entry)
    if (unpatched === null) return
    const closure = stageClosure(entry, unpatched)
    runApplier(closure)
    const first = Object.keys(entry.markers).map((rel) =>
      fs.readFileSync(
        path.join(closure, 'node_modules', entry.package, ...rel.split('/')),
        'utf-8',
      ),
    )
    const out = runApplier(closure)
    expect(out).toContain('already applied')
    const second = Object.keys(entry.markers).map((rel) =>
      fs.readFileSync(
        path.join(closure, 'node_modules', entry.package, ...rel.split('/')),
        'utf-8',
      ),
    )
    expect(second).toEqual(first)
  })

  it.runIf(present)('REFUSES a version the patch was not taken from, and writes nothing', () => {
    const unpatched = unpatchedCopyOf(entry)
    if (unpatched === null) return
    const pkgJson = path.join(unpatched, 'package.json')
    const pkg: Record<string, unknown> = JSON.parse(fs.readFileSync(pkgJson, 'utf-8'))
    fs.writeFileSync(pkgJson, JSON.stringify({ ...pkg, version: '9.9.9' }))

    const closure = stageClosure(entry, unpatched)
    const out = runApplier(closure)
    expect(out).toContain(`REFUSE ${entry.package}@9.9.9`)
    for (const [rel, markers] of Object.entries(entry.markers)) {
      const after = fs.readFileSync(
        path.join(closure, 'node_modules', entry.package, ...rel.split('/')),
        'utf-8',
      )
      for (const marker of markers) expect(after, `${rel} must be untouched`).not.toContain(marker)
    }
  })

  it('leaves the closure alone when the package is not installed there', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-empty-'))
    made.push(dir)
    const server = path.join(dir, 'node_modules', '@camstack', 'server')
    fs.mkdirSync(path.join(server, 'scripts'), { recursive: true })
    fs.mkdirSync(path.join(server, 'dist', 'closure-patches'), { recursive: true })
    fs.copyFileSync(APPLIER, path.join(server, 'scripts', 'closure-postinstall.mjs'))
    fs.copyFileSync(
      path.join(PATCHES_DIR, 'patch-reach.json'),
      path.join(server, 'dist', 'closure-patches', 'patch-reach.json'),
    )
    fs.copyFileSync(
      path.join(PATCHES_DIR, entry.patch),
      path.join(server, 'dist', 'closure-patches', entry.patch),
    )
    expect(runApplier(dir)).toContain(`SKIP ${entry.package} — not installed`)
  })
})
