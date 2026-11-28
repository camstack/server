import { SWITCH_DEFAULT_OPTIONS } from '@dominevo/types'
import { commandOrigin } from '@dominevo/types/addon'
import { describe, expect, it } from 'vitest'
import { applyCapCommand, type CapCommandDevice } from '../command-routes.js'

describe('applyCapCommand hands the call origin to the device proxy', () => {
  it('passes the options untouched as the second argument, and none when absent', async () => {
    const seen: unknown[][] = []
    const device: CapCommandDevice = {
      switch: {
        setState: async (...args: unknown[]) => {
          seen.push(args)
        },
        toggle: async () => undefined,
        getOptions: async () => SWITCH_DEFAULT_OPTIONS,
        powerCycle: async () => undefined,
        getStatus: async () => null,
      },
    }
    const origin = commandOrigin({
      kind: 'on-behalf',
      source: 'homeassistant',
      principalId: 'ha-user-1',
    })
    const command = { kind: 'cap-switch', deviceId: 5, capName: 'switch', on: true } as const
    await applyCapCommand(device, command, origin)
    await applyCapCommand(device, command)
    expect(seen).toEqual([
      [{ on: true }, origin],
      [{ on: true }, undefined],
    ])
  })
})
