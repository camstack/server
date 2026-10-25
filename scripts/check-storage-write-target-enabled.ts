#!/usr/bin/env tsx
/**
 * Write-target guard — `StorageLocation.enabled` is honoured by everything that
 * CHOOSES where to write.
 *
 * ## The bug class this prevents
 *
 * `enabled` is the operator's write switch on the Storage screen. The recorder's
 * placement pool honoured it and the event-media pick honoured it; the backup
 * fan-out did not, because it had grown a SECOND enabled flag of its own
 * (`backup_destination_policies.enabled`, seeded `true` for every newly-seen
 * location). A location the operator had switched off kept receiving nightly
 * archives, and the storage screen kept saying it was off — the exact
 * two-switch shape D62 forbids, re-grown in a second package.
 *
 * Nothing catches that in review: each consumer looks correct in isolation, and
 * the one that is wrong is wrong by OMISSION. So it gets a check.
 *
 * ## What this enforces
 *
 * 1. **Every file that enumerates storage locations declares its intent.** A
 *    non-test source file that calls `storage.listLocations` (or the
 *    orchestrator service's own `listLocations`) must either contain one of the
 *    sanctioned {@link HONOURS} idioms, or be listed in {@link READ_ONLY_LISTERS}
 *    with the reason it never picks a write target. Adding a new chooser is
 *    then a conscious act: honour the flag, or say in one line why you do not.
 *
 * 2. **The default cannot come back.** `isDefault`, `getDefaultLocation` and
 *    `setDefaultLocations` were DELETED (D383): enabled is the write set, all
 *    enabled locations of a class are written to together, and a second
 *    authority layered over the pool is the exact shape that had three cameras
 *    writing to a disk a migration was emptying. Three files may still name
 *    `isDefault` — the schema that declares the retired key, the store that
 *    reads the retired column, and the boot migration that consumes it — and
 *    they are listed in {@link LEGACY_DEFAULT_READERS}. Anything else is a
 *    reintroduction.
 *
 * 3. **The three write-target pickers still filter.** Named function, named
 *    file, named idiom. This is the tripwire for the exact lines that were
 *    disarmed to prove the specs: deleting a filter turns this red as well as
 *    a test, which is what stops a "harmless simplification" from shipping.
 *
 * ## What it deliberately does NOT enforce
 *
 * Reads, prunes, evictions and drains must be unaffected by `enabled` — that
 * asymmetry IS the model (a retiring disk keeps serving and keeps shrinking).
 * So this guard never demands the flag be consulted; it demands that a file
 * enumerating locations has DECIDED, one way or the other, on the record.
 *
 * Usage: npx tsx scripts/check-storage-write-target-enabled.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')

/** Directories scanned for source. */
const SOURCE_ROOTS: readonly string[] = ['packages', 'server/backend/src', 'apps']

/**
 * A call that enumerates storage locations.
 *
 * Receiver-qualified on purpose: `deviceManager.listLocations` is a completely
 * unrelated cap (geographic device locations) and matching it would fire on
 * three provider addons that have nothing to do with storage.
 */
const LISTS_LOCATIONS = /\b(?:storage|locations|service|svc)\.listLocations\b/

/** The deleted default's API surface. Any occurrence is a reintroduction. */
const DELETED_DEFAULT_API = /\bgetDefaultLocation\b|\bsetDefaultLocations\b/

/** The deleted default's FIELD, looked for only in files that deal with storage
 *  locations — `isDefault` is also an unrelated adoption-filter and viewer-
 *  endpoint flag, and this guard has no business touching those. */
const STORAGE_DEFAULT_FIELD = /\bisDefault\b/
const MENTIONS_STORAGE_LOCATION = /\bStorageLocation\b|\bstorage_locations\b/

/**
 * Sanctioned ways of consulting the write switch.
 *
 * Since D385 the FIRST-CLASS idiom is the policy module —
 * `mayWriteToLocation` / `locationMayBeWritten` — which resolves the location's
 * `mode` and folds the legacy `enabled` / `config.readOnly` pair for a row that
 * predates the stamp. The older spellings stay listed because the legacy mirror
 * survives one release; they match the three-valued semantics (`true`, `false`,
 * or ABSENT-meaning-active), so the honest test is against `false` and never
 * `=== true`. A file that reads the state some other way adds its idiom here —
 * consciously.
 */
