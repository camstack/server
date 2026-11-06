/**
 * The hub resolver answers "which instances of cap X exist" from the registry, across providers, and
 * says which holder it could not read (an unreadable holder is NOT an empty one: D315, D49).
 */
import type {
  IIntegrationInstancesProvider,
  IntegrationInstance,
  IntegrationInstanceKind,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { resolveInstancesOfCap } from '../instances-of-cap.js'

const NOTIFY_KIND: IntegrationInstanceKind = {
  id: 'telegram',
  label: 'Telegram',
  functionCap: 'notification-output',
  role: 'services',
}
const instance = (id: string, enabled: boolean): IntegrationInstance => ({
  id,
  name: id,
  configured: true,
  enabled,
  kind: 'telegram',
  formValues: {},
})

function holder(
  kinds: readonly IntegrationInstanceKind[],
  rows: readonly IntegrationInstance[],
  broken = false,
) {
  const provider: Partial<IIntegrationInstancesProvider> = {
    createInstance: async () => instance('x', true),
    getInstance: async () => null,
    describe: async () => {
      if (broken) throw new Error('holder down')
      return {
        role: 'services',
        instanceMode: 'multiple',
        kind: 'target',
        canTest: false,
        kinds: [...kinds],
      }
    },
    listInstances: async () => rows,
  }
  return provider
}

function registryOf(entries: Record<string, readonly (readonly [string, unknown])[]>) {
  return { getCollectionEntries: (cap: string) => entries[cap] ?? [] }
}

describe('resolveInstancesOfCap', () => {
  it('returns the instances of the asked cap, a disabled one included, with their provider', async () => {
    const notifiers = holder([NOTIFY_KIND], [instance('t-on', true), instance('t-off', false)])
    const other = holder(
      [
        {
          id: 'cam',
          label: 'Cam',
          functionCap: 'device-provider',
          role: 'devices',
        },
      ],
      [instance('c1', true)],
    )
    const registry = registryOf({
      'integration-instances': [
        ['notifiers', notifiers],
        ['esphome', other],
      ],
      'notification-output': [['notifiers', {}]],
    })
    const { instances, unreadable } = await resolveInstancesOfCap(registry, 'notification-output')
    expect(instances.map((i) => [i.addonId, i.instance.id, i.instance.enabled])).toEqual([
      ['notifiers', 't-on', true],
      ['notifiers', 't-off', false],
    ])
    expect(unreadable).toEqual([])
  })

  it('reports a holder that cannot answer instead of treating it as empty', async () => {
    const registry = registryOf({
      'integration-instances': [
        ['notifiers', holder([NOTIFY_KIND], [instance('t1', true)])],
        ['homeassistant', holder([NOTIFY_KIND], [], true)],
      ],
      'notification-output': [
        ['notifiers', {}],
        ['homeassistant', {}],
      ],
    })
    const { instances, unreadable } = await resolveInstancesOfCap(registry, 'notification-output')
    expect(instances.map((i) => i.instance.id)).toEqual(['t1'])
    expect(unreadable).toEqual([{ addonId: 'homeassistant', error: 'holder down' }])
  })

  it('ignores a holder that does not provide the cap', async () => {
    const registry = registryOf({
      'integration-instances': [['notifiers', holder([NOTIFY_KIND], [instance('t1', true)])]],
      'notification-output': [],
    })
    expect((await resolveInstancesOfCap(registry, 'notification-output')).instances).toEqual([])
  })
})
