/**
 * The CLI end to end on a temporary cases directory:
 *  - `case` writes a case and MEASURES its status through the case tracker
 *    (`held` when honoured, `open` otherwise), refuses what `caseFromBundle`
 *    refuses and never overwrites a committed case;
 *  - `score` prints the metrics of the recorded run and of the case tracker;
 *  - `cases` agrees with cases.spec.ts: a `held` case that is not honoured
 *    exits 1.
 *
 * Disarm: in `cases`, drop the `failed = true` of the held branch — "cases
 * fails a held case the tracker does not honour" must fail.
 *
 * The last three specs cover the Task 22 review carry-overs (task-22-review.md
 * M4 and the fixture-privacy note): the standing reminder not to put names or
 * personal data in `--slug`/`--note`, printing a `suppressedAuto` pair (the
 * recognizer's cannot-link the operator's own mark outranked), and `score`
 * showing the case-label checks next to the metrics.
 *
 * Stale-brief adaptation (same as `cases/__tests__/case-fixture.spec.ts`):
 * `trackOf` resolves a subject by class and left-to-right position, never by
 * the brief's `P1-`/`P2-`/`C-` id prefix — `dets[].id` has been a per-frame
 * ordinal since Task 19 fix round 1 (H2), so that prefix never reaches a tape.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type BundleParts, bundleChunks } from '../bundle.js'
import { type CaseManifest, CaseManifestSchema } from '../cases/case-fixture.js'
import { type CliIo, type CliOptions, runCli } from '../cli.js'
import type { GroundTruthFile } from '../ground-truth.js'
import { buildSyntheticScenario } from '../synthetic.js'
import type { Tape } from '../tape-codec.js'
import type { TapeDetection, TapeFrame } from '../tape-schema.js'
import { RecordedTracker } from '../trackers/recorded-tracker.js'
import { sampleEnd, sampleFrame, sampleHeader } from './tape-fixtures.js'

interface Captured {
  readonly io: CliIo
  readonly out: string[]
  readonly err: string[]
}

function capture(): Captured {
  const out: string[] = []
  const err: string[] = []
  return {
    io: {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      now: () => Date.parse('2026-09-30T08:00:00Z'),
    },
    out,
    err,
  }
}

/**
 * The live track bound to a given subject (D681 fix round 1, L4 — same
 * adaptation as `cases/__tests__/case-fixture.spec.ts`'s `trackOf`):
 * `dets[].id` is a per-frame ORDINAL (Task 19 fix round 1, H2), so the
 * synthetic scene's own ids (`P1-0`, `C-0`, …) never reach a tape. Resolved
 * instead by what a tape DOES keep verbatim — `cls` ('vehicle' is
 * unambiguous; between the two 'person' detections, P1 always starts left of
 * P2, the scene's own geometry) — and only from a frame where BOTH people are
 * bound, since P1 and P2 cross paths and a frame binding only one says
 * nothing about which one it is.
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
    if (people.length < 2) continue
    const person = people[subject === 'P1' ? 0 : 1]
    if (person !== undefined) return person.trk
  }
  throw new Error(`no ${subject} track bound anywhere in the tape`)
}

type Label = 'people-differ' | 'person-is-car'

function bundle(label: Label, reviewed = true): Buffer {
  const { tape } = buildSyntheticScenario()
  const relations: GroundTruthFile['relations'] =
    label === 'people-differ'
      ? [{ a: trackOf(tape, 'P1'), b: trackOf(tape, 'P2'), relation: 'different-subjects' }]
      : [{ a: trackOf(tape, 'P1'), b: trackOf(tape, 'C'), relation: 'same-subject' }]
  const parts: BundleParts = {
    manifest: {
      tapeId: 'promo-0001',
      deviceId: tape.header.deviceId,
      scenario: 'synthetic-crossing',
      lighting: 'day',
      durationMs: tape.end?.durationMs ?? 0,
      frames: tape.end?.frames ?? 0,
      skips: 0,
      gaps: 0,
      reviewed,
      recordedDate: '2026-09-29',
    },
    gt: { version: 1, reviewed, relations, purities: [], external: [] },
    tape,
  }
  return gzipSync([...bundleChunks(parts)].join(''))
}

let dir = ''
let options: CliOptions = { casesDir: '' }
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'tracking-cli-'))
  // The recorded run as the case tracker: deterministic and instant.
  options = { casesDir: path.join(dir, 'cases'), caseTracker: () => new RecordedTracker() }
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function file(label: Label, reviewed = true): Promise<string> {
  const f = path.join(dir, `${label}.tape-bundle.json.gz`)
  await writeFile(f, bundle(label, reviewed))
  return f
}

async function manifestOf(slug: string): Promise<CaseManifest> {
  return CaseManifestSchema.parse(
    JSON.parse(await readFile(path.join(options.casesDir, slug, 'manifest.json'), 'utf8')),
  )
}

/** A minimal hand-built bundle whose marks put A and B same-subject while the
 *  recognizer settled them under different faces, one epoch, no restart gap —
 *  the one shape `deriveTruth` reports as `suppressedAuto` rather than a
 *  refusal (ground-truth.spec.ts covers the derivation itself; this proves
 *  the CLI surfaces it). */
