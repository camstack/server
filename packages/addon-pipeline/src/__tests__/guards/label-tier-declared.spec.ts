import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  evaluateLabelTierGuard,
  labelTierFailures,
  parseSteps,
} from './label-tier-declared.guard.js'

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '../../..')

const step = (id: string, classes: readonly string[], tier?: 1 | 2): string =>
  [
    '  {',
    `    id: '${id}',`,
    `    outputClasses: [${classes.map((c) => `'${c}'`).join(', ')}],`,
    ...(tier === undefined ? [] : [`    labelTier: ${String(tier)},`]),
    '  },',
  ].join('\n')

describe('label tier declared', () => {
  it('the checked-out step definitions pass', () => {
    expect(evaluateLabelTierGuard(PACKAGE_ROOT)).toEqual([])
  })

  it('parses one block per id', () => {
    const src = [step('a', ['person']), step('b', ['dog'], 1)].join('\n')
    expect(parseSteps(src).map((s) => [s.id, s.hasLabelTier])).toEqual([
      ['a', false],
      ['b', true],
    ])
  })

  it('a macro-only step and an artifact step need no tier', () => {
    const src = [step('a', ['person', 'vehicle']), step('b', ['embedding'])].join('\n')
    expect(labelTierFailures(src)).toEqual([])
  })

  it('refuses the silently-dropped classifier: a label with no declared tier', () => {
    const src = [step('bird-species', ['Turdus migratorius'])].join('\n')
    const out = labelTierFailures(src)
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('bird-species')
    expect(out[0]).toContain('declares no labelTier')
  })

  it('object-detection is label-bearing through its raw class', () => {
    expect(labelTierFailures(step('object-detection', ['person']))).toEqual([
      'object-detection: declares no labelTier — its RAW class (`dog` under `animal`) is a tier-1 label',
    ])
    expect(labelTierFailures(step('object-detection', ['person'], 1))).toEqual([])
  })

  it('a file shape it cannot parse is a failure, not a pass', () => {
    expect(labelTierFailures('export const nothing = 1')).toHaveLength(1)
  })
})
