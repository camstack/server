/**
 * Bundle → committed case (D681, spec §5.3). A case is refused when it cannot
 * be a fair test or must not sit in a public repo: a gap (`incomplete`), no
 * review (`unreviewed`), a hub-side face hash (`pseudonym`), labels that
 * contradict themselves (`contradiction`), nothing to assert (`no-labels`), a
 * bad slug. A written case loads back unchanged and is listed.
 *
 * Disarm: delete the pseudonym check in `caseFromBundle` — "refuses a hub-side
 * face hash" must fail.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BundleParts } from '../../bundle.js'
import { SCENARIO_SLUG } from '../../recorder/tape-promotion.js'
import { buildSyntheticScenario } from '../../synthetic.js'
import type { Tape } from '../../tape-codec.js'
import type { TapeBodyRecord, TapeDetection, TapeFrame } from '../../tape-schema.js'
import {
  CASE_SLUG,
  type CaseContent,
  CaseExistsError,
  type CaseFromBundleOptions,
  caseFromBundle,
  listCaseDirs,
  loadCaseFixture,
  withStatus,
  writeCaseFixture,
} from '../case-fixture.js'

const OPTIONS: CaseFromBundleOptions = {
  slug: 'synthetic-case',
  plane: 'pipeline',
  importedDate: '2026-09-30',
}

/**
 * The live track bound to a given subject, in the first frame where the tape
 * says enough to tell. `dets[].id` is a per-frame ORDINAL (Task 19 fix round
 * 1, H2) — the synthetic scene's original ids (`P1-0`, `C-0`, …) never reach
 * a tape — so this resolves by what a tape DOES keep verbatim: `cls`
 * ('vehicle' is unambiguous; between the two 'person' detections, P1 always
 * starts left of P2 — the synthetic scene's own geometry, `synthetic.ts`). A
 * track only enters `live[]` once CONFIRMED (past `minHits`), so this reads
 * every frame in order rather than assuming the very first one already
 * carries a binding.
 */
function candidatesAt(
  f: TapeFrame,
): readonly { readonly trk: string; readonly det: TapeDetection }[] {
  const detById = new Map(f.dets.map((d): [string, TapeDetection] => [d.id, d]))
  return f.live.flatMap((l) => {
    const d = l.det === undefined ? undefined : detById.get(l.det)
    return d === undefined ? [] : [{ trk: l.trk, det: d }]
  })
}

function trackOf(tape: Tape, subject: 'P1' | 'P2' | 'C'): string {
  const frames = tape.body.filter((r): r is TapeFrame => r.kind === 'frame')
  if (subject === 'C') {
    for (const f of frames) {
      const c = candidatesAt(f).find((c) => c.det.cls === 'vehicle')
      if (c !== undefined) return c.trk
    }
    throw new Error('no vehicle track bound anywhere in the tape')
  }
  for (const f of frames) {
    const people = candidatesAt(f)
      .filter((c) => c.det.cls === 'person')
      .sort((a, b) => a.det.b[0] - b.det.b[0])
    // Require BOTH bound in the SAME frame (fix round 1, L4): P1 and P2 cross
    // paths, so a frame binding only one of them says nothing about which one
    // it is — `people[0]` there would return whichever person is present.
    if (people.length < 2) continue
    const person = people[subject === 'P1' ? 0 : 1]
    if (person !== undefined) return person.trk
  }
  throw new Error(`no ${subject} track bound anywhere in the tape`)
}

/** The synthetic scene with ONE label that always exists: the two people are
 *  different subjects (the scene's own truth may have no relation at all). */
function parts(
  over: { reviewed?: boolean; body?: readonly TapeBodyRecord[]; gaps?: number } = {},
): BundleParts {
  const { tape } = buildSyntheticScenario()
  const reviewed = over.reviewed ?? true
  return {
    manifest: {
      tapeId: 'promo-0001',
      deviceId: tape.header.deviceId,
      scenario: 'synthetic-case',
      lighting: 'day',
      durationMs: tape.end?.durationMs ?? 0,
      frames: tape.end?.frames ?? 0,
      skips: 0,
      gaps: over.gaps ?? 0,
      reviewed,
      recordedDate: '2026-09-29',
    },
    gt: {
      version: 1,
      reviewed,
      relations: [
        { a: trackOf(tape, 'P1'), b: trackOf(tape, 'P2'), relation: 'different-subjects' },
      ],
      purities: [],
      external: [],
    },
    tape: { ...tape, body: over.body ?? tape.body },
  }
}

