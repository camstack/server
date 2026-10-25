import { describe, it, expectTypeOf } from 'vitest'
import { z } from 'zod'
import {
  method,
  type CapabilityDefinition,
  type InferProvider,
} from '../../capabilities/capability-definition.js'
import type { ProviderRegistration } from '../addon.js'

const fooCap = {
  name: 'foo',
  scope: 'device',
  mode: 'singleton',
  methods: { bar: method(z.object({ deviceId: z.string() }), z.number()) },
} as const satisfies CapabilityDefinition

describe('ProviderRegistration', () => {
  it('requires provider to match InferProvider<typeof cap>', () => {
    const reg: ProviderRegistration<typeof fooCap> = {
      capability: fooCap,
      provider: { bar: async () => 42 },
      kind: 'native',
    }
    expectTypeOf(reg.provider).toEqualTypeOf<InferProvider<typeof fooCap>>()
  })

  it('still accepts the @deprecated wrapper kind/defaultActive hints (back-compat)', () => {
    // @deprecated per D4: kind/defaultActive must now be declared on the CapabilityDefinition,
    // not on the ProviderRegistration. These fields remain on the interface for back-compat only;
    // new code must not set them on the registration object.
    const reg: ProviderRegistration<typeof fooCap> = {
      capability: fooCap,
      provider: { bar: async () => 42 },
      kind: 'wrapper',
      defaultActive: true,
    }
    expectTypeOf(reg.kind).toEqualTypeOf<'native' | 'wrapper' | undefined>()
    expectTypeOf(reg.defaultActive).toEqualTypeOf<boolean | undefined>()
  })
})
