/**
 * Templates of the `device-integration` scaffold (D1007, D996, D865): an addon whose integration
 * is a typed instance record (connection + secret + test) and which brings devices. The
 * integration's Gateway device is a SIBLING of the devices it brings, never their parent.
 */

export const DEVICE_INSTANCES_TS = `/**
 * <%= displayName %> integrations as \`integration-instances\` (D1007): one \`connections\` record per
 * integration, keyed by the registry id, holding the connection to ONE <%= displayName %> system. The
 * token is a secret by TYPE; the records door keeps it in the keychain. The Gateway device is not
 * part of the record: it is a device OF the integration, adopted from it.
 */
import {
  type ConfigUISchema,
  defineEntryKind,
  entryBody,
  type IntegrationTestConnectionResult,
  RecordIntegrationInstances,
  type RecordsAccess,
} from '@camstack/types'
import { z } from 'zod'

export const <%= className %>ConnectionsKind = defineEntryKind('connections', {
  title: '<%= displayName %> integrations',
  schema: entryBody({
    host: z.string().optional(),
    token: z.string().optional().meta({ secret: true }),
  }),
  writeTrigger: 'an operator adds, edits or removes a <%= displayName %> integration',
})
export type <%= className %>ConnectionBody = z.infer<typeof <%= className %>ConnectionsKind.schema>

/** Every record kind this addon declares, keyed by its name. */
export const <%= className %>RecordKinds = { connections: <%= className %>ConnectionsKind } as const

export function build<%= className %>ConnectionForm(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'connection',
        title: 'Connection',
        columns: 1,
        fields: [
          { type: 'text', key: 'name', label: 'Name' },
          { type: 'text', key: 'host', label: 'Host' },
          { type: 'password', key: 'token', label: 'Token', showToggle: true },
        ],
      },
    ],
  }
}

export interface <%= className %>InstanceDeps {
  /** Re-apply the runtime from the records after a create, update, enable or delete. */
  readonly onChanged: () => Promise<void>
  /** Probe the remote with the (possibly unsaved) values; a failed probe is not a pass. */
  readonly probe: (values: Readonly<Record<string, unknown>>) => Promise<IntegrationTestConnectionResult>
}

export function build<%= className %>Instances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: <%= className %>InstanceDeps,
): RecordIntegrationInstances<<%= className %>ConnectionBody> {
  return new RecordIntegrationInstances<<%= className %>ConnectionBody>(
    records,
    <%= className %>ConnectionsKind,
    {
      description: {
        role: 'devices',
        discovery: { mode: 'account', scopedToInstance: true },
        instanceMode: 'multiple',
        kind: 'server',
        canTest: true,
        // The one kind this provider serves; its functionCap is the cap an instance of it feeds.
        kinds: [{ id: 'server', label: '<%= displayName %>', functionCap: 'device-provider', role: 'devices' }],
      },
      formSchema: () => build<%= className %>ConnectionForm(),
      initialBody: (name): <%= className %>ConnectionBody => ({ name }),
      configured: (body) => (body.host ?? '').length > 0,
      onChanged: () => deps.onChanged(),
      test: ({ values }) => deps.probe(values),
    },
  )
}
`

