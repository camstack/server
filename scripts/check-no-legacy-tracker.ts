#!/usr/bin/env tsx
/**
 * The old tracker stays deleted (D683).
 *
 * ## The failure this catches
 *
 * Eighteen tracker ADRs in 33 days each re-added a rule the previous one had
 * moved (D258 → D535, D283 → D436, D399 → D665 → D678). Tracker v2 replaced
 * the online single-hypothesis tracker with tracklets + deferred fusion +
 * presence; a resurrection clause or a destructive merge "just for this case"
 * is exactly how the fragility returns. A paragraph in a doc does not stop
 * that; this does.
 *
 * ## What it checks
 *
 * No source file (tests included) under packages/*\/src or server/*\/src
 * imports a deleted module, names a deleted identifier, or uses a retired
 * tracking setting key — as a plain object key, a property access, a QUOTED
 * object key, or bracket access. The key list is read from
 * `RETIRED_TRACKING_KEYS`, so the guard and the settings cannot disagree. It
 * also catches a deleted module's own filename reappearing under a
 * `tracker/` directory, imported or not.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { RETIRED_TRACKING_KEYS } from '../packages/addon-post-analysis/src/pipeline-analytics/tracking-settings.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const MODULES = [
  'sort-tracker',
  'reacquire',
  'rescue-growth',
  'bind-log',
  'spawn-beside-coasting',
  'track-loss',
  'stationary-freeze',
  'fragment-relink',
]
const IDENTIFIERS = ['SortTracker', 'resolveDuplicates', 'resurrectionScene', 'ResurrectionScene']

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return []
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return sources(full)
    return /\.(ts|tsx)$/.test(name) ? [full] : []
  })
}

function roots(): string[] {
  return ['packages', 'server'].flatMap((top) =>
    readdirSync(path.join(ROOT, top))
      .map((pkg) => path.join(ROOT, top, pkg, 'src'))
      .filter((dir) => {
        try {
          return statSync(dir).isDirectory()
        } catch {
          return false
        }
      }),
  )
}

const offenders: string[] = []
// Import SPECIFIERS only (review L5): `from '…/track-loss.js'`, `import('…')`,
// `require('…')` — never a string literal that merely says 'track-loss'.
const moduleRe = new RegExp(
  `(?:from\\s+|import\\s+|import\\s*\\(\\s*|require\\s*\\(\\s*)['"][^'"]*/(${MODULES.join('|')})(\\.js)?['"]`,
)
const identRe = new RegExp(`\\b(${IDENTIFIERS.join('|')})\\b`)
// Named in a comment in a FRAMEWORK package, deliberately not edited (review L6).
const MAY_NAME_OLD_IDENTIFIERS = [
  /packages\/system\/src\/builtins\/autotrack\/frame-measurements\.ts$/,
]
// Every key as an unquoted object key (`foo:`), a property access (`.foo`), a
// QUOTED object key (`'foo':`) or BRACKET access (`['foo']`/`["foo"]`) — fix
// round 1, L1: the quoted/bracket forms used to pass unseen.
const keyRe = new RegExp(
  `\\b(${RETIRED_TRACKING_KEYS.join('|')})\\b\\s*[:?]` +
    `|\\.(${RETIRED_TRACKING_KEYS.join('|')})\\b` +
    `|['"](${RETIRED_TRACKING_KEYS.join('|')})['"]\\s*[:\\]]`,
)
// The files that name retired keys BY DESIGN: the list itself, the tape reader
// that strips them from old tapes, and the two specs that prove both.
const MAY_NAME_RETIRED_KEYS = [
  /pipeline-analytics\/tracking-settings\.ts$/,
  /tracking-bench\/tape-schema\.ts$/,
  /__tests__\/tracking-settings\.spec\.ts$/,
  /__tests__\/tape-retired-settings\.spec\.ts$/,
]
// A deleted module's own FILENAME reappearing under a `tracker/` directory is
// the signal, whether or not anything imports it yet (fix round 1, L1).
const recreatedModuleRe = new RegExp(`/tracker/(${MODULES.join('|')})\\.tsx?$`)
for (const dir of roots()) {
  for (const file of sources(dir)) {
    const text = readFileSync(file, 'utf8')
    const rel = path.relative(ROOT, file)
    if (moduleRe.test(text)) offenders.push(`${rel}: imports a deleted tracker module`)
    if (identRe.test(text) && !MAY_NAME_OLD_IDENTIFIERS.some((re) => re.test(rel))) {
      offenders.push(`${rel}: names a deleted tracker identifier`)
    }
    if (keyRe.test(text) && !MAY_NAME_RETIRED_KEYS.some((re) => re.test(rel))) {
      offenders.push(`${rel}: uses a retired tracking setting`)
    }
    if (recreatedModuleRe.test(`/${rel}`)) {
      offenders.push(`${rel}: a deleted tracker module's filename reappeared`)
    }
  }
}
if (offenders.length > 0) {
  process.stderr.write(
    `check-no-legacy-tracker: the old tracker (D683) is back:\n${offenders.map((o) => `  ${o}`).join('\n')}\n`,
  )
  process.exit(1)
}
process.stdout.write('check-no-legacy-tracker: ok\n')
