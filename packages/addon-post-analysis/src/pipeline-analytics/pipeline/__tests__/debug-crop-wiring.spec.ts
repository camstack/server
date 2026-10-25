/**
 * The DEBUG flag reaches the frame path once per track, and the three decision
 * sites are actually wired to it.
 *
 * The flag is the whole cost story. A camera with no debug-marked track must
 * pay one Map lookup per decision and nothing else — no store read, no frame
 * fetch, no log line. So the flag lives in `TrackResidentState` (which the
 * frame path already touches for every track) and is written exactly once, by
 * the `setTrackFlags` mutation the operator's button calls. It is never read
 * from the track store on the frame path.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TrackResidentState } from '../track-resident-state.js'

describe('the debug flag on the live track', () => {
  it('is false for a track nobody marked — the free case', () => {
    const residents = new TrackResidentState()
    residents.open(101, 'aaa')
    expect(residents.isDebugMarked('aaa')).toBe(false)
    // and for a track that was never opened at all
    expect(residents.isDebugMarked('never-seen')).toBe(false)
  })

  it('is written by the operator mutation and read back on the frame path', () => {
    const residents = new TrackResidentState()
    residents.open(101, 'aaa')
    residents.setDebugMarked(101, 'aaa', true)
    expect(residents.isDebugMarked('aaa')).toBe(true)
    residents.setDebugMarked(101, 'aaa', false)
    expect(residents.isDebugMarked('aaa')).toBe(false)
  })

  it('marks a track the frame path has not opened yet', () => {
    // The operator can press the button on a track whose first frame is still
    // in flight; the mark must survive to the frame that follows it.
    const residents = new TrackResidentState()
    residents.setDebugMarked(101, 'bbb', true)
    expect(residents.isDebugMarked('bbb')).toBe(true)
  })

  it('leaves with the track, like every other resident field', () => {
    const residents = new TrackResidentState()
    residents.setDebugMarked(101, 'ccc', true)
    residents.close('ccc', 'end')
    expect(residents.isDebugMarked('ccc')).toBe(false)
  })
})

const HOST = fs.readFileSync(path.join(__dirname, '..', '..', 'index.ts'), 'utf8')
/** The per-frame media decision moved out of the host (Plan B, extraction 2). */
const SNAPSHOT_TARGETS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'media', 'snapshot-targets.ts'),
  'utf8',
)

/** The per-candidate birth verdict moved out of the host (Plan B, extraction 5). */
const BIRTH_VERDICT = fs.readFileSync(
  path.join(__dirname, '..', '..', 'birth', 'birth-verdict.ts'),
  'utf8',
)

function sliceAfter(needle: string, len: number, source: string = HOST): string {
  const at = source.indexOf(needle)
  expect(at).toBeGreaterThan(0)
  return source.slice(at, at + len)
}

// D683: the third site, the old tracker's growth rescue, went with the
// mechanism — tracker v2 never binds a box it does not overlap (it splits, and
// L2 links the pieces). `DebugCropDecision` dropped `growth-rescue` and
// `reacquire` with it (Task 21); a crop stored under either before D683 reads
// back as an unrecognised decision string, never a crash.
describe('the decision sites are wired', () => {
  it('the operator mutation pushes the flag into the live track', () => {
    const body = sliceAfter('async setTrackFlags(input: {', 2_500)
    expect(body).toContain('setDebugMarked')
  })

  it('best-shot: the promotion attempt offers its comparison', () => {
    const body = sliceAfter(
      'const promotionAttempt: BestShotPromotionAttempt = {',
      3_000,
      SNAPSHOT_TARGETS,
    )
    expect(body).toContain("decision: 'best-shot'")
  })

  it('birth confirmation: only inside the SURVIVING-track branch', () => {
    const body = sliceAfter('if (!suppressionMayRetract(source)) {', 2_500, BIRTH_VERDICT)
    expect(body).toContain("decision: 'birth-confirmation'")
    // and never beside a retracted birth — that row would outlive its owner.
    const retraction = sliceAfter('this.trackStore?.dropActive(id)', 1_200, BIRTH_VERDICT)
    expect(retraction).not.toContain('offerDebugCrop')
  })

  it('stores under the track-owned debugCrop kind, never a kind that means something else', () => {
    const body = sliceAfter('putDebugCrop:', 600)
    expect(body).toContain("kind: 'debugCrop'")
    expect(body).toContain("ownerKind: 'track'")
  })
})
