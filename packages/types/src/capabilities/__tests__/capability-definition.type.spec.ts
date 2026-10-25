import { describe, it, expectTypeOf } from 'vitest'
import { z } from 'zod'
import {
  method,
  type CapabilityDefinition,
  type InferProvider,
  type InferDeviceProxyCap,
} from '../capability-definition.js'
import { DeviceType } from '../../device/device-type.js'

const sampleCap = {
  name: 'sample',
  scope: 'device',
  mode: 'singleton',
  deviceTypes: [DeviceType.Camera] as const,
  methods: {
    doThing: method(z.object({ deviceId: z.string(), count: z.number() }), z.boolean()),
  },
} as const satisfies CapabilityDefinition

describe('InferDeviceProxyCap', () => {
  it('strips deviceId from every method input and keeps output', () => {
    type Proxy = InferDeviceProxyCap<typeof sampleCap>
    expectTypeOf<Parameters<Proxy['doThing']>[0]>().toEqualTypeOf<{ count: number }>()
    expectTypeOf<ReturnType<Proxy['doThing']>>().toEqualTypeOf<Promise<boolean>>()
    type Provider = InferProvider<typeof sampleCap>
    expectTypeOf<Parameters<Provider['doThing']>[0]>().toEqualTypeOf<{
      deviceId: string
      count: number
    }>()
  })
})
