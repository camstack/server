#!/usr/bin/env tsx
/**
 * State-model guard — a storage location's state is interpreted in ONE place.
 *
 * ## The bug class this prevents
 *
 * A location's state used to live in two authorities: the typed
 * `StorageLocation.enabled` (the write switch, D383) and an untyped
 * `config.readOnly` key. They did not mean the same thing — `enabled: false`
 * was still evicted under disk pressure while `config.readOnly` was
 * deliberately excluded from it, and neither name said so — and six consumers
 * each re-derived the difference by hand. Two of them got it wrong in opposite
 * directions.
 *
 * D385 replaces both with `StorageLocation.mode` and one PURE policy module,
 * `packages/types/src/interfaces/storage-location-mode.ts`, which answers three
 * questions and nothing else: may this be written, may it be read, what is its
 * eviction policy. The legacy pair survives one release as a DERIVED mirror.
 *
 * Nothing catches a seventh hand-rolled interpretation in review: it looks
 * correct in isolation, and it is wrong only relative to a table nobody has
 * open. So it gets a check.
 *
 * ## What this enforces, inside the storage-location trees only
 *
 * 1. **`config['readOnly']` / `config.readOnly` is read only by the policy
 *    module.** Everything else asks `resolveLocationMode` (or the three
 *    questions) — that is what folds the legacy key, in one place.
 * 2. **`enabled` is not COMPARED directly** (`=== false`, `!== false`,
 *    `=== true`, `?? true`, `!location.enabled`). It is a derived mirror now;
 *    a comparison is a second interpretation of the state.
 *
 * Each rule has an allowlist with a reason per file. A file leaves the list the
 * day it stops being the migration, the persistence layer, or the policy.
 *
 * `packages/addon-admin-ui` is deliberately NOT scanned yet: the storage screen
 * is being rewritten onto `mode` in the same release train, and a guard that
 * fails on the half that has not landed teaches people to disable guards. It
 * joins {@link SOURCE_ROOTS} when that lands.
 *
 * Usage: npx tsx scripts/check-storage-location-mode-single-owner.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')

/**
 * The trees that deal with storage locations. Narrow on purpose: `enabled` is
 * an extremely common field name across this repo (rules, notifiers, devices,
 * feature flags), and a repo-wide `enabled ===` rule would be noise rather than
 * a guard.
 */
const SOURCE_ROOTS: readonly string[] = [
  'packages/types/src/interfaces',
  'packages/types/src/capabilities',
  'packages/system/src/builtins/storage-orchestrator',
  'packages/system/src/builtins/backup-orchestrator',
  'packages/addon-pipeline/src/recorder',
  'packages/addon-post-analysis/src/pipeline-analytics',
]

