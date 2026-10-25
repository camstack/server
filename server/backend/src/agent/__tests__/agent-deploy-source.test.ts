import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { resolveDeployAction } from '../agent-service'

describe('$agent.deploy source routing', () => {
  it('npm source calls installFromNpm', async () => {
    const installFromNpm = vi.fn(async () => {})
    const action = resolveDeployAction({
      installFromNpm,
      applyBundle: vi.fn(async () => ({ addonDir: '/x' })),
      fetchBundle: vi.fn(async () => Buffer.from('x')),
      onApplied: () => {},
    })
    const r = await action({ addonId: '@c/a', source: { kind: 'npm', version: '1.2.3' } })
    expect(installFromNpm).toHaveBeenCalledWith('@c/a', '1.2.3')
    expect(r.success).toBe(true)
  })
  it('hub-http source fetches then applies the bundle', async () => {
    const fetchBundle = vi.fn(async () => Buffer.from('TGZ'))
    const applyBundle = vi.fn(async () => ({ addonDir: '/x' }))
    const action = resolveDeployAction({
      installFromNpm: vi.fn(),
      applyBundle,
      fetchBundle,
      onApplied: () => {},
    })
    await action({
      addonId: '@c/a',
      source: { kind: 'hub-http', url: 'https://h/b', token: 't', sha256: 's', bytes: 3 },
    })
    expect(fetchBundle).toHaveBeenCalled()
    expect(applyBundle).toHaveBeenCalled()
  })
  /**
   * The hub asserts this hash against the bundle it staged. Without it the only
   * evidence a deploy produced was the agent saying "success" — which it also
   * said while the node kept running the previous dist.
   */
  it('reports the sha256 of the bundle it actually applied', async () => {
    const bytes = Buffer.from('TGZ-CONTENT')
    const action = resolveDeployAction({
      installFromNpm: vi.fn(),
      applyBundle: vi.fn(async () => ({ addonDir: '/x' })),
      fetchBundle: vi.fn(async () => bytes),
      onApplied: () => {},
    })
    const r = await action({
      addonId: '@c/a',
      source: { kind: 'hub-http', url: 'https://h/b', token: 't', sha256: 's', bytes: 11 },
    })
    expect(r.appliedSha256).toBe(createHash('sha256').update(bytes).digest('hex'))
  })

  it('legacy bundle still applies (back-compat)', async () => {
    const applyBundle = vi.fn(async () => ({ addonDir: '/x' }))
    const action = resolveDeployAction({
      installFromNpm: vi.fn(),
      applyBundle,
      fetchBundle: vi.fn(),
      onApplied: () => {},
    })
    await action({ addonId: '@c/a', bundle: Buffer.from('TGZ').toString('base64') })
    expect(applyBundle).toHaveBeenCalled()
  })
})
