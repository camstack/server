/**
 * Templates of the `exporter` scaffold (D1009, D996): every exporter is multi-instance. An export
 * target is an integration INSTANCE (role `services`, `instanceMode: 'multiple'`), its id is MINTED,
 * and what is exposed is keyed by that instance id. A target's actions are \`addon-action-button\`
 * fields of its own form. Pattern: the Home Assistant export targets.
 */

export const EXPORTER_INSTANCES_TS = `/**
 * <%= displayName %> export targets as \`integration-instances\` (D1009): one \`targets\` record per
 * target, with a MINTED id (\`<%= fileName %>_001\`, ...). The devices exported to a target are the
 * \`devices\` list of ITS record, so deleting the target deletes the exposure and two targets never
 * share one.
 */
import {
  type ConfigUISchema,
  defineEntryKind,
  entryBody,
  type IntegrationTestConnectionResult,
  RecordIntegrationInstances,
  type RecordsAccess,
  isInstanceEnabled,
} from '@camstack/types'
import { z } from 'zod'

export const <%= className %>_TARGET_KIND = '<%= fileName %>-target'
export const <%= className %>_ID_PREFIX = '<%= fileName %>_'

export const <%= className %>TargetsKind = defineEntryKind('targets', {
  title: '<%= displayName %> export targets',
  schema: entryBody({
    endpoint: z.string().optional(),
    token: z.string().optional().meta({ secret: true }),
    devices: z.array(z.string()).optional(),
    /** The target's own switch (D996). Absent means on. */
    enabled: z.boolean().optional(),
  }),
  writeTrigger: 'an operator adds, edits, switches or deletes a target, or exports a device to it',
})
export type <%= className %>TargetBody = z.infer<typeof <%= className %>TargetsKind.schema>

/** Every record kind this addon declares, keyed by its name. */
export const <%= className %>RecordKinds = { targets: <%= className %>TargetsKind } as const

/** The next free minted id given the ids that exist (\`<%= fileName %>_001\`, \`<%= fileName %>_002\`, ...). */
export function next<%= className %>TargetId(existing: Iterable<string>): string {
  let highest = 0
  for (const id of existing) {
    if (!id.startsWith(<%= className %>_ID_PREFIX)) continue
    const n = Number(id.slice(<%= className %>_ID_PREFIX.length))
    if (Number.isInteger(n) && n > highest) highest = n
  }
  return <%= className %>_ID_PREFIX + String(highest + 1).padStart(3, '0')
}

export function build<%= className %>TargetForm(addonId: string): ConfigUISchema {
  return {
    sections: [
      {
        id: 'target',
        title: 'Target',
        columns: 1,
        fields: [
          { type: 'text', key: 'name', label: 'Name' },
          { type: 'text', key: 'endpoint', label: 'Endpoint' },
          { type: 'password', key: 'token', label: 'Token', showToggle: true },
          {
            type: 'addon-action-button',
            addonId,
            key: '__resync',
            label: 'Re-announce',
            buttonLabel: 'Push every exposed device now',
            action: 'resync',
            paramsFromForm: { endpoint: 'endpoint' },
          },
        ],
      },
    ],
  }
}

export interface <%= className %>TargetDeps {
  /** The ids of the targets that exist now; read per call, a minted id never reuses one. */
  readonly ids: () => readonly string[]
  /** Runs after every change; reload the exposure from the records. */
  readonly onChanged: (id: string) => Promise<void>
  readonly probe: (values: Readonly<Record<string, unknown>>) => Promise<IntegrationTestConnectionResult>
}

export function open<%= className %>Targets(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: <%= className %>TargetDeps,
): RecordIntegrationInstances<<%= className %>TargetBody> {
  return new RecordIntegrationInstances<<%= className %>TargetBody>(
    records,
    <%= className %>TargetsKind,
    {
      description: {
        role: 'services',
        instanceMode: 'multiple',
        kind: 'target',
        canTest: true,
        // The one kind this provider serves; kindOf below stamps it on every instance.
        kinds: [{ id: <%= className %>_TARGET_KIND, label: '<%= displayName %>', functionCap: 'device-export', role: 'services' }],
      },
      formSchema: () => build<%= className %>TargetForm('<%= fileName %>'),
      initialBody: (name): <%= className %>TargetBody => ({ name, devices: [] }),
      mintId: () => next<%= className %>TargetId(deps.ids()),
      kindOf: () => <%= className %>_TARGET_KIND,
      // A target without an endpoint is unconfigured: it pushes nothing and KEEPS its devices.
      configured: (body) => (body.endpoint ?? '').length > 0,
      onChanged: (id) => deps.onChanged(id),
      test: ({ values }) => deps.probe(values),
    },
  )
}
`

