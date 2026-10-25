/**
 * The mover REFUSES a target that is not a write target — uniformly (D385).
 *
 * ## What changed, and why the old rule could not survive
 *
 * Before D385 a location's state lived in two places: `enabled` (the write
 * switch) and the untyped `config.readOnly` key. The mover treated them
 * DIFFERENTLY — a `readOnly` target was a hard refusal, an `enabled: false`
 * ("standby") one was accepted with a warning, on the argument that draining
 * residue onto a big archive disk outside the write set is a legitimate move.
 *
 * The two are one state now (`readonly`), so one of the two answers had to go,
 * and refusing is the one that survives: every non-`active` state means the
 * operator has frozen that disk or is emptying it, and landing footage there
 * fights the relocate mover that is trying to empty it. The supported way to
 * retire a disk onto another one is to make the destination `active` — one
 * click, on the same screen, and the storage screen then agrees with where the
 * bytes went instead of contradicting it.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type IScopedLogger, resolveLocationMode } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { type RecordingsLocation, recordingsLocationOfMode } from '../addon/roots.js'
import { RecordingIndex } from '../recording-index.js'
import { RelocateEngine } from '../relocate-engine.js'

interface LoggedLine {
  readonly level: string
  readonly message: string
  readonly meta: Record<string, unknown>
}

function makeLogger(lines: LoggedLine[]): IScopedLogger {
  const record =
    (level: string) =>
    (message: string, opts?: { meta?: Record<string, unknown> }): void => {
      lines.push({ level, message, meta: opts?.meta ?? {} })
    }
  const logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger as unknown as IScopedLogger
}

function locations(toEnabled: boolean | undefined): readonly RecordingsLocation[] {
  return [
    recordingsLocationOfMode(
      {
        id: 'recordings:old',
        type: 'recordings',
        root: mkdtempSync(path.join(tmpdir(), 'standby-from-')),
      },
      'active',
    ),
    // The target's legacy flag is folded by the ONE interpreter, exactly as an
    // unmigrated persisted row is at `listLocations` time.
    recordingsLocationOfMode(
      {
        id: 'recordings:archive',
        type: 'recordings',
        root: mkdtempSync(path.join(tmpdir(), 'standby-to-')),
      },
      resolveLocationMode(
        toEnabled !== undefined ? { enabled: toEnabled, config: {} } : { config: {} },
      ),
    ),
  ]
}

function makeEngine(lines: LoggedLine[], toEnabled: boolean | undefined): RelocateEngine {
  let n = 0
  return new RelocateEngine({
    index: new RecordingIndex(),
    locations: () => locations(toEnabled),
    logger: makeLogger(lines),
    now: () => 0,
    newId: () => `job-${n++}`,
    sleep: async () => {},
    freePercentOf: async () => 100,
  })
}

describe('relocate onto a target that is not a write target', () => {
  it('REFUSES a disabled (standby) target, naming the mode', () => {
    const lines: LoggedLine[] = []
    const engine = makeEngine(lines, false)

    expect(() =>
      engine.start({
        fromLocationId: 'recordings:old',
        toLocationId: 'recordings:archive',
        footageClass: 'recordings',
      }),
    ).toThrow(/read-only.*recordings:archive|recordings:archive.*read-only/is)
  })

  it('accepts a target in the write set', () => {
    const lines: LoggedLine[] = []
    const engine = makeEngine(lines, true)

    expect(
      engine.start({
        fromLocationId: 'recordings:old',
        toLocationId: 'recordings:archive',
        footageClass: 'recordings',
      }),
    ).toBe('job-0')
  })

  it('accepts a flagless legacy target — absent folds to active', () => {
    const lines: LoggedLine[] = []
    const engine = makeEngine(lines, undefined)

    expect(
      engine.start({
        fromLocationId: 'recordings:old',
        toLocationId: 'recordings:archive',
        footageClass: 'recordings',
      }),
    ).toBe('job-0')
  })
})
