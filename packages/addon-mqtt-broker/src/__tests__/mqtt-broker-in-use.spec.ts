import { InstanceInUseError } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { assertMqttBrokerUnused } from '../mqtt-broker-users.js'

const listed = async () => [
  { id: 'int_0070', name: 'Discovery', formValues: { mqttBrokerId: 'b1' } },
  { id: 'int_0071', name: 'Other', formValues: { mqttBrokerId: 'b2' } },
]

describe('removing an MQTT broker', () => {
  it('is refused while an MQTT Discovery integration names it, and names that integration', async () => {
    const err = await assertMqttBrokerUnused('b1', listed).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InstanceInUseError)
    if (!(err instanceof InstanceInUseError)) throw err
    expect(err.users.map((u) => u.id)).toEqual(['int_0070'])
  })

  it('goes through when nothing names it', async () => {
    await expect(assertMqttBrokerUnused('b9', listed)).resolves.toBeUndefined()
  })
})
