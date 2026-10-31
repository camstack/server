import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The test shards live in two places: the matrix of ci.yml (what runs) and
 * the SHARDS table of test-affected.sh (what each shard tests). A shard in
 * one and not the other is either a job that exits "unknown shard" or a
 * slice of tests nobody runs.
 */
function matrixShards(): string[] {
  const yml = readFileSync('.github/workflows/ci.yml', 'utf8')
  const block = yml.match(/matrix:\n\s+shard:\n((?:\s+- [\w-]+\n)+)/)
  if (block === null) throw new Error('ci.yml has no tests matrix')
  return [...block[1].matchAll(/- ([\w-]+)/g)].map((m) => m[1])
}

function scriptShards(): string[] {
  return execFileSync('bash', ['scripts/ci/test-affected.sh', '--list-shards'], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/)
}

describe('CI test shards', () => {
  it('ci.yml runs exactly the shards test-affected.sh knows (plus static)', () => {
    expect([...scriptShards(), 'static'].sort()).toEqual(matrixShards().sort())
  })

  it('the light lane is spread over four shards, so no one job carries the slow addons', () => {
    expect(scriptShards().filter((s) => s.startsWith('light-'))).toEqual([
      'light-a',
      'light-b',
      'light-c',
      'light-d',
    ])
  })

  it('the Nx cache is saved by one job, not by all of them', () => {
    const yml = readFileSync('.github/workflows/ci.yml', 'utf8')
    expect(yml).toMatch(/uses: actions\/cache\/restore@v4[\s\S]{0,200}\.nx\/cache/)
    expect(yml).toMatch(/uses: actions\/cache\/save@v4[\s\S]{0,200}\.nx\/cache/)
    const combined = yml
      .split('\n      - name:')
      .filter((step) => /uses: actions\/cache@v4/.test(step) && step.includes('.nx/cache'))
    expect(combined).toEqual([])
  })
})
