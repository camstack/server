import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  evaluatePerMacroSliderGuard,
  floorSetIds,
  sliderProblems,
  slidersByStep,
} from './per-macro-slider-reaches-the-pool.guard.js'

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '../../..')

const FACTORY = (ids: readonly string[]): string =>
  `const PER_MACRO_REFILTERED_STEP_IDS: ReadonlySet<string> = new Set([${ids.map((i) => `'${i}'`).join(', ')}])\n`

const INLINE_CLASS = [
  'class PackageDetectionStep {',
  '  definition = {',
  "    id: 'package-detection',",
  '  }',
  '  getConfigSchema() {',
  '    return [',
  '      {',
  "        key: 'minConfidencePackage',",
  "        type: 'number',",
  '      },',
  '    ]',
  '  }',
  '}',
  '',
].join('\n')

const SHARED_CLASS = [
  'class ClassifierWithMinConfidence {',
  '  getConfigSchema() {',
  '    return [',
  '      {',
  "        key: 'minConfidence',",
  '      },',
  '      {',
  "        key: 'minConfidenceAnimal',",
  '      },',
  '    ]',
  '  }',
  '}',
  'const a = new ClassifierWithMinConfidence({',
  "  id: 'animal-a',",
  '})',
  'const b = new ClassifierWithMinConfidence({',
  "  id: 'animal-b',",
  '})',
  '',
].join('\n')

describe('per-macro slider reaches the pool', () => {
  it('the checked-out pipeline passes', () => {
    expect(evaluatePerMacroSliderGuard(PACKAGE_ROOT)).toEqual([])
  })

  it('reads the floor set literal', () => {
    expect([...floorSetIds(FACTORY(['object-detection', 'package-detection']))]).toEqual([
      'object-detection',
      'package-detection',
    ])
    expect(() => floorSetIds('const nothing = 1')).toThrow(/could not find/)
  })

  it('attributes sliders through both file shapes, ignoring bare minConfidence', () => {
    const m = slidersByStep(INLINE_CLASS + SHARED_CLASS)
    expect(m.get('package-detection')).toEqual(['minConfidencePackage'])
    expect(m.get('animal-a')).toEqual(['minConfidenceAnimal'])
    expect(m.get('animal-b')).toEqual(['minConfidenceAnimal'])
  })

  it('refuses the 2026-08-07 defect: a slider born half dead', () => {
    expect(sliderProblems(INLINE_CLASS, FACTORY(['object-detection']))).toEqual([
      { stepId: 'package-detection', key: 'minConfidencePackage' },
    ])
    expect(
      sliderProblems(INLINE_CLASS, FACTORY(['object-detection', 'package-detection'])),
    ).toEqual([])
  })
})
