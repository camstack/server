import { describe, expect, it } from 'vitest'
import {
  DeviceTransitionSchema,
  TransitionActorKindSchema,
  TransitionActorSchema,
  TransitionOutcomeSchema,
  TransitionRowOutcomeSchema,
  type DeviceTransition,
} from '../device-transition.js'

const base: DeviceTransition = {
  id: '12:1700000000000:0',
  deviceId: 12,
  at: 1_700_000_000_000,
  capName: 'switch',
  field: 'on',
  from: false,
  to: true,
  outcome: 'ok',
  actor: { kind: 'user', userId: 'u1', username: 'ada', credential: 'session' },
  command: {
    commandId: 'c1',
    method: 'setState',
    args: { on: true },
    requestedAt: 1_699_999_999_000,
  },
}

describe('DeviceTransitionSchema', () => {
  it('round-trips a stored command row', () => {
    expect(DeviceTransitionSchema.parse(base)).toEqual(base)
  })

  it('round-trips an unknown prior (null) and a device-originated change without a command', () => {
    const device: DeviceTransition = {
      id: '12:1:0',
      deviceId: 12,
      at: 1,
      capName: 'switch',
      field: 'on',
      from: null,
      to: true,
      outcome: 'device',
      actor: { kind: 'device' },
    }
    expect(DeviceTransitionSchema.parse(device)).toEqual(device)
  })

  it('stores only ok | failed and refuses the retired confirmation outcomes', () => {
    for (const outcome of ['ok', 'failed'] as const) {
      expect(TransitionOutcomeSchema.safeParse(outcome).success).toBe(true)
    }
    for (const retired of ['confirmed', 'already', 'unconfirmed', 'device']) {
      expect(TransitionOutcomeSchema.safeParse(retired).success).toBe(false)
    }
    // a row read back may also be a derived device change
    expect(TransitionRowOutcomeSchema.safeParse('device').success).toBe(true)
    expect(TransitionRowOutcomeSchema.safeParse('confirmed').success).toBe(false)
  })

  it('knows every actor kind and refuses an unknown one', () => {
    const kinds = [
      { kind: 'addon', addonId: 'addon-export-alexa' },
      { kind: 'action', addonId: 'core-blocks', actionId: 'a', runId: 'r' },
      { kind: 'scheduler', addonId: 'core-blocks', schedulerId: 's' },
      { kind: 'composition', owner: 'composer' },
      { kind: 'node', nodeId: 'n1' },
      { kind: 'device' },
    ]
    for (const actor of kinds) expect(TransitionActorSchema.safeParse(actor).success).toBe(true)
    expect(TransitionActorSchema.safeParse({ kind: 'robot' }).success).toBe(false)
  })

  it('keeps the principal an exporter relayed on an addon actor', () => {
    const actor = {
      kind: 'addon',
      addonId: 'addon-export-alexa',
      onBehalf: { source: 'alexa', principalId: 'amzn1.account.X', principalName: 'Ada' },
    }
    expect(TransitionActorSchema.parse(actor)).toEqual(actor)
    expect(
      TransitionActorSchema.safeParse({
        kind: 'addon',
        addonId: 'a',
        onBehalf: { source: 'telegram', principalId: 'x' },
      }).success,
    ).toBe(false)
  })

  it('refuses an outcome outside the table', () => {
    expect(DeviceTransitionSchema.safeParse({ ...base, outcome: 'maybe' }).success).toBe(false)
  })

  it('keeps the filter enum equal to the actor union', () => {
    const union = TransitionActorSchema.options.map((option) => option.shape.kind.value)
    expect([...TransitionActorKindSchema.options].sort()).toEqual([...union].sort())
  })
})
