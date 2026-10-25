import { describe, expect, it } from 'vitest'
import { judge, type HeavyFacts } from '../check-heavy-specs.ts'

const GOOD: HeavyFacts = {
  projectConfigs: new Map([['packages/a', "exclude: ['**/*.heavy.spec.*']"]]),
  packageScripts: { 'test:heavy': 'tsx scripts/run-heavy-specs.ts' },
  checksYaml: 'run: npm run test:heavy',
  heavyCount: 1,
}

describe('check-heavy-specs judge', () => {
  it('accepts a wired convention', () => {
    expect(judge(GOOD)).toEqual([])
  })

  it('refuses a config that does not exclude heavy specs', () => {
    const problems = judge({ ...GOOD, projectConfigs: new Map([['packages/a', 'exclude: []']]) })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('packages/a')
  })

  it('refuses a checks workflow that stopped running test:heavy', () => {
    expect(judge({ ...GOOD, checksYaml: 'run: npm test' })).toHaveLength(1)
  })

  it('refuses a missing test:heavy script', () => {
    expect(judge({ ...GOOD, packageScripts: {} })).toHaveLength(1)
  })
})
