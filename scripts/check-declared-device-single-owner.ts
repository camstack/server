#!/usr/bin/env tsx
/**
 * Declared-device ownership guard — there is ONE get-or-create for a device an
 * addon declares, and it is `DeclaredDevices`.
 *
 * ## The failure this catches
 *
 * The 2026-08-04 spec called for a generic ownership primitive and nobody built
 * it. The single caller — the Notification Center's alarm panel — inlined a
 * hand-rolled `ensureAlarmPanel` with eight injected dependencies instead, and
 * that copy shipped two defects of its own: `info.fixed` written only on the
 * create path (so no existing install ever received the flag), and a device
 * index read ONCE, so a transiently empty answer took the first-boot branch and
 * re-stamped the declared name over the operator's rename.
 *
 * Neither defect is visible in review of the file that has it: each looks like
 * ordinary get-or-create. What makes them findable is that there is exactly one
 * implementation to read. A second `ensureXPanel` is how the class of bug comes
 * back, so it gets a check rather than a paragraph.
 *
 * ## What it checks
 *
 * 1. `DeclaredDevices` is declared in exactly one file — {@link OWNER_FILE}.
 * 2. No file declares a rival get-or-create helper: a function or method whose
 *    name matches `ensure<X>Device|Panel|Integration` or
 *    `getOrCreate<X>Device|Panel|Integration`.
 *
 * Both are declarations — present or absent, never a judgement call. A guard
 * with false positives gets deleted, and this one is worth keeping.
 *
 * Usage: tsx scripts/check-declared-device-single-owner.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/** The one module allowed to own a declared device. */
const OWNER_FILE = 'packages/types/src/device/declared-device.ts'

/** The exported primitive everything else must go through. */
const PRIMITIVE = 'DeclaredDevices'

/**
 * A rival get-or-create, by name.
 *
 * Narrow on purpose: only `ensure`/`getOrCreate` prefixes over the three nouns
 * this primitive owns. `ensureDirectory`, `ensureFfmpeg`, `ensureBinary` and
 * every other `ensure*` in the repo are untouched — a broad rule would fire on
 * correct code and get this file deleted.
 */
const RIVAL_NAME = /^(?:ensure|getOrCreate)[A-Z]\w*(?:Device|Devices|Panel|Integration)$/

/**
 * `<file>#<name>` pairs permitted despite matching, each with the reason.
 *
 * Keyed by file AND name on purpose: an exception is for one known site, never
 * for a name that anybody may reuse anywhere. An entry here is a deliberate
 * second owner — argue for it, do not add one to make a build green.
 */
const ALLOWED: ReadonlyMap<string, string> = new Map([
  [
    'packages/addon-provider-homeassistant/src/addon.ts#ensureEventBusDevice',
    'the per-broker HA bus aggregator: keyed by brokerId (not a cluster singleton), owned by a BaseDeviceProvider, and hung from no fixed integration. It carries the same single-read shape as the alarm panel did and SHOULD move onto the primitive — tracked, not waived forever.',
  ],
])

interface Problem {
  readonly where: string
  readonly what: string
  readonly fix: string
}

function sourceFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      sourceFiles(full, out)
      continue
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
}

function allSources(): readonly string[] {
  const files: string[] = []
  for (const root of ['packages', 'server']) sourceFiles(path.join(ROOT, root), files)
  return files.filter((f) => !f.includes(`${path.sep}generated${path.sep}`))
}

const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/')

const isTest = (relative: string): boolean =>
  relative.includes('__tests__/') || relative.endsWith('.spec.ts') || relative.endsWith('.test.ts')

function checkSingleDeclaration(files: readonly string[], problems: Problem[]): void {
  const declaring = files.filter((file) => {
    if (isTest(rel(file))) return false
    return new RegExp(`export\\s+class\\s+${PRIMITIVE}\\b`).test(fs.readFileSync(file, 'utf-8'))
  })

  if (declaring.length === 1 && rel(declaring[0]!) === OWNER_FILE) return
  if (declaring.length === 0) {
    problems.push({
      where: OWNER_FILE,
      what: `\`${PRIMITIVE}\` is not declared anywhere`,
      fix: 'this guard is checking a primitive that no longer exists — restore it, or retire the guard deliberately rather than by deletion',
    })
    return
  }
  for (const file of declaring) {
    if (rel(file) === OWNER_FILE) continue
    problems.push({
      where: rel(file),
      what: `a SECOND \`${PRIMITIVE}\` is declared here`,
      fix: `there is one declared-device primitive, in ${OWNER_FILE} — import it instead of redeclaring it`,
    })
  }
}

function checkNoRivalHelper(files: readonly string[], problems: Problem[]): void {
  // `function ensureX(` · `const ensureX = ` · `private async ensureX(` (a
  // method, with any combination of modifiers).
  const declaration =
    /(?:^|\n)\s*(?:export\s+)?(?:(?:public|private|protected|static|readonly|async|const|let|var|function)\s+)*(?:function\s+)?([A-Za-z_$][\w$]*)\s*(?:\(|=\s*(?:async\s*)?\()/g

  for (const file of files) {
    const relative = rel(file)
    if (relative === OWNER_FILE || isTest(relative)) continue
    const source = fs.readFileSync(file, 'utf-8')
    declaration.lastIndex = 0
    const seen = new Set<string>()
    for (let m = declaration.exec(source); m !== null; m = declaration.exec(source)) {
      const name = m[1]
      if (name === undefined || seen.has(name)) continue
      if (!RIVAL_NAME.test(name)) continue
      if (ALLOWED.has(`${relative}#${name}`)) continue
      seen.add(name)
      problems.push({
        where: relative,
        what: `declares \`${name}\` — a second get-or-create for a device an addon owns`,
        fix: `build a \`DeviceDeclaration\` and call \`new DeclaredDevices(ports).reconcile(...)\` (${OWNER_FILE}). A hand-rolled copy is how the \`fixed\`-only-on-create and single-index-read defects got here.`,
      })
    }
  }
}

function main(): void {
  const files = allSources()
  if (files.length === 0) {
    console.error('\x1b[31m✘ no source files found — check the repo layout\x1b[0m')
    process.exit(1)
  }

  const problems: Problem[] = []
  checkSingleDeclaration(files, problems)
  checkNoRivalHelper(files, problems)

  if (problems.length > 0) {
    console.error(`\x1b[31m✘ ${problems.length} declared-device ownership violation(s)\x1b[0m:`)
    for (const p of problems) {
      console.error(`    ${p.where}: ${p.what}`)
      console.error(`      → ${p.fix}`)
    }
    console.error(
      '    Why this matters: owning a declared device is a reconcile with a second-read rule (D49); a copy of it is a copy of the bugs.',
    )
    process.exit(1)
  }
  console.log('  ✔ a declared device has exactly one get-or-create')
}

main()
