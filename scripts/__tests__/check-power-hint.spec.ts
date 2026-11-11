import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { CapabilityDefinition } from '../../packages/types/src/capabilities/capability-definition.ts'
import { method } from '../../packages/types/src/capabilities/capability-definition.ts'
import { humidifierCapability } from '../../packages/types/src/capabilities/humidifier.cap.ts'
import {
  checkHintedCaps,
  checkProviderWiring,
  collectPowerGuardFiles,
} from '../power-hint-guard.ts'

const Slice = z.object({
  on: z.boolean().nullable(),
  power: z.boolean().nullable(),
  lastChangedAt: z.number(),
})

const twoPowerControls = {
  name: 'fixture-two-power',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  methods: {
    setOn: method(z.object({ deviceId: z.number(), on: z.boolean() }), z.void()),
    turnOff: method(z.object({ deviceId: z.number() }), z.void()),
  },
  status: { schema: Slice, kind: 'command-driven' },
  runtimeState: Slice,
  power: { kind: 'field', field: 'on', set: 'setOn' },
} as const satisfies CapabilityDefinition

const namesAbsentMembers = {
  ...twoPowerControls,
  name: 'fixture-absent',
  methods: {},
  power: { kind: 'field', field: 'running', set: 'setRunning' },
} as const satisfies CapabilityDefinition

const HINTED = new Map([['humidifierCapability', 'humidifier']])

describe('check-power-hint — hinted caps', () => {
  it('refuses a second on/off field and a second on/off setter beside the hint', () => {
    const failures = checkHintedCaps([twoPowerControls])
    expect(failures.some((f) => f.includes("'power' is a second on/off field"))).toBe(true)
    expect(failures.some((f) => f.includes("'turnOff' is a second on/off setter"))).toBe(true)
  })

  it('refuses a hint naming a field or method the cap does not have', () => {
    const failures = checkHintedCaps([namesAbsentMembers])
    expect(failures.some((f) => f.includes("field 'running'"))).toBe(true)
    expect(failures.some((f) => f.includes("method 'setRunning'"))).toBe(true)
  })

  it('accepts the real humidifier hint', () => {
    expect(checkHintedCaps([humidifierCapability])).toEqual([])
  })
})

describe('check-power-hint — provider wiring', () => {
  const unwired = {
    rel: 'packages/addon-x/src/x-humidifier.ts',
    code: 'this.ctx.registerNativeCap(humidifierCapability, provider)\n',
  }

  it('refuses a provider of a hinted cap that does not register the power switch', () => {
    expect(checkProviderWiring([unwired], HINTED, new Map())).toHaveLength(1)
  })

  it('accepts the provider once it calls registerPowerSwitch for the same cap', () => {
    const wired = {
      ...unwired,
      code: `${unwired.code}registerPowerSwitch(this, humidifierCapability, provider)\n`,
    }
    expect(checkProviderWiring([wired], HINTED, new Map())).toEqual([])
  })

  it('refuses a pending entry that no longer needs its exemption', () => {
    const pending = new Map([['packages/addon-x/src/gone.ts', 'moved']])
    expect(checkProviderWiring([], HINTED, pending)).toEqual([
      'packages/addon-x/src/gone.ts: listed in PENDING_POWER_SWITCH but no longer needs it — remove the entry',
    ])
  })

  it('is green on the real tree for the humidifier', () => {
    expect(checkProviderWiring(collectPowerGuardFiles(), HINTED, new Map())).toEqual([])
  })
})
