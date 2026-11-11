import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ALL_CAPABILITY_DEFINITIONS,
  CAPABILITY_ROUTER_KEYS,
} from '../generated/capability-router-map.js'
import { DiscoveredChildDeviceSchema } from '../capabilities/device-adoption.cap.js'
import { DeviceType } from '../device/device-type.js'

describe('retired device-discovery capability', () => {
  it('is absent from the generated capability list and router keys; device-adoption stays', () => {
    const routerNames = CAPABILITY_ROUTER_KEYS.map((entry) => entry.name)
    const definitionNames = ALL_CAPABILITY_DEFINITIONS.map((definition) => definition.name)
    expect(routerNames).not.toContain('device-discovery')
    expect(definitionNames).not.toContain('device-discovery')
    expect(routerNames).toContain('device-adoption')
    expect(definitionNames).toContain('device-adoption')
  })

  it('has no capability source file left', () => {
    const file = fileURLToPath(new URL('../capabilities/device-discovery.cap.ts', import.meta.url))
    expect(existsSync(file)).toBe(false)
  })

  it('device-adoption still validates a candidate with nested children', () => {
    const parsed = DiscoveredChildDeviceSchema.parse({
      childNativeId: 'ha:dev:abc',
      name: 'Kitchen Light',
      type: DeviceType.Light,
      status: 'online',
      metadata: {},
      alreadyAdopted: false,
      adoptedDeviceId: null,
      children: [
        {
          childNativeId: 'ha:ent:light.kitchen',
          name: 'Kitchen Light',
          type: DeviceType.Light,
          status: 'online',
          metadata: {},
          alreadyAdopted: false,
          adoptedDeviceId: null,
        },
      ],
    })
    expect(parsed.children?.[0]?.childNativeId).toBe('ha:ent:light.kitchen')
  })
})