const HONOURS =
  /\benabled\s*(?:!==|===)\s*false\b|\blocationEnabled\b|\.enabled\s*&&|\bmayWriteToLocation\b|\blocationMayBeWritten\b|\bisLocationEnabled\b|\bresolveLocationMode\b/

/**
 * Files that enumerate locations and never pick a write target, each with the
 * reason. A file leaves this list the day it starts choosing.
 */
const READ_ONLY_LISTERS: ReadonlyArray<{ readonly file: string; readonly why: string }> = [
  {
    file: 'packages/system/src/builtins/storage-orchestrator/storage-orchestrator.addon.ts',
    why: 'the cap READ surface plus the pressure/eviction inputs (minFreePercent, maxUsedGb, basePath) — a disabled location must keep being evicted and swept, so filtering here would be the bug, not the fix',
  },
  {
    file: 'packages/addon-admin-ui/src/components/storage/EditLocationModal.tsx',
    why: 'the edit form lists siblings to render the picker; it writes no bytes',
  },
  {
    file: 'packages/system/src/builtins/liveness-monitor/liveness-monitor.addon.ts',
    why: 'probes whether this process can write each storage ROOT and reports it; it writes no bytes and picks no target. Which roots it judges is decided in `storage-root-access.ts` (`storageRootTargets`, through `mayWriteToLocation`)',
  },
]

/**
 * The three files allowed to name the RETIRED `isDefault`, and why.
 *
 * A key removed from a non-strict `z.object` is stripped in silence (D380,
 * D381), so the retired one is declared and migrated deliberately instead of
 * deleted and hoped about. That deliberate path is exactly these three files.
 */
const LEGACY_DEFAULT_READERS: ReadonlyArray<{ readonly file: string; readonly why: string }> = [
  {
    file: 'packages/types/src/interfaces/storage-location.ts',
    why: 'declares the retired key (`LegacyStorageLocationDefaultSchema`) so the migration can read it explicitly',
  },
  {
    file: 'packages/system/src/builtins/storage-orchestrator/location-store.ts',
    why: 'reads the dead `is_default` column off disk, through that schema, and hands it to the migration',
  },
  {
    file: 'packages/system/src/builtins/storage-orchestrator/storage-orchestrator.service.ts',
    why: 'the one-time boot migration onto the enabled write set',
  },
]

/**
 * The write-target pickers, each with the filter EXPRESSION that must survive.
 *
 * One entry per consumer that balances across several locations of a class.
 * The needle is the whole `.filter(...)` call and not just the flag name,
 * because every one of these files names the flag twice — once to select the
 * writable set and once to report what it dropped, and a needle that matched
 * either would have waved through the deletion of the first. (Checked: with a
 * bare `c.locationEnabled` needle this guard stayed green after
 * `selectBackupTargets` stopped filtering.)
 *
 * The cost is sensitivity to reformatting. That is the right direction: a
 * reformat fails this guard loudly and costs one line here, while a looser
 * needle fails silently and costs the operator an archive on a retired disk.
 */
const PICKERS: ReadonlyArray<{
  readonly file: string
  readonly fn: string
  readonly needle: string
}> = [
  {
    file: 'packages/addon-pipeline/src/recorder/addon/roots.ts',
    fn: 'placementPool',
    needle: 'locations.filter((l) => locationMayBeWritten(l))',
  },
  {
    file: 'packages/addon-post-analysis/src/pipeline-analytics/media-locations.ts',
    fn: 'pickWritableMediaLocation',
    needle: 'locations.filter((l) => mayWriteToLocation({ mode: l.mode, config: {} }))',
  },
  {
    file: 'packages/system/src/builtins/backup-orchestrator/write-targets.ts',
    fn: 'selectBackupTargets',
    needle: 'pool.filter((c) => c.locationEnabled)',
  },
]