async function suppressedAutoFile(): Promise<string> {
  const tape: Tape = {
    header: sampleHeader({ deviceId: 1 }),
    body: [
      sampleFrame(100, {
        dets: [
          { id: 'a1', k: 'first-level', cls: 'person', s: 0.9, b: [0, 0, 50, 120], src: 'frame' },
        ],
        live: [{ trk: 'A', det: 'a1', m: true, st: 'moving' }],
      }),
      { kind: 'identity', t: 150, trk: 'A', fid: 'p1' },
      sampleFrame(200, {
        dets: [
          { id: 'b1', k: 'first-level', cls: 'person', s: 0.9, b: [0, 0, 50, 120], src: 'frame' },
        ],
        live: [{ trk: 'B', det: 'b1', m: true, st: 'moving' }],
      }),
      { kind: 'identity', t: 250, trk: 'B', fid: 'p2' },
    ],
    end: sampleEnd({ durationMs: 250, frames: 2, reason: 'window-end' }),
  }
  const parts: BundleParts = {
    manifest: {
      tapeId: 'promo-0002',
      deviceId: 1,
      scenario: 'suppressed-auto-demo',
      lighting: 'day',
      durationMs: 250,
      frames: 2,
      skips: 0,
      gaps: 0,
      reviewed: true,
      recordedDate: '2026-09-29',
    },
    gt: {
      version: 1,
      reviewed: true,
      relations: [{ a: 'A', b: 'B', relation: 'same-subject' }],
      purities: [],
      external: [],
    },
    tape,
  }
  const f = path.join(dir, 'suppressed-auto.tape-bundle.json.gz')
  await writeFile(f, gzipSync([...bundleChunks(parts)].join('')))
  return f
}

