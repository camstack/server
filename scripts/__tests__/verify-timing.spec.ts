import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  appendTimingRecord,
  buildTimingRecord,
  formatTimingSummary,
  parseVitestSummary,
} from '../ci/verify-timing.mjs'

interface TimingRecord {
  readonly start: string
  readonly end: string
  readonly scope: string
  readonly result: string
  readonly stages: Readonly<Record<string, number>>
  readonly projects: readonly { readonly project: string; readonly seconds: number }[]
}

describe('vitest duration line', () => {
  it('reads the aggregated collect and test seconds from the summary', () => {
    const summary = parseVitestSummary(
      ' \u001b[32mDuration\u001b[0m  287.41s (transform 12.30s, setup 4.10s, collect 609.22s, tests 325.10s, environment 8.20s, prepare 3.10s)',
    )
    expect(summary).toEqual({
      durationSeconds: 287.41,
      transformSeconds: 12.3,
      setupSeconds: 4.1,
      collectSeconds: 609.22,
      testsSeconds: 325.1,
      environmentSeconds: 8.2,
      prepareSeconds: 3.1,
    })
  })

  it('accepts a millisecond total and mixed unit parts', () => {
    expect(
      parseVitestSummary('Duration  850ms (transform 100ms, collect 1.50s, tests 500ms)'),
    ).toEqual({
      durationSeconds: 0.85,
      transformSeconds: 0.1,
      setupSeconds: null,
      collectSeconds: 1.5,
      testsSeconds: 0.5,
      environmentSeconds: null,
      prepareSeconds: null,
    })
  })

  it('returns null when the line is not a duration', () => {
    expect(parseVitestSummary('Tests  1400 passed')).toBeNull()
  })
})

describe('verify timing record', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  function record(): TimingRecord {
    return buildTimingRecord({
      startMs: Date.parse('2026-11-10T11:59:00.000Z'),
      endMs: Date.parse('2026-11-10T12:33:00.000Z'),
      scope: 'ALL',
      base: 'abc123',
      result: 'GREEN',
      cpus: 12,
      stages: [
        ['changelog', 1.2],
        ['build', 40],
        ['tsgo', 156],
        ['tests', 1800],
      ],
      projects: [
        {
          project: '@camstack/addon-admin-ui',
          lane: 'heavy',
          seconds: 328.1,
          exitCode: 0,
          collectSeconds: 400,
          testsSeconds: 200,
        },
      ],
    })
  }

  it('appends one JSON line and prints a stage summary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-timing-'))
    dirs.push(dir)
    const file = join(dir, 'verify-timings.jsonl')
    const written = record()
    appendTimingRecord(file, written)
    appendTimingRecord(file, written)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toMatchObject({
      scope: 'ALL',
      result: 'GREEN',
      cpus: 12,
      stages: { changelog: 1.2, build: 40, tsgo: 156, tests: 1800 },
    })
    const summary = formatTimingSummary(written)
    expect(summary).toContain('2040s')
    expect(summary).toContain('tsgo')
    expect(summary).toContain('156s')
    expect(summary).toContain('@camstack/addon-admin-ui')
    expect(summary).not.toContain(file)
  })

  it('names the timings file in the summary when given', () => {
    const summary = formatTimingSummary(record(), '/tmp/verify-timings.jsonl')
    expect(summary).toContain('/tmp/verify-timings.jsonl')
  })

  it('verify:push records each run in the cache timings file', () => {
    const src = readFileSync('scripts/ci/verify-push.sh', 'utf8')
    expect(src).toContain('verify-timings.jsonl')
    expect(src).toContain('verify-timing.mjs')
  })
})