export const DEVICE_DEVICES_TS = `/**
 * The devices of an integration. Every one carries its \`integrationId\` in its persisted config, so
 * a cascade can find what an integration owns. The Gateway is the integration's own presence in the
 * device list and a SIBLING of the sensors: nothing is its child.
 *
 * Per-device configuration lives ONLY in \`ctx.settings.*DeviceStore\`, never in a field of the
 * addon's own storage (D865).
 */
import { BaseDevice, type DeviceContext, type DeviceFeature, DeviceType } from '@camstack/types'
import { z } from 'zod'

export const <%= className %>_SYSTEM = '<%= fileName %>'
export const <%= className %>_GATEWAY_ID = 'gateway'

export const <%= className %>GatewaySchema = z.object({
  equipment: z.literal(<%= className %>_GATEWAY_ID),
  integrationId: z.string().min(1).describe('Owning integration'),
  system: z.literal(<%= className %>_SYSTEM).optional(),
})

export class <%= className %>GatewayDevice extends BaseDevice<typeof <%= className %>GatewaySchema> {
  readonly features: readonly DeviceFeature[] = []

  constructor(ctx: DeviceContext) {
    <%= className %>GatewaySchema.parse(ctx.persistedConfig ?? {})
    super(ctx, <%= className %>GatewaySchema, { type: DeviceType.Gateway })
  }
}

export const <%= className %>SensorSchema = z.object({
  equipment: z.string().min(1).describe('Remote id of the sensor'),
  integrationId: z.string().min(1).describe('Owning integration'),
  system: z.literal(<%= className %>_SYSTEM).optional(),
})

export class <%= className %>SensorDevice extends BaseDevice<typeof <%= className %>SensorSchema> {
  readonly features: readonly DeviceFeature[] = []

  constructor(ctx: DeviceContext) {
    <%= className %>SensorSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, <%= className %>SensorSchema, { type: DeviceType.Sensor })
  }
}
`

export const DEVICE_ADOPTION_TS = `/**
 * Discovery and adoption for <%= displayName %>. The Gateway and every sensor are offered as
 * SIBLING candidates (the Gateway is never the parent of the sensors); adopting one creates a
 * top-level device carrying the integration id. Replace \`discover\` with a real read of the remote.
 */
import {
  DeviceType,
  type DiscoveredChildDevice,
  errMsg,
  type IDeviceAdoptionProvider,
  type IScopedLogger,
} from '@camstack/types'
import { <%= className %>_GATEWAY_ID } from './<%= fileName %>-devices.js'

export interface RemoteSensor {
  readonly id: string
  readonly name: string
}

export interface <%= className %>AdoptionDeps {
  readonly hasIntegration: (integrationId: string) => Promise<boolean>
  readonly listIntegrations: () => Promise<readonly string[]>
  /** What the remote reports for the integration, or null while it is unreachable. */
  readonly discover: (integrationId: string) => Promise<readonly RemoteSensor[] | null>
  /** Remote ids of the devices already adopted for the integration, with their device id. */
  readonly adopted: (integrationId: string) => Promise<ReadonlyMap<string, number>>
  readonly create: (input: {
    readonly integrationId: string
    readonly equipment: string
    readonly type: DeviceType.Gateway | DeviceType.Sensor
    readonly name: string
  }) => Promise<number>
  readonly remove: (deviceId: number) => Promise<void>
  readonly logger: IScopedLogger
}

export function build<%= className %>AdoptionProvider(
  deps: <%= className %>AdoptionDeps,
): IDeviceAdoptionProvider {
  async function candidates(integrationId: string): Promise<readonly DiscoveredChildDevice[]> {
    const sensors = await deps.discover(integrationId)
    const adopted = await deps.adopted(integrationId)
    const offered: DiscoveredChildDevice[] = [
      {
        childNativeId: <%= className %>_GATEWAY_ID,
        name: '<%= displayName %>',
        type: DeviceType.Gateway,
        status: sensors === null ? 'offline' : 'online',
        metadata: {},
        alreadyAdopted: adopted.has(<%= className %>_GATEWAY_ID),
        adoptedDeviceId: adopted.get(<%= className %>_GATEWAY_ID) ?? null,
        capabilities: [],
      },
    ]
    for (const sensor of sensors ?? []) {
      offered.push({
        childNativeId: sensor.id,
        name: sensor.name,
        type: DeviceType.Sensor,
        status: 'online',
        metadata: {},
        alreadyAdopted: adopted.has(sensor.id),
        adoptedDeviceId: adopted.get(sensor.id) ?? null,
        capabilities: [],
      })
    }
    return offered
  }

  async function status(integrationId: string) {
    const all = await candidates(integrationId)
    return {
      lastDiscoveryAt: Date.now(),
      candidateCount: all.length,
      adoptedCount: all.filter((c) => c.alreadyAdopted).length,
      lastError: null,
    }
  }

  return {
    listCandidateFilters: async () => ({
      filters: [{ id: 'devices', label: 'Devices', isDefault: true }],
    }),
    listCandidates: async ({ integrationId, page, pageSize }) => {
      const all = await candidates(integrationId)
      const start = (page - 1) * pageSize
      return {
        candidates: all.slice(start, start + pageSize),
        totalCount: all.length,
        page,
        pageSize,
      }
    },
    getCandidate: async ({ integrationId, childNativeId }) =>
      (await candidates(integrationId)).find((c) => c.childNativeId === childNativeId) ?? null,
    getStatus: async () => {
      try {
        let candidateCount = 0
        let adoptedCount = 0
        for (const integrationId of await deps.listIntegrations()) {
          const s = await status(integrationId)
          candidateCount += s.candidateCount
          adoptedCount += s.adoptedCount
        }
        return { lastDiscoveryAt: Date.now(), candidateCount, adoptedCount, lastError: null }
      } catch (err: unknown) {
        return { lastDiscoveryAt: null, candidateCount: 0, adoptedCount: 0, lastError: errMsg(err) }
      }
    },
    refresh: async ({ integrationId }) => status(integrationId),
    adopt: async ({ integrationId, childNativeIds, perCandidate }) => {
      if (!(await deps.hasIntegration(integrationId))) {
        throw new Error('<%= fileName %> adopt: integration ' + integrationId + ' not found')
      }
      const offered = await candidates(integrationId)
      const adopted: Array<{
        readonly childNativeId: string
        readonly parentDeviceId: number
        readonly accessoryDeviceIds: readonly number[]
      }> = []
      for (const childNativeId of childNativeIds) {
        const candidate = offered.find((c) => c.childNativeId === childNativeId)
        if (candidate === undefined) {
          deps.logger.warn('<%= fileName %> adopt: the remote reports nothing for this id', {
            meta: { childNativeId, integrationId },
          })
          continue
        }
        const deviceId = await deps.create({
          integrationId,
          equipment: childNativeId,
          type: candidate.type === DeviceType.Gateway ? DeviceType.Gateway : DeviceType.Sensor,
          name: perCandidate?.[childNativeId]?.name ?? candidate.name,
        })
        adopted.push({ childNativeId, parentDeviceId: deviceId, accessoryDeviceIds: [] })
      }
      if (adopted.length === 0) throw new Error('<%= fileName %> adopt: nothing was adopted')
      return { adopted }
    },
    release: async ({ camDeviceId }) => {
      await deps.remove(camDeviceId)
    },
    resync: async () => ({ changed: false, rebuiltChildren: 0 }),
  }
}
`

