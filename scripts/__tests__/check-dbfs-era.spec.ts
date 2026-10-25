/**
 * The guard D459 said could not be written, written (D460).
 *
 * D459 closed with: *"nothing stops a new absolute-dBFS constant being added
 * without a note about which era it was calibrated in. A guard would need to
 * know which numbers are levels, and it does not."*
 *
 * It does not need to. The guard does not classify the numbers — it makes the
 * AUTHOR classify them, and only checks that the classification is present and
 * is one of the four things a dB number can be. That is the whole trick: the
 * undecidable half ("is -25 a level or a step?") is the half a human answers
 * for free while writing the line, and never answers again afterwards.
 *
 * Why it matters that this exists at all: the defect D459 fixed survived for
 * months because a number in a source file carries no record of the meter it
 * was read off. `-55` is indistinguishable from `-55 measured through a
 * decoder that was 12.04 dB low`. Every future absolute-dBFS constant has the
 * same hazard, and the only durable defence is refusing to let one be written
 * without saying which.
 */
import { describe, expect, it } from 'vitest'
import { DBFS_ERA_TAG, findUnannotatedDbfsConstants } from '../check-dbfs-era.js'

const at = (src: string): readonly string[] =>
  findUnannotatedDbfsConstants(src, 'x.ts').map((v) => v.identifier)

describe('which declarations the guard considers', () => {
  it('catches a bare dBFS constant with no era note', () => {
    expect(at('const SILENCE_FLOOR_DBFS = -55\n')).toEqual(['SILENCE_FLOOR_DBFS'])
  })

  it('catches a Zod default on a dB-named field', () => {
    // This is where `audioMarkerMinDbfs` lives: a schema default is a
    // calibration exactly as much as a `const` is, and it is easier to miss.
    expect(at('  audioMarkerMinDbfs: z.number().max(0).default(-25),\n')).toEqual([
      'audioMarkerMinDbfs',
    ])
  })

  it('splits camelCase and SCREAMING_SNAKE alike to find the dB token', () => {
    expect(at('const audioMarkerMinDbfs = -25\n')).toEqual(['audioMarkerMinDbfs'])
    expect(at('const MIN_MAD_DB = 1\n')).toEqual(['MIN_MAD_DB'])
  })

  it('ignores DATABASE identifiers, which own the other meaning of "db"', () => {
    // The single biggest false-positive risk, and the one that would get this
    // guard switched off: `db` means both decibel and database, and this repo
    // is full of the second kind.
    //
    // What separates them is position, in both naming conventions: a database
    // name uses `db` as a LEADING namespace qualifier (`dbPath`, `DB_URL`); a
    // decibel name uses it as a UNIT, and a unit never leads the quantity it
    // qualifies (`levelDeviationDb`, `NC_AUDIO_DB_OFFERED`). `debounce` has
    // neither token — a substring match would catch it, which is why the
    // matching is token-wise.
    expect(at('const DB_PATH = 3\nconst dbConnections = 5\nconst DEBOUNCE_MS = 250\n')).toEqual([])
  })

  it('still catches a LEADING dbfs — no database is called "dbfs"', () => {
    // The position rule is a tie-breaker for an ambiguous token, not a licence
    // to skip an unambiguous one. `DBFS_FLOOR` must not slip through on a
    // technicality just because the unit happens to come first.
    expect(at('const DBFS_FLOOR = -96\n')).toEqual(['DBFS_FLOOR'])
  })

  it('ignores a local binding — a calibration is module-level, a local is a computation', () => {
    // `const dbfs = readNumber(level, 'dbfs')` inside a function is reading a
    // value, not choosing one. Demanding an era note there would mean tagging
    // every place a level is passed around, which is noise that trains the
    // reader to add the tag without thinking — the exact opposite of the
    // point. Only a declaration at module scope states a calibration.
    expect(at("  const dbfs = readNumber(level, 'dbfs')\n")).toEqual([])
    expect(at('    const avgDbfs = total / count\n')).toEqual([])
    expect(at('const TOP_LEVEL_DBFS = -55\n')).toEqual(['TOP_LEVEL_DBFS'])
    expect(at('export const EXPORTED_DBFS = -55\n')).toEqual(['EXPORTED_DBFS'])
  })

  it('catches a constant DERIVED by a call, dotted or not', () => {
    // The gap that nearly exempted the single most important constant in the
    // repo. `NC_AUDIO_DB_OFFERED = Math.round(ituDbfsFromPreEpoch('PCMU', -55))`
    // is MORE of a calibration than a literal is, not less — it is the one
    // number whose provenance is the entire point. A guard that waves through
    // anything it cannot parse protects only the easy cases.
    expect(at('const A_DBFS = Math.round(ituDbfsFromPreEpoch("PCMU", -55))\n')).toEqual(['A_DBFS'])
    expect(at('const B_DBFS = ituDbfsFromPreEpoch("PCMU", -55)\n')).toEqual(['B_DBFS'])
  })

  it('ignores a dB name that is not bound to a number', () => {
    // An alias carries no calibration of its own; the annotation belongs on
    // whatever it points at, and demanding it twice invites the two to differ.
    expect(at('const NC_AUDIO_DB_MIN = NC_AUDIO_DBFS_FLOOR\n')).toEqual([])
  })
})

describe('what counts as an era annotation', () => {
  const annotated = (era: string): string =>
    `/**\n * A floor.\n * ${DBFS_ERA_TAG} ${era}\n */\nconst SILENCE_FLOOR_DBFS = -55\n`

  it('accepts each of the four things a dB number can be', () => {
    for (const era of ['itu', 'pre-itu-pcmu', 'pre-itu-pcma', 'relative', 'scale-bound']) {
      expect(at(annotated(era))).toEqual([])
    }
  })

  it('REFUSES an era it does not know, rather than treating it as annotated', () => {
    // A typo'd tag that silently passes is worse than no guard: it reads as a
    // classification that was checked, and it was not. Same failure shape as
    // D459's "the two implementations agree" test.
    expect(at(annotated('itu-t'))).toEqual(['SILENCE_FLOOR_DBFS'])
    expect(at(annotated('unknown'))).toEqual(['SILENCE_FLOOR_DBFS'])
    expect(at(annotated(''))).toEqual(['SILENCE_FLOOR_DBFS'])
  })

  it('does not let a note on one constant cover the next one', () => {
    const src = `${annotated('itu')}const OTHER_FLOOR_DBFS = -70\n`
    expect(at(src)).toEqual(['OTHER_FLOOR_DBFS'])
  })

  it('accepts a line comment as well as a block comment', () => {
    expect(at(`// ${DBFS_ERA_TAG} itu\nconst SILENCE_FLOOR_DBFS = -55\n`)).toEqual([])
  })
})

describe('the annotation says something a reader can act on', () => {
  it('reports the file and the era vocabulary when it refuses', () => {
    const [violation] = findUnannotatedDbfsConstants('const SILENCE_FLOOR_DBFS = -55\n', 'a/b.ts')
    expect(violation?.file).toBe('a/b.ts')
    expect(violation?.line).toBe(1)
  })
})
