import { describe, expect, it } from 'vitest'
import { splitByNodeRequirements } from '../delivery-requirements.js'

const requiresServer = (range: string) => async () => ({ server: range })

describe('splitByNodeRequirements (D989)', () => {
  const target = { name: '@camstack/addon-x', version: '1.3.0' }

  it('holds a delivery whose version needs a newer server than the node runs', async () => {
    const out = await splitByNodeRequirements([target], '1.2.0', requiresServer('>=1.3.0'))
    expect(out.deliver).toEqual([])
    expect(out.held[0]?.unmet).toEqual([
      { kind: 'server-too-old', required: '1.3.0', running: '1.2.0' },
    ])
    expect(out.held[0]?.reason).toContain('1.3.0')
    expect(out.held[0]?.reason).toContain('1.2.0')
  })

  it('delivers when the node meets the minimum', async () => {
    const out = await splitByNodeRequirements([target], '1.3.1', requiresServer('>=1.3.0'))
    expect(out.deliver).toEqual([target])
    expect(out.held).toEqual([])
  })

  it('delivers a version that declares nothing, whatever the node reports', async () => {
    const out = await splitByNodeRequirements([target], null, async () => undefined)
    expect(out.deliver).toEqual([target])
  })

  it('a node that reports no server version never passes a declared minimum', async () => {
    const out = await splitByNodeRequirements([target], null, requiresServer('>=1.3.0'))
    expect(out.held).toHaveLength(1)
  })
})
