// packages/types/src/__tests__/addon-declaration.test.ts
import { describe, it, expectTypeOf } from 'vitest'
import type { AddonDeclaration } from '../interfaces/addon.js'
import type { CapabilityDeclaration } from '../interfaces/capability.js'

describe('AddonDeclaration with capabilities', () => {
  it('accepts capabilities as optional field', () => {
    const decl: AddonDeclaration = {
      id: 'sqlite-storage',
      entry: './dist/addon.js',
      slot: 'detector',
    }
    // Should compile without capabilities
    expectTypeOf(decl.id).toBeString()
  })

  it('accepts capabilities array when provided', () => {
    const decl: AddonDeclaration = {
      id: 'sqlite-storage',
      entry: './dist/addon.js',
      slot: 'detector',
      capabilities: [{ name: 'storage' }],
    }
    expectTypeOf(decl.capabilities).toEqualTypeOf<readonly CapabilityDeclaration[] | undefined>()
  })
})
