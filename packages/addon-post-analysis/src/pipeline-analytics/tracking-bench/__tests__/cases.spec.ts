/**
 * Every committed tracking case (D681, spec §5.3): a promoted window of real
 * track history and the operator's labels, replayed through `CASE_TRACKER`.
 * `held` cases must be honoured. `open` cases are the ones the current tracker
 * still fails: they run with `it.fails`, so the suite goes red the day a
 * tracker starts honouring one — and the commit that made it pass flips the
 * case to `held` (plan decision 17). With no case committed, only the first
 * two tests run.
 *
 * The `open` branch asserts the SPECIFIC error `expectCaseHonoured` throws
 * (`CaseNotHonouredError`), not merely "something threw" (fix round 1, L6):
 * `it.fails` otherwise turns a broken fixture, or a tracker that CRASHES,
 * into a silent pass indistinguishable from "the labels are not yet
 * honoured". Any other throw is swallowed here so `it.fails` reports it as
 * a real failure instead of hiding it.
 *
 * Every case ALSO re-checks the pseudonym boundary on load (fix round 1, M3):
 * `caseFromBundle`'s `committedFaceViolation` guards CREATION, but nothing
 * previously re-ran it on a fixture already sitting in the repo — a
 * hand-edited or hand-committed case bypassed it entirely.
 *
 * And every case runs the Task 19 review's carried independence check
 * (`isLiveIndependent`, `testing/live-independence.ts`): whatever tracker
 * `CASE_TRACKER` names, replaying a case's own tape as recorded and perturbed
 * must hash identical, so any tracker dropped into that slot — D683's
 * included — inherits the proof it never reads the old tracker's `live[]`.
 * This runs for every case regardless of `status`: it is a property of the
 * harness and the tracker, not of the labels.
 *
 * Disarm: Step 12 of Task 22 (a scratch case whose labels the processor
 * cannot honour, committed as `held`, fails here).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CaseManifestSchema,
  committedFaceViolation,
  listCaseDirs,
  loadCaseFixture,
} from '../cases/case-fixture.js'
import { CaseNotHonouredError, expectCaseHonoured } from '../testing/replay-case.js'
import { isLiveIndependent } from '../testing/live-independence.js'
import { CASE_TRACKER } from '../trackers/case-tracker.js'

const DIRS = listCaseDirs()

describe('committed tracking cases', () => {
  it('every case directory loads as a valid fixture', async () => {
    for (const dir of DIRS) await expect(loadCaseFixture(dir)).resolves.toMatchObject({ dir })
  })

  it('every case still respects the tape privacy boundary — no hub-side face id (fix round 1, M3)', async () => {
    for (const dir of DIRS) {
      const content = await loadCaseFixture(dir)
      expect(committedFaceViolation(content.tape)).toBeNull()
    }
  })

  for (const dir of DIRS) {
    const manifest = CaseManifestSchema.parse(
      JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')),
    )
    const run = manifest.status === 'held' ? it : it.fails
    const title = `${manifest.slug} (${manifest.status})${manifest.note === undefined ? '' : ` — ${manifest.note}`}`
    run(title, async () => {
      if (manifest.status === 'held') {
        expectCaseHonoured(await loadCaseFixture(dir), CASE_TRACKER)
        return
      }
      let caught: unknown
      try {
        expectCaseHonoured(await loadCaseFixture(dir), CASE_TRACKER)
      } catch (err) {
        caught = err
      }
      // Rethrow ONLY the expected kind, so `it.fails` sees "did not throw" —
      // a real failure — for a broken fixture, a tracker crash, or a case
      // that now unexpectedly passes (fix round 1, L6).
      if (caught instanceof CaseNotHonouredError) throw caught
    })

    it(`${manifest.slug}: independent of live[] beyond identity resolution`, async () => {
      const content = await loadCaseFixture(dir)
      expect(isLiveIndependent(content.tape, content.manifest.plane, CASE_TRACKER)).toBe(true)
    })
  }
})
