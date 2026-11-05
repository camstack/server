/**
 * The Home Assistant connections are the `account` instances of the provider's own
 * `integration-instances` (D1013). The read is pinned to the owning addon, and its refusal while
 * the provider is still registering is "I do not know yet" — an empty list plus a report — never
 * a throw that would take the export half from "one instance, switched off" to "no instance"
 * (2026-08-09). The fake answers per provider, the way the real cap does.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  HA_ACCOUNT_INSTANCE_KIND,
  HA_BROKER_KIND,
  HA_PROVIDER_ADDON_ID,
  type HaBroker,
  type HaInstanceRecord,
  type InstanceListQuery,
  listHomeAssistantBrokers,
} from '../ha-broker-source.js'

const HOME_ASSISTANT: HaBroker = {
  id: 'ha_001',
  name: 'Casa',
  kind: HA_BROKER_KIND,
  addonId: HA_PROVIDER_ADDON_ID,
}

const ACCOUNT: HaInstanceRecord = { id: 'ha_001', name: 'Casa', kind: HA_ACCOUNT_INSTANCE_KIND }
const INTEGRATION: HaInstanceRecord = { id: 'int_0001', name: 'Casa', kind: 'integration' }

function createInstancesCap(registered: readonly string[]): {
  query: InstanceListQuery
  calls: unknown[]
} {
  const calls: unknown[] = []
  const query: InstanceListQuery = async (input) => {
    calls.push(input)
    if (!registered.includes(input.addonId)) {
      throw new Error(
        `Capability "integration-instances" has no provider with addonId "${input.addonId}".`,
      )
    }
    return [ACCOUNT, INTEGRATION]
  }
  return { query, calls }
}

describe('listHomeAssistantBrokers', () => {
  it('reads the account instances of the provider and drops its device-provider records', async () => {
    const cap = createInstancesCap([HA_PROVIDER_ADDON_ID])
    await expect(listHomeAssistantBrokers(cap.query)).resolves.toEqual([HOME_ASSISTANT])
  })

  it('pins the enumeration to the owning addon', async () => {
    const cap = createInstancesCap([HA_PROVIDER_ADDON_ID])
    await listHomeAssistantBrokers(cap.query)
    expect(cap.calls).toEqual([{ addonId: HA_PROVIDER_ADDON_ID }])
  })

  it('degrades to an empty list and REPORTS while the provider is still registering', async () => {
    const cap = createInstancesCap([])
    const onUnavailable = vi.fn()
    await expect(listHomeAssistantBrokers(cap.query, onUnavailable)).resolves.toEqual([])
    expect(onUnavailable).toHaveBeenCalledTimes(1)
  })
})