/** The retired untyped drain key, read off a location's config blob. */
const READS_LEGACY_READONLY = /\bconfig\s*(?:\?\.)?(?:\[\s*['"]readOnly['"]\s*\]|\.readOnly\b)/

/**
 * A direct comparison of the derived `enabled` mirror ON A LOCATION.
 *
 * Receiver-qualified, because `enabled` is one of the most common field names
 * in this repo — recording configs, notification rules, backup schedules and
 * audio status all have one, and a bare `.enabled ===` rule would fire on all
 * of them and teach people to ignore this guard.
 */
const LOCATION_RECEIVER =
  '(?:loc|locs|location|locations|target|source|destination|sibling|candidate|l)\\w*'
const COMPARES_ENABLED = new RegExp(
  `\\b${LOCATION_RECEIVER}(?:\\?)?\\.enabled\\s*(?:===|!==)\\s*(?:false|true)\\b` +
    `|\\b${LOCATION_RECEIVER}(?:\\?)?\\.enabled\\s*\\?\\?\\s*true\\b`,
)

/** Only files that actually deal with storage locations are judged on
 *  `enabled` — the field name is far too common to test blind. */
const MENTIONS_STORAGE_LOCATION =
  /\bStorageLocation\b|\bRecordingsLocation\b|\bMediaLocation\b|\bstorage_locations\b|\bDiscardLocationRow\b|\blistLocations\b/

interface Exemption {
  readonly file: string
  readonly why: string
}

/** The ONE module allowed to read the retired key, plus the persistence layer
 *  that has to write and strip it. */
const LEGACY_READONLY_READERS: readonly Exemption[] = [
  {
    file: 'packages/types/src/interfaces/storage-location-mode.ts',
    why: 'IS the policy module — it names the key once and folds it into a mode',
  },
]

/** Files allowed to compare `enabled` directly, each with the reason. */
const ENABLED_COMPARERS: readonly Exemption[] = [
  {
    file: 'packages/types/src/interfaces/storage-location-mode.ts',
    why: 'the legacy fold: this is where `enabled === false` becomes a mode, once',
  },
  {
    file: 'packages/system/src/builtins/storage-orchestrator/location-store.ts',
    why: 'persistence — writes the mirror to disk and reads it back; it interprets nothing',
  },
]

interface Problem {
  readonly where: string
  readonly what: string
  readonly fix: string
}

/** Strip comments so a docblock that MENTIONS the key never counts — several
 *  of these files explain the migration in prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function sourceFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'generated' ||
        entry.name === '__tests__'
      ) {
        continue
      }
      sourceFiles(full, out)
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    if (/\.spec\.tsx?$|\.test\.tsx?$/.test(entry.name)) continue
    if (entry.name.startsWith('generated-')) continue
    out.push(full)
  }
}

function relative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join('/')
}

function main(): void {
  const files: string[] = []
  for (const root of SOURCE_ROOTS) sourceFiles(path.join(ROOT, root), files)

  const legacyAllowed = new Set(LEGACY_READONLY_READERS.map((e) => e.file))
  const enabledAllowed = new Set(ENABLED_COMPARERS.map((e) => e.file))
  const problems: Problem[] = []

  for (const file of files) {
    const rel = relative(file)
    const code = stripComments(fs.readFileSync(file, 'utf8'))

    if (READS_LEGACY_READONLY.test(code) && !legacyAllowed.has(rel)) {
      problems.push({
        where: rel,
        what: 'reads the retired `config.readOnly` key',
        fix:
          'Ask the policy module instead: `resolveLocationMode(location)`, or one of ' +
          '`mayWriteToLocation` / `mayReadLocation` / `evictionPolicyOfLocation`. It folds the ' +
          'legacy key for an unmigrated row, in ONE place. See D385.',
      })
    }

    if (
      COMPARES_ENABLED.test(code) &&
      MENTIONS_STORAGE_LOCATION.test(code) &&
      !enabledAllowed.has(rel)
    ) {
      problems.push({
        where: rel,
        what: 'compares `StorageLocation.enabled` directly',
        fix:
          '`enabled` is a DERIVED mirror of `mode` for one release (D385) — comparing it is a ' +
          'second interpretation of the state. Ask `mayWriteToLocation(location)`. If this file ' +
          'is the migration or the persistence layer, add it to ENABLED_COMPARERS with the reason.',
      })
    }
  }

  // The policy module must still exist and still answer all three questions —
  // a guard that only forbids the old spelling would pass a repo where the
  // policy had been deleted.
  const policy = path.join(ROOT, 'packages/types/src/interfaces/storage-location-mode.ts')
  if (!fs.existsSync(policy)) {
    problems.push({
      where: 'packages/types/src/interfaces/storage-location-mode.ts',
      what: 'the policy module is GONE',
      fix: 'If it moved, update this script so the state stays interpreted in one place.',
    })
  } else {
    const code = fs.readFileSync(policy, 'utf8')
    for (const fn of ['modeMayWrite', 'modeMayRead', 'evictionPolicyForMode', 'legacyModeOf']) {
      if (!code.includes(`export function ${fn}`)) {
        problems.push({
          where: 'packages/types/src/interfaces/storage-location-mode.ts',
          what: `no longer exports \`${fn}\``,
          fix: 'The policy answers three questions and folds the legacy pair. Restore it, or update this script.',
        })
      }
    }
  }

  if (problems.length > 0) {
    console.error('\n❌ storage location-mode guard failed:\n')
    for (const p of problems) {
      console.error(`  ${p.where}`)
      console.error(`    ${p.what}`)
      console.error(`    → ${p.fix}\n`)
    }
    process.exit(1)
  }

  console.log(
    `✅ storage location-mode guard: ${files.length.toString()} files scanned, ` +
      'the state is interpreted only in `storage-location-mode.ts`',
  )
}

main()