let root = ''
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tracking-cases-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('caseFromBundle', () => {
  it('accepts a reviewed, complete, labelled bundle as an open case', () => {
    const r = caseFromBundle(parts(), OPTIONS)
    if (!r.ok) throw new Error(`expected a case, got ${r.code}`)
    expect(r.content.manifest).toMatchObject({
      version: 1,
      slug: 'synthetic-case',
      deviceId: 1,
      plane: 'pipeline',
      lighting: 'day',
      status: 'open',
      recordedDate: '2026-09-29',
      importedDate: '2026-09-30',
    })
    expect(r.content.manifest.frames).toBe(315)
  })

  it('keeps the auto cannot-link the operator outranked, for the CLI to print (fix round 1, M4)', () => {
    const p = parts()
    const a = trackOf(p.tape, 'P1')
    const b = trackOf(p.tape, 'C')
    const body: TapeBodyRecord[] = [
      { kind: 'identity', t: 0, trk: a, fid: 'p1' },
      { kind: 'identity', t: 1, trk: b, fid: 'p2' },
      ...p.tape.body,
    ]
    const withMark: BundleParts = {
      ...p,
      tape: { ...p.tape, body },
      gt: { ...p.gt, relations: [{ a, b, relation: 'same-subject' }] },
    }
    const r = caseFromBundle(withMark, OPTIONS)
    if (!r.ok) throw new Error(`expected a case, got ${r.code}`)
    expect(r.content.gt.suppressedAuto).toEqual([
      { a, b, aFid: 'p1', bFid: 'p2', reason: 'operator-same-subject' },
    ])
  })

  it('refuses an unreviewed bundle', () => {
    expect(caseFromBundle(parts({ reviewed: false }), OPTIONS)).toMatchObject({
      ok: false,
      code: 'unreviewed',
    })
  })

  it('refuses a bundle with a gap', () => {
    const { tape } = buildSyntheticScenario()
    const gap: TapeBodyRecord = { kind: 'gap', fromT: 1_000, toT: 2_000, reason: 'backpressure' }
    expect(caseFromBundle(parts({ body: [gap, ...tape.body], gaps: 1 }), OPTIONS)).toMatchObject({
      ok: false,
      code: 'incomplete',
    })
  })

  it('refuses a hub-side face hash', () => {
    const { tape } = buildSyntheticScenario()
    const body = tape.body.map((r, i) =>
      i === 0 && r.kind === 'frame'
        ? { ...r, dets: r.dets.map((d) => ({ ...d, fid: 'h:0123456789ab' })) }
        : r,
    )
    expect(caseFromBundle(parts({ body }), OPTIONS)).toMatchObject({ ok: false, code: 'pseudonym' })
  })

  it('refuses a hub-side face hash on an identity record (fix round 1, M3)', () => {
    const { tape } = buildSyntheticScenario()
    const body: TapeBodyRecord[] = [
      { kind: 'identity', t: 0, trk: 'live1', fid: 'h:0123456789ab' },
      ...tape.body,
    ]
    expect(caseFromBundle(parts({ body }), OPTIONS)).toMatchObject({ ok: false, code: 'pseudonym' })
  })

  it('refuses contradicting labels, naming the chain', () => {
    const p = parts()
    const [first] = p.gt.relations
    if (first === undefined) throw new Error('parts() carries one relation')
    const contradicted: BundleParts = {
      ...p,
      gt: {
        ...p.gt,
        relations: [...p.gt.relations, { a: first.a, b: first.b, relation: 'same-subject' }],
      },
    }
    const r = caseFromBundle(contradicted, OPTIONS)
    expect(r).toMatchObject({ ok: false, code: 'contradiction' })
    if (!r.ok) expect(r.detail).toContain(`${first.a} → ${first.b}`)
  })

  it('refuses a case with nothing to assert', () => {
    const p = parts()
    expect(caseFromBundle({ ...p, gt: { ...p.gt, relations: [] } }, OPTIONS)).toMatchObject({
      ok: false,
      code: 'no-labels',
    })
  })

  it('refuses a case whose only relation touches a not-a-subject track (fix round 1, H2)', () => {
    const p = parts()
    const [first] = p.gt.relations
    if (first === undefined) throw new Error('parts() carries one relation')
    const unjudgeable: BundleParts = {
      ...p,
      gt: { ...p.gt, purities: [{ trk: first.a, purity: 'not-a-subject' }] },
    }
    expect(caseFromBundle(unjudgeable, OPTIONS)).toMatchObject({ ok: false, code: 'no-labels' })
  })

  it('refuses a label no detection was ever bound to, naming the piece (fix round 1, M1)', () => {
    const p = parts()
    const a = trackOf(p.tape, 'P1')
    const ghost: BundleParts = {
      ...p,
      gt: { ...p.gt, relations: [{ a, b: 'ghost-track', relation: 'different-subjects' }] },
    }
    const r = caseFromBundle(ghost, OPTIONS)
    expect(r).toMatchObject({ ok: false, code: 'incomplete' })
    if (!r.ok) expect(r.detail).toContain('ghost-track')
  })

  it('refuses a bad slug, with the same rule promotion uses', () => {
    expect(caseFromBundle(parts(), { ...OPTIONS, slug: 'Bad Slug' })).toMatchObject({
      ok: false,
      code: 'invalid-slug',
    })
    expect(CASE_SLUG.source).toBe(SCENARIO_SLUG.source)
  })
})

