#!/usr/bin/env tsx
/**
 * Orphan-reclaimer guard — **every collection the audit WALKS declares how its
 * rows are deleted.**
 *
 * ## The failure this catches
 *
 * The audit's reclaim was one `if` for media and a raw `settingsStore.delete`
 * for everything else. The raw delete really does delete the row it is asked
 * about, so nothing ever looked wrong — while `FaceStore.delete` is
 * `store.delete` FOLLOWED BY `vectors.drop([faceId])`, and the sweep was doing
 * only the first half. Every face row it collected left an ArcFace vector
 * behind, in an index reachable only by that face's id and walked by no sweep.
 * Measured on the live hub 2026-09-13: 2 568 vectors, 20 MB.
 *
 * The lesson is not about faces. It is that a raw-delete DEFAULT hands the
 * broken path to whatever is added next, silently, and the evidence is bytes in
 * a table nobody thought to measure. So the default is gone, and this keeps it
 * gone.
 *
 * ## What it checks
 *
 * `auditableCollections()` and `RECLAIMED_COLLECTIONS` name the same set, in
 * both directions. A collection the audit walks with no declared reclaimer
 * reclaims NOTHING: the reclaimer throws for each orphaned row, the engine
 * catches it per row (`reclaimFailed`, one WARN, row KEPT) and the sweep goes
 * on — so the orphans accumulate, night after night, behind a WARN per row. A
 * declared reclaimer for a collection nobody audits is a dead branch that
 * reads as coverage.
 */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

import { auditableCollections } from '../packages/addon-post-analysis/src/pipeline-analytics/retention/collection-classification.js'
import { RECLAIMED_COLLECTIONS } from '../packages/addon-post-analysis/src/pipeline-analytics/retention/orphan-reclaimers.js'

const walked = new Set(auditableCollections().map((c) => c.collection))
const declared = new Set(RECLAIMED_COLLECTIONS)
const failures: string[] = []

for (const c of walked) {
  if (!declared.has(c)) {
    failures.push(
      `'${c}' is audited but declares no reclaimer — none of its orphans would ` +
        'ever be reclaimed (each fails per row: reclaimFailed + a WARN, row kept)',
    )
  }
}
for (const c of declared) {
  if (!walked.has(c)) {
    failures.push(`'${c}' declares a reclaimer but no scope walks it — a dead branch`)
  }
}

// The production WIRING of the raw delete. The reclaimer's own spec calls the
// factory directly, so an inline lambda in index.ts could bring back the
// original bug — `settingsStore.delete` (output `z.void()`) read as
// `!== undefined`, every reclaim uncounted and the per-scope ceiling never
// tripping — with every spec green (D695 T7 review M1).
const INDEX = path.resolve(
  import.meta.dirname,
  '../packages/addon-post-analysis/src/pipeline-analytics/index.ts',
)
if (!/\bdeleteRow:\s*settingsRowDeleterOf\(/.test(readFileSync(INDEX, 'utf8'))) {
  failures.push(
    "pipeline-analytics/index.ts does not wire the orphan audit's deleteRow through " +
      'settingsRowDeleterOf — the delete that reports what it deleted',
  )
}

// D694: an object-events rowid can be reused between the orphan probe and the
// delete. The reclaim MUST re-assert the dead track's id; an id-only delete
// would take out the new live holder. The WARN string is the refuse branch.
const RECLAIMERS = path.resolve(
  import.meta.dirname,
  '../packages/addon-post-analysis/src/pipeline-analytics/retention/orphan-reclaimers.ts',
)
const reclaimersSrc = readFileSync(RECLAIMERS, 'utf8')
if (!/object-events reclaim without trackId/.test(reclaimersSrc)) {
  failures.push(
    'orphan-reclaimers.ts no longer refuses an object-events reclaim without trackId — ' +
      'an id-only raw delete races a reused rowid (D694)',
  )
}
if (!/trackId: assert\.trackId/.test(reclaimersSrc)) {
  failures.push(
    'orphan-reclaimers.ts settingsRowDeleter no longer deletes with { id, trackId } — ' +
      'the D694 rowid-reuse race is open again',
  )
}

if (failures.length > 0) {
  console.error('✘ orphan-reclaimer guard failed:')
  for (const f of failures) console.error(`    ${f}`)
  process.exit(1)
}
console.log(
  `✔ ${declared.size} audited collections, each with a declared reclaimer; deleteRow wired through settingsRowDeleterOf`,
)
