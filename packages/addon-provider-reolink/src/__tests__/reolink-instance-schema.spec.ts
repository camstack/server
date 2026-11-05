/**
 * D985, one form per instance: an NVR / Home Hub integration is configured by its connection
 * only, the default integration shows no hub form. The create wizard has no id yet and always sets
 * up a NEW instance. The form is the `instanceFormSchema` of the instances provider.
 */
import type {
  ConfigField,
  ConfigUISchema,
  IIntegrationInstancesProvider,
  RecordIntegrationInstances,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ReolinkProviderAddon } from '../addon.js'
import { isHubIntegration } from '../hub-connection.js'
import {
  integrationIsHub,
  type ReolinkConnectionBody,
  reolinkInstancesProvider,
} from '../reolink-instances.js'
import { DeviceType } from '@camstack/types'

interface FakeIntegration {
  readonly originStableId?: string
  readonly info: Readonly<Record<string, unknown>>
  readonly settings: Readonly<Record<string, unknown>>
}

function keysOf(schema: ConfigUISchema | null): string[] {
  const out: string[] = []
  for (const section of schema?.sections ?? []) {
    for (const field of section.fields as readonly ConfigField[]) {
      if ('key' in field) out.push(field.key)
    }
  }
  return out
}

const refused = async (): Promise<never> => {
  throw new Error('the fake serves the form only')
}

const stubProvider: IIntegrationInstancesProvider = {
  describe: refused,
  instanceFormSchema: refused,
  listInstances: refused,
  getInstance: refused,
  createInstance: refused,
  updateInstance: refused,
  setInstanceEnabled: refused,
  deleteInstance: refused,
  testInstance: refused,
}

function schemaFor(
  id: string | null,
  integration: FakeIntegration | 'unreachable' = { info: {}, settings: {} },
): Promise<ConfigUISchema> {
  const instances: Pick<
    RecordIntegrationInstances<ReolinkConnectionBody>,
    'toProvider' | 'getResolved'
  > = {
    toProvider: () => stubProvider,
    getResolved: async () =>
      integration === 'unreachable' ? null : { name: 'x', ...integration.settings },
  }
  const provider = reolinkInstancesProvider(instances, {
    registryEvidenceOf: async () =>
      integration === 'unreachable'
        ? null
        : { originStableId: integration.originStableId, info: integration.info },
  })
  return provider.instanceFormSchema({ id })
}

describe('Reolink per-instance integration form', () => {
  it('the create wizard (no id yet) shows the hub connection and nothing else', async () => {
    const keys = keysOf(await schemaFor(null))
    expect(keys).toEqual(
      expect.arrayContaining(['host', 'port', 'rtspPort', 'username', 'password']),
    )
    expect(keys).not.toContain('smtpPort')
    expect(keys.some((k) => /^(email|webhook|clip)/i.test(k))).toBe(false)
  })

  it('a hub integration (migrated, set up from a hub candidate, or with a host) gets the connection form', async () => {
    for (const hub of [
      { info: { migratedFromHubDeviceId: 3 }, settings: {} },
      { originStableId: 'reolink-hub-uid-abc', info: {}, settings: {} },
      { info: {}, settings: { host: '10.0.0.5' } },
    ] satisfies FakeIntegration[]) {
      expect(keysOf(await schemaFor('int-1', hub))).toContain('rtspPort')
    }
  })

  it('the default integration shows no hub form', async () => {
    expect(keysOf(await schemaFor('int-default'))).toEqual([])
  })

  it('an unreadable instance shows the hub form instead of a half form', async () => {
    expect(keysOf(await schemaFor('int-1', 'unreachable'))).toContain('rtspPort')
  })

  it('the addon-level schema no longer carries the hub connection', async () => {
    const defaults = await new ReolinkProviderAddon().getScopedSettingsSchema(
      'device-defaults',
      'videoclips',
    )
    expect(keysOf(defaults)).toContain('clipCatalogRefreshMinutes')
    expect(keysOf(defaults)).not.toContain('rtspPort')
    expect(keysOf(defaults)).not.toContain('host')
  })

  it('isHubIntegration is false for an empty default integration', () => {
    expect(isHubIntegration({ info: {}, settings: {} })).toBe(false)
  })
})

describe('Reolink manual add is offered per integration (planning#442)', () => {
  class ProbedAddon extends ReolinkProviderAddon {
    constructor(private readonly hubIds: ReadonlySet<string>) {
      super()
    }
    protected override async isHubIntegrationId(id: string | undefined): Promise<boolean> {
      return id !== undefined && this.hubIds.has(id)
    }
  }
  const addon = new ProbedAddon(new Set(['hub-1']))

  it('a hub integration gets no creation form and no manual type', async () => {
    expect(
      await addon.getChildCreationSchema({ type: DeviceType.Camera, integrationId: 'hub-1' }),
    ).toBeNull()
    expect(await addon.getManualCreationType({ integrationId: 'hub-1' })).toEqual({
      deviceType: null,
    })
  })

  it('the default integration, or no integration at all, keeps the creation form', async () => {
    for (const integrationId of ['default-1', undefined]) {
      const schema = await addon.getChildCreationSchema({ type: DeviceType.Camera, integrationId })
      expect(keysOf(schema)).toContain('host')
      expect(await addon.getManualCreationType({ integrationId })).toEqual({
        deviceType: DeviceType.Camera,
      })
    }
  })

  it('integrationIsHub reads the registry evidence and the record', async () => {
    const instances = { getResolved: async () => null }
    const hub = { registryEvidenceOf: async () => ({ originStableId: 'reolink-hub-x', info: {} }) }
    const plain = { registryEvidenceOf: async () => ({ info: {} }) }
    const unknown = { registryEvidenceOf: async () => null }
    expect(await integrationIsHub(instances, hub, 'i')).toBe(true)
    expect(await integrationIsHub(instances, plain, 'i')).toBe(false)
    expect(await integrationIsHub(instances, unknown, 'i')).toBe(false)
  })
})
