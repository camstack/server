import { describe, expect, it } from 'vitest'
import type {
  IntegrationInstance,
  IntegrationInstanceDescription,
} from '../../capabilities/integration-instances.cap.js'
import { type InstanceSource, instancesOfCap } from '../instances-of-cap.js'

const base = {
  role: 'services',
  instanceMode: 'multiple',
  kind: 'target',
  canTest: false,
} as const
const inst = (id: string, kind: string, enabled = true): IntegrationInstance => ({
  id,
  name: id,
  configured: true,
  enabled,
  kind,
  formValues: {},
})

function source(opts: { failing?: string } = {}): InstanceSource {
  const descriptions: Record<string, IntegrationInstanceDescription> = {
    notifiers: {
      ...base,
      kinds: [
        { id: 'telegram', label: 'T', functionCap: 'notification-output' },
        { id: 'other', label: 'O', functionCap: 'smtp-provider' },
      ],
    },
    ha: {
      ...base,
      kinds: [
        {
          id: 'homeassistant',
          label: 'HA',
          functionCap: 'notification-output',
        },
      ],
    },
    broken: base,
  }
  const rows: Record<string, IntegrationInstance[]> = {
    notifiers: [inst('tg-1', 'telegram', false), inst('r-1', 'other')],
    ha: [inst('ha-1', 'homeassistant')],
    broken: [],
  }
  return {
    holders: async () => ['notifiers', 'ha', 'broken'],
    describe: async (id) => {
      if (id === opts.failing) throw new Error('holder down')
      return descriptions[id] ?? base
    },
    listInstances: async (id) => rows[id] ?? [],
  }
}

describe('instancesOfCap', () => {
  it('lists the instances of kinds serving the cap across holders, a disabled one included', async () => {
    const out = await instancesOfCap(source(), 'notification-output')
    expect(out.instances.map((i) => [i.addonId, i.instance.id, i.instance.enabled])).toEqual([
      ['notifiers', 'tg-1', false],
      ['ha', 'ha-1', true],
    ])
    expect(out.unreadable).toEqual([])
  })

  it('names a holder that cannot answer instead of dropping it', async () => {
    const out = await instancesOfCap(source({ failing: 'ha' }), 'notification-output')
    expect(out.instances.map((i) => i.instance.id)).toEqual(['tg-1'])
    expect(out.unreadable).toEqual([{ addonId: 'ha', error: 'holder down' }])
  })

  it('narrows to one kind', async () => {
    const out = await instancesOfCap(source(), 'notification-output', {
      kind: 'homeassistant',
    })
    expect(out.instances.map((i) => i.instance.id)).toEqual(['ha-1'])
  })
})