interface Problem {
  readonly where: string
  readonly what: string
  readonly fix: string
}

/** Strip block and line comments so a docblock MENTION never counts as a call
 *  — three files reference `storage.listLocations` only in prose. */
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
        entry.name === '__tests__' ||
        entry.name === 'camstack-data' ||
        entry.name === '.claude'
      ) {
        continue
      }
      sourceFiles(full, out)
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    if (/\.spec\.tsx?$|\.test\.tsx?$/.test(entry.name)) continue
    // Codegen output (`generated-cap-routers.ts`, `system-proxy.ts`, …) is a
    // mechanical mirror of the cap declarations — the decision it reflects is
    // made in the `*.cap.ts`, which IS scanned.
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

  const listerAllowed = new Set(READ_ONLY_LISTERS.map((e) => e.file))
  const legacyAllowed = new Set(LEGACY_DEFAULT_READERS.map((e) => e.file))
  const problems: Problem[] = []

  for (const file of files) {
    const rel = relative(file)
    const code = stripComments(fs.readFileSync(file, 'utf8'))

    if (LISTS_LOCATIONS.test(code) && !HONOURS.test(code) && !listerAllowed.has(rel)) {
      problems.push({
        where: rel,
        what: 'enumerates storage locations but never consults `StorageLocation.enabled`',
        fix:
          'If this picks a WRITE target, filter on `enabled !== false` (absent means active — never `=== true`). ' +
          'If it only reads, prunes, evicts or drains, add it to READ_ONLY_LISTERS in this script with the reason.',
      })
    }

    if (DELETED_DEFAULT_API.test(code)) {
      problems.push({
        where: rel,
        what: 'names the DELETED storage default API (`getDefaultLocation` / `setDefaultLocations`)',
        fix:
          'The default was deleted (D383): enabled is the write set. Ask `writeTargets(type)` for the pool, ' +
          'pass a concrete location id, or use `setWriteTargets` for a cutover.',
      })
    }

    if (
      STORAGE_DEFAULT_FIELD.test(code) &&
      MENTIONS_STORAGE_LOCATION.test(code) &&
      !legacyAllowed.has(rel)
    ) {
      problems.push({
        where: rel,
        what: 'names `isDefault` on a storage location — the flag was deleted (D383)',
        fix:
          'A storage type has a POOL, not a default: every enabled location of it is written to. ' +
          'Read `enabled` (absent means active), or, if this is the retired-key migration path, ' +
          'add the file to LEGACY_DEFAULT_READERS with the reason.',
      })
    }
  }

  for (const picker of PICKERS) {
    const full = path.join(ROOT, picker.file)
    if (!fs.existsSync(full)) {
      problems.push({
        where: picker.file,
        what: `write-target picker file is missing (expected \`${picker.fn}\`)`,
        fix: 'If the picker moved, update PICKERS in this script so the filter stays pinned somewhere.',
      })
      continue
    }
    const code = stripComments(fs.readFileSync(full, 'utf8'))
    if (!code.includes(picker.fn)) {
      problems.push({
        where: picker.file,
        what: `\`${picker.fn}\` is gone`,
        fix: 'Update PICKERS in this script to name whatever chooses the write target now.',
      })
      continue
    }
    if (!code.includes(picker.needle)) {
      problems.push({
        where: `${picker.file} → ${picker.fn}`,
        what: `no longer filters on the operator flag (expected \`${picker.needle}\`)`,
        fix: 'Restore the filter. A location the operator disabled must never be CHOSEN as a write target — reads, prunes, evictions and drains stay unaffected.',
      })
    }
  }

  if (problems.length > 0) {
    console.error('\n❌ storage write-target guard failed:\n')
    for (const p of problems) {
      console.error(`  ${p.where}`)
      console.error(`    ${p.what}`)
      console.error(`    → ${p.fix}\n`)
    }
    process.exit(1)
  }

  console.log(
    `✅ storage write-target guard: ${files.length.toString()} files scanned, ` +
      `${PICKERS.length.toString()} pickers still filter on \`enabled\`, ` +
      `no storage default reintroduced`,
  )
}

main()
