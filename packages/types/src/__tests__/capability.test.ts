// packages/types/src/__tests__/capability.test.ts
import { describe, it, expectTypeOf, expect } from 'vitest'
import type {
  CapabilityMode,
  CapabilityDeclaration,
  CapabilityConsumerRegistration,
  CapabilityInfo,
  CapabilityProviderMap,
} from '../interfaces/capability.js'

describe('Capability types', () => {
  it('CapabilityMode accepts singleton and collection', () => {
    expectTypeOf<CapabilityMode>().toEqualTypeOf<'singleton' | 'collection' | 'per-node'>()
  })

  it('CapabilityDeclaration has required fields', () => {
    const decl: CapabilityDeclaration = {
      name: 'storage',
    }
    expectTypeOf(decl.name).toBeString()
  })

  it('CapabilityDeclaration supports optional dependsOn', () => {
    const decl: CapabilityDeclaration = {
      name: 'recording',
      dependsOn: ['streaming-engine'],
    }
    expectTypeOf(decl.dependsOn).toEqualTypeOf<readonly string[] | undefined>()
  })

  it('CapabilityMode is still exported for CapabilityInfo consumers', () => {
    // Mode moved out of CapabilityDeclaration in session 5 A5. The
    // CapabilityMode type is still used by CapabilityInfo (introspection)
    // and by the cap definitions themselves.
    expectTypeOf<CapabilityMode>().toEqualTypeOf<'singleton' | 'collection' | 'per-node'>()
  })

  it('CapabilityConsumerRegistration has capability and optional callbacks', () => {
    const reg: CapabilityConsumerRegistration<string> = {
      capability: 'storage',
      onSet: (_provider: string) => {},
    }
    expectTypeOf(reg.capability).toBeString()
  })

  it('CapabilityInfo has all introspection fields', () => {
    const info: CapabilityInfo = {
      name: 'storage',
      mode: 'singleton',
      providers: ['sqlite-storage'],
      activeProvider: 'sqlite-storage',
      disabledProviders: [],
    }
    expectTypeOf(info.providers).toEqualTypeOf<readonly string[]>()
    expectTypeOf(info.activeProvider).toEqualTypeOf<string | null>()
  })

  it('CapabilityProviderMap is extensible via declaration merging', () => {
    // Base map should have known keys
    type Keys = keyof CapabilityProviderMap
    expectTypeOf<'storage'>().toExtend<Keys>()
  })
})

import type { CapabilityInfo as CI2, NodeSingletonView as NSV } from '../interfaces/capability.js'

it('CapabilityInfo carries an optional per-node singleton view', () => {
  const view: NSV = {
    nodeId: 'dev-agent-0',
    providers: ['webrtc-native'],
    resolvedActive: 'webrtc-native',
    hasOverride: true,
  }
  const info: CI2 = {
    name: 'webrtc-session',
    mode: 'singleton',
    providers: ['stream-broker', 'webrtc-native@dev-agent-0'],
    activeProvider: 'stream-broker',
    disabledProviders: [],
    perNode: [view],
  }
  expect(info.perNode?.[0]?.nodeId).toBe('dev-agent-0')
})
