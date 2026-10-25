// packages/types/src/__tests__/addon-capability-provider.test.ts
import { describe, it, expectTypeOf } from 'vitest'
import type { ICamstackAddon } from '../interfaces/addon.js'

describe('ICamstackAddon interface', () => {
  it('does not have getCapabilityProvider (removed — use registerProvider instead)', () => {
    // Verify the method no longer exists on the interface
    type Keys = keyof ICamstackAddon
    expectTypeOf<'getCapabilityProvider' extends Keys ? true : false>().toEqualTypeOf<false>()
  })
})
