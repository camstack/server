/**
 * Hour-ledger guard — the durable hour row accounts for HOW MUCH an hour holds
 * and names no file (D523).
 *
 * Lived in `scripts/check-hour-ledger-names-no-file.ts` until 2026-09-20; it
 * reads only this package, so it runs as this package's test (D548) — which
 * means `nx affected -t test` runs it exactly when the recorder changes, and
 * the nightly runs it always.
 *
 * ## The failure this catches
 *
 * `recorder:segment-hours` used to carry a `paths` column: the location-
 * relative name of every segment of the hour. It was written write-behind on
 * every FINALIZED segment, so a writer torn down mid-hour left a row missing
 * the segments the dead process had produced. The rollover then SEALED that
 * short row, `hydrateWindowFromStorage` seeded `RecordingIndex` from it,
 * `hourSegmentsFromIndex` answered non-null — which means COMPLETE — and
 * nothing listed that hour directory again for the life of the footage.
 *
 * Camera 101 lost two hours off the timeline on 2026-09-17 with all 355 and 358
 * files still on the disk. D521 gated the seal; D523 removed the column,
 * because a directory cannot be SHORT about itself. This guard is what makes
 * bringing the column back a decision instead of a convenience.
 *
 * ## What it checks
 *
 * 1. The persisted column list does not declare `paths` (or anything whose
 *    name says it holds file names).
 * 2. `SegmentHourRow` declares no `paths` / `pathsResident` field.
 * 3. Nothing under `recorder/` outside the tests reads a hour-row path list —
 *    `hourPaths(`, `.pathsResident`, `detailForWindow(`.
 * 4. The window hydrate still LISTS: `hydrateWindowFromStorage` must call
 *    `fs.readdir`.
 */
import fs from 'node:fs'
import path from 'node:path'

export const LEDGER_FILE = 'src/recorder/addon/segment-hour-ledger.ts'
export const ROOTS_FILE = 'src/recorder/addon/roots.ts'
const RECORDER_DIR = 'src/recorder'

/** Column names that would put file names back in the table. */
const FORBIDDEN_COLUMNS: readonly string[] = ['paths', 'segmentPaths', 'files', 'fileNames']

/** Call shapes that would hand a caller an hour row's file list. */
const FORBIDDEN_READS: readonly { readonly needle: string; readonly why: string }[] = [
  {
    needle: 'hourPaths(',
    why: 'the durable row names no file — list the hour directory instead (D523)',
  },
  {
    needle: 'pathsResident',
    why: 'the D287 two-tier mirror is gone with the column it existed to keep out of boot',
  },
  {
    needle: 'detailForWindow(',
    why: 'a window hydrate lists the array; it is never served a path list by the ledger',
  },
]

export interface RecorderSource {
  /** Package-relative path, forward slashes. */
  readonly rel: string
  readonly text: string
}

export interface HourLedgerInput {
  readonly ledger: string
  readonly roots: string
  /** Every non-test `.ts` under `src/recorder`. */
  readonly sources: readonly RecorderSource[]
}

/** The pure judgement: every failure, as the sentence a reader needs. */
export function hourLedgerFailures(input: HourLedgerInput): readonly string[] {
  const failures: string[] = []

  // ── 1. the persisted column list ───────────────────────────────────────
  const columnsBlock = /RECORDING_SEGMENT_HOURS_COLUMNS\s*=\s*\[([\s\S]*?)\] as const/.exec(
    input.ledger,
  )
  if (columnsBlock === null) {
    failures.push(
      `${LEDGER_FILE} — RECORDING_SEGMENT_HOURS_COLUMNS is not where this guard can read it. ` +
        'Either it moved (fix the guard) or the ledger stopped declaring its own schema (worse).',
    )
  } else {
    for (const name of FORBIDDEN_COLUMNS) {
      if (new RegExp(`name:\\s*'${name}'`).test(columnsBlock[1] ?? '')) {
        failures.push(
          `${LEDGER_FILE} — the hour row declares a \`${name}\` column. The table accounts for HOW ` +
            'MUCH an hour holds; the DIRECTORY is the authority for WHICH segments it holds (D523). ' +
            'A column of file names is written write-behind per finalize and is therefore short by ' +
            'whatever a torn-down writer never persisted — which is how camera 101 lost two hours ' +
            'of intact footage off the timeline.',
        )
      }
    }
  }

  // ── 2. the row type ────────────────────────────────────────────────────
  const rowBlock = /export interface SegmentHourRow \{([\s\S]*?)\n\}/.exec(input.ledger)
  if (rowBlock === null) {
    failures.push(`${LEDGER_FILE} — SegmentHourRow is not where this guard can read it.`)
  } else {
    for (const field of ['paths', 'pathsResident']) {
      if (new RegExp(`readonly ${field}\\s*[?:]`).test(rowBlock[1] ?? '')) {
        failures.push(
          `${LEDGER_FILE} — SegmentHourRow declares \`${field}\`. See D523: the row is ten scalars, ` +
            'and every caller that needs segment NAMES lists the hour directory.',
        )
      }
    }
  }

  // ── 3. nothing reads a row's path list ─────────────────────────────────
  for (const { rel, text } of input.sources) {
    const lines = text.split('\n')
    for (const { needle, why } of FORBIDDEN_READS) {
      lines.forEach((line, i) => {
        // A doc comment may name the removed surface to say it is gone.
        if (/^\s*(\*|\/\/)/.test(line)) return
        if (!line.includes(needle)) return
        failures.push(`${rel}:${(i + 1).toString()} — \`${needle}\` — ${why}.`)
      })
    }
  }

  // ── 4. the window hydrate still lists ──────────────────────────────────
  const hydrate = /export async function hydrateWindowFromStorage\(([\s\S]*?)\n\}\n/.exec(
    input.roots,
  )
  if (hydrate === null) {
    failures.push(`${ROOTS_FILE} — hydrateWindowFromStorage is not where this guard can read it.`)
  } else if (!hydrate[1]?.includes('fs.readdir(')) {
    failures.push(
      `${ROOTS_FILE} — hydrateWindowFromStorage no longer reads a directory. It is the one thing ` +
        'that can tell what an hour holds (D523); a version of it that answers from anything else ' +
        'is the 2026-09-17 defect, whatever the something else is called.',
    )
  }
  return failures
}

/** Every non-test `.ts` under a directory. */
function recorderSources(packageRoot: string): RecorderSource[] {
  const out: RecorderSource[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') {
          continue
        }
        walk(full)
        continue
      }
      if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
        out.push({
          rel: path.relative(packageRoot, full).split(path.sep).join('/'),
          text: fs.readFileSync(full, 'utf8'),
        })
      }
    }
  }
  walk(path.join(packageRoot, RECORDER_DIR))
  return out
}

/** Judge THIS package as checked out. */
export function evaluateHourLedgerGuard(packageRoot: string): readonly string[] {
  const read = (rel: string): string => fs.readFileSync(path.join(packageRoot, rel), 'utf8')
  return hourLedgerFailures({
    ledger: read(LEDGER_FILE),
    roots: read(ROOTS_FILE),
    sources: recorderSources(packageRoot),
  })
}