export const EXPORTER_ADDON_TS = `/**
 * <%= displayName %> - an exporter (\`device-export\` + \`integration-instances\`, D1009). Every
 * exporter is multi-instance: each target is an instance with a minted id, and a membership change
 * ALWAYS names the target it changes. Exposure is the \`devices\` list of the target's record, keyed
 * by the instance id; an id this addon does not serve is refused by name, never answered empty.
 */
import {
  type AddonInitResult,
  BaseAddon,
  customAction,
  defineCustomActions,
  deviceExportCapability,
  deviceExportStatusInstanceOf,
  ExportInstanceUnknownError,
  exposedNameStoreOf,
  freeTextNameValidator,
  type IDeviceExportProvider,
  type IntegrationTestConnectionResult,
  integrationInstancesCapability,
  type RecordKindHandle,
  saveExposedName,
} from '@camstack/types'
import { z } from 'zod'
import {
  open<%= className %>Targets,
  <%= className %>_TARGET_KIND,
  <%= className %>RecordKinds,
  <%= className %>TargetsKind,
  type <%= className %>TargetBody,
} from './<%= fileName %>-instances.js'

const <%= className %>Actions = defineCustomActions({
  resync: customAction(
    z.object({ endpoint: z.string().optional() }),
    z.object({ summary: z.string() }),
    { kind: 'mutation', auth: 'admin' },
  ),
})

/** The device kinds this exporter can carry; the device picker filters on it. */
const SUPPORTED_DEVICE_KINDS: readonly string[] = ['sensor', 'switch', 'light']

export class <%= className %>Addon extends BaseAddon<Readonly<Record<string, never>>> {
  private targets: RecordKindHandle<<%= className %>TargetBody> | null = null
  /** Target id to its record body; reloaded from the records after every change. */
  private book = new Map<string, <%= className %>TargetBody>()

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<AddonInitResult> {
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('<%= fileName %>: ctx.records is required (hub-only addon)')
    }
    await records.declare(<%= className %>RecordKinds)
    this.targets = records.kind(<%= className %>TargetsKind)
    const instances = open<%= className %>Targets(records, {
      ids: () => [...this.book.keys()],
      onChanged: () => this.reload(),
      probe: (values) => this.probe(values),
    })
    await this.reload()
    return {
      providers: [
        { capability: deviceExportCapability, provider: this.buildExportProvider() },
        { capability: integrationInstancesCapability, provider: instances.toProvider() },
      ],
      customActions: <%= className %>Actions,
      actionHandlers: {
        resync: async () => {
          await this.reload()
          return { summary: 'Re-announced ' + this.book.size + ' target(s).' }
        },
      },
    }
  }

  /** Reload every target from the records; the synchronous read the event path needs. */
  private async reload(): Promise<void> {
    const targets = this.targets
    if (targets === null) return
    const page = await targets.query({ limit: 1000 })
    this.book = new Map(page.records.map((row) => [row.id, row.data]))
  }

  /** The body of a target this addon serves, or the named refusal. */
  private target(instanceId: string): <%= className %>TargetBody {
    const body = this.book.get(instanceId)
    if (body === undefined) throw new ExportInstanceUnknownError(this.ctx.id, instanceId)
    return body
  }

  private async setMembership(
    instanceId: string,
    deviceId: string,
    exposed: boolean,
  ): Promise<void> {
    const body = this.target(instanceId)
    const current = new Set(body.devices ?? [])
    if (exposed) current.add(deviceId)
    else current.delete(deviceId)
    await this.targets?.patch(instanceId, { devices: [...current] })
    await this.reload()
  }

  private buildExportProvider(): IDeviceExportProvider {
    return {
      getStatus: async (input) => {
        const instanceId = deviceExportStatusInstanceOf(input)
        const bodies =
          instanceId === undefined ? [...this.book.values()] : [this.target(instanceId)]
        return {
          linkState: bodies.some((b) => (b.endpoint ?? '').length > 0) ? 'linked' : 'unlinked',
          exposedDeviceCount: new Set(bodies.flatMap((b) => b.devices ?? [])).size,
        }
      },
      listInstances: async () =>
        [...this.book.entries()].map(([instanceId, body]) => ({
          instanceId,
          name: body.name,
          enabled: isInstanceEnabled(body),
          kind: <%= className %>_TARGET_KIND,
        })),
      listSupportedDeviceKinds: async ({ instanceId }) => {
        if (instanceId !== undefined) this.target(instanceId)
        return [...SUPPORTED_DEVICE_KINDS]
      },
      listExposedDevices: async ({ instanceId }) => {
        const bodies =
          instanceId === undefined ? [...this.book.values()] : [this.target(instanceId)]
        return bodies.flatMap((b) => (b.devices ?? []).map((deviceId) => ({ deviceId })))
      },
      exposeDevice: async ({ instanceId, deviceId }) =>
        this.setMembership(instanceId, deviceId, true),
      unexposeDevice: async ({ instanceId, deviceId }) =>
        this.setMembership(instanceId, deviceId, false),
      // The device's name on this target (D1049): stored per instance in this addon's per-device
      // store, never part of the exported id. Replace the validator with the platform's rule.
      setExposedName: async ({ instanceId, deviceId, name }) => {
        this.target(instanceId)
        await saveExposedName({
          store: exposedNameStoreOf(this.ctx.settings, this.ctx.id),
          deviceId: Number(deviceId),
          instanceId,
          raw: name,
          validate: freeTextNameValidator('<%= displayName %>', 100),
        })
      },
    }
  }

  /** Replace with a real call to the remote; \`rejected\` is a definite no, \`inconclusive\` is "could not tell". */
  private async probe(
    values: Readonly<Record<string, unknown>>,
  ): Promise<IntegrationTestConnectionResult> {
    const endpoint = values['endpoint']
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      return { success: false, status: 'rejected', error: 'Endpoint is required' }
    }
    return { success: true, status: 'validated' }
  }
}

export default <%= className %>Addon
`
