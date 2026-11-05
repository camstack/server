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

  it('holds a delivery whose addon minimum is above what the node roster holds (addon-too-old)', async () => {
    const out = await splitByNodeRequirements(
      [target],
      '1.3.1',
      async () => ({ addons: { '@camstack/addon-y': '>=2.0.0' } }),
      [{ name: '@camstack/addon-y', version: '1.0.0' }],
    )
    expect(out.deliver).toEqual([])
    expect(out.held[0]?.unmet).toEqual([
      {
        kind: 'addon-too-old',
        packageName: '@camstack/addon-y',
        required: '2.0.0',
        running: '1.0.0',
      },
    ])
    expect(out.held[0]?.reason).toContain('addon-y')
  })

  it('delivers when the node roster, or the same batch, meets the addon minimum', async () => {
    const needsY = async (name: string) =>
      name === target.name ? { addons: { '@camstack/addon-y': '>=2.0.0' } } : undefined
    const met = await splitByNodeRequirements([target], '1.3.1', needsY, [
      { name: '@camstack/addon-y', version: '2.1.0' },
    ])
    expect(met.deliver).toEqual([target])
    const inBatch = { name: '@camstack/addon-y', version: '2.0.0' }
    const batch = await splitByNodeRequirements([target, inBatch], '1.3.1', needsY, [
      { name: '@camstack/addon-y', version: '1.0.0' },
    ])
    expect(batch.deliver).toEqual([target, inBatch])
  })

  it('does not judge an addon the node will never carry (hub-only, or not in its roster or batch)', async () => {
    const needsHubOnly = async () => ({ addons: { '@camstack/addon-hub-only': '>=2.0.0' } })
    const out = await splitByNodeRequirements([target], '1.3.1', needsHubOnly, [
      { name: '@camstack/addon-other', version: '1.0.0' },
    ])
    expect(out.deliver).toEqual([target])
    expect(out.held).toEqual([])
  })

  it('does not judge an addon the same pass removes from the node', async () => {
    const needsY = async () => ({ addons: { '@camstack/addon-y': '>=2.0.0' } })
    const out = await splitByNodeRequirements(
      [target],
      '1.3.1',
      needsY,
      [{ name: '@camstack/addon-y', version: '1.0.0' }],
      new Set(['@camstack/addon-y']),
    )
    expect(out.deliver).toEqual([target])
  })
})