describe('tracking-bench CLI', () => {
  it('case: writes an honoured case as held', async () => {
    const c = capture()
    expect(
      await runCli(
        [
          'case',
          await file('people-differ'),
          '--slug',
          'people-differ',
          '--note',
          'two walkers cross',
        ],
        c.io,
        options,
      ),
    ).toBe(0)
    expect(await manifestOf('people-differ')).toMatchObject({
      slug: 'people-differ',
      status: 'held',
      note: 'two walkers cross',
      importedDate: '2026-09-30',
    })
    expect(c.out.join('\n')).toContain('held')
  })

  it('case: writes a case the tracker fails as open, printing the violation', async () => {
    const c = capture()
    expect(
      await runCli(['case', await file('person-is-car'), '--slug', 'person-is-car'], c.io, options),
    ).toBe(0)
    expect((await manifestOf('person-is-car')).status).toBe('open')
    expect(c.out.join('\n')).toContain('same subject, split')
  })

  it('case: defaults the slug to the promotion scenario', async () => {
    expect(await runCli(['case', await file('people-differ')], capture().io, options)).toBe(0)
    expect((await manifestOf('synthetic-crossing')).slug).toBe('synthetic-crossing')
  })

  it('case: refuses an unreviewed bundle and an existing slug', async () => {
    const unreviewed = capture()
    expect(
      await runCli(
        ['case', await file('people-differ', false), '--slug', 'unreviewed-one'],
        unreviewed.io,
        options,
      ),
    ).toBe(1)
    expect(unreviewed.err.join('\n')).toContain('unreviewed')
    await runCli(['case', await file('people-differ'), '--slug', 'taken'], capture().io, options)
    const again = capture()
    expect(
      await runCli(['case', await file('people-differ'), '--slug', 'taken'], again.io, options),
    ).toBe(1)
    expect(again.err.join('\n')).toContain('case-exists')
  })

  it('score: prints both trackers’ metrics for a bundle and for a case directory', async () => {
    const onBundle = capture()
    expect(await runCli(['score', await file('people-differ')], onBundle.io, options)).toBe(0)
    const text = onBundle.out.join('\n')
    expect(text).toContain('recorded')
    expect(text).toMatch(/IDF1\s+\d/)
    await runCli(['case', await file('people-differ'), '--slug', 'scored'], capture().io, options)
    const onCase = capture()
    expect(await runCli(['score', path.join(options.casesDir, 'scored')], onCase.io, options)).toBe(
      0,
    )
    expect(onCase.out.join('\n')).toMatch(/HOTA\s+\d/)
  })

  it('cases: passes when every status holds', async () => {
    await runCli(['case', await file('people-differ'), '--slug', 'held-one'], capture().io, options)
    await runCli(['case', await file('person-is-car'), '--slug', 'open-one'], capture().io, options)
    expect(await runCli(['cases'], capture().io, options)).toBe(0)
  })

  it('cases: fails a held case the tracker does not honour', async () => {
    await runCli(['case', await file('person-is-car'), '--slug', 'lying'], capture().io, options)
    const manifest = path.join(options.casesDir, 'lying', 'manifest.json')
    const m = await manifestOf('lying')
    await writeFile(manifest, `${JSON.stringify({ ...m, status: 'held' }, null, 2)}\n`)
    const c = capture()
    expect(await runCli(['cases'], c.io, options)).toBe(1)
    expect(c.err.join('\n')).toContain('lying')
  })

  it('prints usage for an unknown command', async () => {
    const c = capture()
    expect(await runCli(['check'], c.io, options)).toBe(2)
    expect(c.err.join('\n')).toContain('usage')
  })

  it('case: always warns against names or personal data in --slug/--note before writing anything', async () => {
    const c = capture()
    await runCli(['case', await file('people-differ'), '--slug', 'privacy-check'], c.io, options)
    expect(c.err.join('\n')).toContain('personal data')
    // Printed even when the command later refuses.
    const refused = capture()
    await runCli(
      ['case', await file('people-differ', false), '--slug', 'privacy-check-2'],
      refused.io,
      options,
    )
    expect(refused.err.join('\n')).toContain('personal data')
  })

  it('case: prints a suppressedAuto pair — the recognizer disagreed with the operator', async () => {
    const c = capture()
    expect(
      await runCli(
        ['case', await suppressedAutoFile(), '--slug', 'suppressed-demo'],
        c.io,
        options,
      ),
    ).toBe(0)
    const errText = c.err.join('\n')
    expect(errText).toContain('recognizer disagreed with the operator')
    expect(errText).toContain('A (p1)')
    expect(errText).toContain('B (p2)')
  })

  it('score: shows the case-label checks next to the metrics — a case asserts only what was labelled', async () => {
    const onBundle = capture()
    expect(await runCli(['score', await file('people-differ')], onBundle.io, options)).toBe(0)
    expect(onBundle.out.join('\n')).toMatch(/relation\(s\) checked/)

    await runCli(['case', await file('people-differ'), '--slug', 'labelled'], capture().io, options)
    const onCase = capture()
    expect(
      await runCli(['score', path.join(options.casesDir, 'labelled')], onCase.io, options),
    ).toBe(0)
    expect(onCase.out.join('\n')).toMatch(/relation\(s\) checked/)
  })
})