describe('writeCaseFixture / loadCaseFixture / listCaseDirs', () => {
  it('writes, lists and loads a case unchanged', async () => {
    const r = caseFromBundle(parts(), OPTIONS)
    if (!r.ok) throw new Error('expected a case')
    const held = withStatus(r.content, 'held')
    const dir = await writeCaseFixture(root, held)
    expect(listCaseDirs(root)).toEqual([dir])
    const loaded = await loadCaseFixture(dir)
    expect(loaded.manifest).toEqual(held.manifest)
    expect(loaded.gt).toEqual(held.gt)
    expect(loaded.tape).toEqual(held.tape)
  })

  it('never overwrites a committed case', async () => {
    const r = caseFromBundle(parts(), OPTIONS)
    if (!r.ok) throw new Error('expected a case')
    await writeCaseFixture(root, r.content)
    await expect(writeCaseFixture(root, r.content)).rejects.toBeInstanceOf(CaseExistsError)
  })

  it('lists nothing when the cases directory does not exist', () => {
    expect(listCaseDirs(path.join(root, 'absent'))).toEqual([])
  })

  it('refuses an unparsed slug before touching the filesystem (fix round 1, L5)', async () => {
    const r = caseFromBundle(parts(), OPTIONS)
    if (!r.ok) throw new Error('expected a case')
    const traversal: CaseContent = {
      ...r.content,
      manifest: { ...r.content.manifest, slug: '../escape' },
    }
    await expect(writeCaseFixture(root, traversal)).rejects.toThrow()
    expect(existsSync(path.join(path.dirname(root), 'escape'))).toBe(false)
  })

  it('leaves no half-written directory when a write fails, so a retry can proceed (fix round 1, L5)', async () => {
    const r = caseFromBundle(parts(), OPTIONS)
    if (!r.ok) throw new Error('expected a case')
    const [firstFrame, ...restFrames] = r.content.tape.body
    if (firstFrame === undefined || firstFrame.kind !== 'frame')
      throw new Error('expected the tape to start with a frame')
    // A field that throws on read blows up mid-`encodeTapeGzip`, AFTER the
    // staging directory is already created — exactly the partial-write this
    // fix protects against.
    const boobyTrapped: TapeFrame = Object.defineProperty({ ...firstFrame }, 't', {
      enumerable: true,
      get(): number {
        throw new Error('boom: simulated write failure')
      },
    })
    const brokenTape: Tape = { ...r.content.tape, body: [boobyTrapped, ...restFrames] }
    await expect(writeCaseFixture(root, { ...r.content, tape: brokenTape })).rejects.toThrow('boom')
    const dir = path.join(root, r.content.manifest.slug)
    expect(existsSync(dir)).toBe(false)
    expect(listCaseDirs(root)).toEqual([])
    const retried = await writeCaseFixture(root, r.content)
    expect(retried).toBe(dir)
  })
})
