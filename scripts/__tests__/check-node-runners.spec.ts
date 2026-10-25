import { describe, expect, it } from 'vitest'
import { judgeNodeStatus } from '../hub/check-node-runners.js'

const clean = {
  runningVersion: '1.2.590',
  runners: { expected: 3, running: 3, failed: [], refused: [], missing: [], planKnown: true },
}

describe('check-node-runners (D877 rollout gate)', () => {
  it('passes a node on the expected version with every runner up', () => {
    expect(judgeNodeStatus(clean, '1.2.590').problems).toEqual([])
  })
  it('fails on another version', () => {
    expect(judgeNodeStatus(clean, '1.2.591').problems[0]).toContain('expected 1.2.591')
  })
  it('fails on failed, refused (with the reason) and missing runners', () => {
    const { problems } = judgeNodeStatus(
      {
        ...clean,
        runners: {
          expected: 4,
          running: 1,
          failed: ['a'],
          refused: [{ runnerId: 'b', reason: 'legacy blobs' }],
          missing: ['c'],
          planKnown: true,
        },
      },
      '1.2.590',
    )
    expect(problems).toEqual([
      'runner a is failed',
      'runner b is REFUSED: legacy blobs',
      'runner c is missing',
    ])
  })
  it('an unchecked node is a failure, not a pass', () => {
    const { runningVersion } = clean
    expect(judgeNodeStatus({ runningVersion }, '1.2.590').problems[0]).toContain('not run yet')
  })
  it('garbage is a failure', () => {
    expect(judgeNodeStatus(null, 'x').problems).toHaveLength(1)
  })
})
