import { describe, it, expect } from 'vitest'
import { isAddonDeploySource } from '../src/kernel/moleculer/addon-deploy-source'

describe('isAddonDeploySource', () => {
  it('accepts an npm source', () => {
    expect(isAddonDeploySource({ kind: 'npm', version: '1.2.3' })).toBe(true)
  })
  it('accepts a hub-http source', () => {
    expect(
      isAddonDeploySource({
        kind: 'hub-http',
        url: 'https://h/x',
        token: 't',
        sha256: 'a',
        bytes: 5,
      }),
    ).toBe(true)
  })
  it('rejects unknown kind and malformed shapes', () => {
    expect(isAddonDeploySource({ kind: 'ftp' })).toBe(false)
    expect(isAddonDeploySource({ kind: 'npm' })).toBe(false)
    expect(isAddonDeploySource({ kind: 'hub-http', url: 'x', token: 't', sha256: 'a' })).toBe(false)
    expect(isAddonDeploySource(null)).toBe(false)
  })
})