export const DEVICE_ADDON_TS = `/**
 * <%= displayName %> — a device integration (role \`devices\`, D996). An integration is one typed
 * connection record (secret + test) served through \`integration-instances\`; the devices it brings
 * are adopted from it and carry its \`integrationId\`. There is no addon-level settings page and no
 * legacy settings row: if the operator can configure it, it is an instance.
 *
 * Deleting a device is learned through \`device-removal-hook\` (a tombstone, D865), never from the
 * device missing from a list. A failed read of the remote changes nothing (D49).
 */
import {
  type AddonInitResult,
  BaseDeviceProvider,
  type ConfigUISchema,
  type CreateDeviceSpec,
  type DeviceConstructor,
  DeviceType,
  deviceAdoptionCapability,
  deviceRemovalHookCapability,
  type IDevice,
  type IntegrationTestConnectionResult,
  integrationInstancesCapability,
  type RecordIntegrationInstances,
} from '@camstack/types'
import { build<%= className %>AdoptionProvider } from './<%= fileName %>-adoption.js'
import {
  <%= className %>_SYSTEM,
  <%= className %>GatewayDevice,
  <%= className %>SensorDevice,
} from './<%= fileName %>-devices.js'
import {
  build<%= className %>Instances,
  <%= className %>RecordKinds,
  type <%= className %>ConnectionBody,
} from './<%= fileName %>-instances.js'

export class <%= className %>Addon extends BaseDeviceProvider {
  protected readonly addonId = '<%= fileName %>'
  protected readonly providerName = '<%= displayName %>'
  // The Gateway and the sensors are siblings: both are restored as top-level devices.
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Gateway]: <%= className %>GatewayDevice,
    [DeviceType.Sensor]: <%= className %>SensorDevice,
  }

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<AddonInitResult> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('<%= fileName %>: ctx.records is required (hub-only addon)')
    }
    await records.declare(<%= className %>RecordKinds)
    const instances = build<%= className %>Instances(records, {
      onChanged: async () => {
        this.ctx.logger.info('<%= displayName %> integrations changed')
      },
      probe: (values) => this.probe(values),
    })
    return {
      providers: [
        ...regs,
        { capability: deviceAdoptionCapability, provider: this.buildAdoptionProvider(instances) },
        { capability: integrationInstancesCapability, provider: instances.toProvider() },
        {
          capability: deviceRemovalHookCapability,
          // Device DATA only (footage, history, rows). Settings are cleared centrally. Idempotent.
          provider: {
            onDeviceRemoved: async () => ({ counts: {} }),
            listDeviceData: async () => [],
          },
        },
      ],
    }
  }

  /** Replace with a real call to the remote; \`rejected\` is a definite no, \`inconclusive\` is "could not tell". */
  private async probe(
    values: Readonly<Record<string, unknown>>,
  ): Promise<IntegrationTestConnectionResult> {
    const host = values['host']
    if (typeof host !== 'string' || host.length === 0) {
      return { success: false, status: 'rejected', error: 'Host is required' }
    }
    return { success: true, status: 'validated' }
  }

  private buildAdoptionProvider(
    instances: RecordIntegrationInstances<<%= className %>ConnectionBody>,
  ) {
    return build<%= className %>AdoptionProvider({
      hasIntegration: async (integrationId) => (await instances.readResolved(integrationId)) !== null,
      listIntegrations: async () => (await instances.listResolved()).map((read) => read.id),
      discover: async (integrationId) => {
        const read = await instances.readResolved(integrationId)
        if (read === null) return null
        // Replace with a real read of the remote using read.body (host, token).
        return []
      },
      adopted: async (integrationId) => {
        const reg = this.ctx.kernel.deviceRegistry
        const devices = this.ctx.kernel.devices
        const out = new Map<string, number>()
        if (!reg || !devices) return out
        for (const d of reg.getAllForAddon(this.addonId)) {
          const config = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
          if (config['integrationId'] !== integrationId) continue
          const equipment = config['equipment']
          if (typeof equipment === 'string') out.set(equipment, d.id)
        }
        return out
      },
      create: async ({ integrationId, equipment, type, name }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('<%= fileName %> adopt: kernel.devices unavailable')
        const config = { equipment, integrationId, system: <%= className %>_SYSTEM }
        const stableId = this.generateStableId(type, config)
        const meta = { type, name, integrationId }
        const device =
          type === DeviceType.Gateway
            ? await devices.create(stableId, <%= className %>GatewayDevice, config, null, meta)
            : await devices.create(stableId, <%= className %>SensorDevice, config, null, meta)
        return device.id
      },
      remove: async (id) => {
        await this.ctx.kernel.devices?.remove(id)
      },
      logger: this.ctx.logger,
    })
  }

  protected override generateStableId(
    _type: DeviceType,
    config?: Record<string, unknown>,
  ): string {
    const integrationId = config?.['integrationId']
    const equipment = config?.['equipment']
    if (typeof integrationId !== 'string' || integrationId.length === 0) {
      throw new Error('<%= fileName %> generateStableId: integrationId required')
    }
    if (typeof equipment !== 'string' || equipment.length === 0) {
      throw new Error('<%= fileName %> generateStableId: equipment required')
    }
    return '<%= fileName %>:' + integrationId + ':' + equipment
  }

  override async supportsManualCreation(): Promise<boolean> {
    return false
  }

  protected async onGetCreationSchema(_type: DeviceType): Promise<ConfigUISchema | null> {
    return null
  }

  protected async onCreateDevice(
    _type: DeviceType,
    _config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    throw new Error('<%= displayName %> devices are adopted from the integration')
  }
}

export default <%= className %>Addon
`
