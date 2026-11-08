/**
 * Templates of the `service-integration` scaffold (D1007, D996): an addon whose integration is a
 * typed connection plus a secret, with a test, and no devices of its own (role `services`).
 */

export const SERVICE_INSTANCES_TS = `/**
 * <%= displayName %> integrations as \`integration-instances\` (D1007): one \`connections\` record per
 * integration, keyed by the registry id. The API key is a secret by TYPE (\`.meta({ secret: true })\`),
 * so the records door keeps it in the keychain and deleting the row deletes the secret.
 * There is no addon-level settings page: everything an operator configures is an instance.
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
    baseUrl: z.string().optional(),
    apiKey: z.string().optional().meta({ secret: true }),
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
          { type: 'text', key: 'baseUrl', label: 'Base URL' },
          { type: 'password', key: 'apiKey', label: 'API key', showToggle: true },
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
        role: 'services',
        instanceMode: 'multiple',
        kind: 'server',
        canTest: true,
        // The one kind this provider serves; its functionCap is the cap an instance of it feeds.
        kinds: [{ id: 'server', label: '<%= displayName %>', functionCap: 'integration-instances', role: 'services' }],
      },
      formSchema: () => build<%= className %>ConnectionForm(),
      initialBody: (name): <%= className %>ConnectionBody => ({ name }),
      configured: (body) => (body.baseUrl ?? '').length > 0,
      onChanged: () => deps.onChanged(),
      test: ({ values }) => deps.probe(values),
    },
  )
}
`

export const SERVICE_ADDON_TS = `/**
 * <%= displayName %> — a service integration (role \`services\`, D996). It brings no devices: an
 * integration is one typed connection record, listed on the Integrations page, with a secret and a
 * Test button. Read the connection per use with \`instances.readResolved(id)\`; never keep a second
 * copy of it.
 */
import {
  type AddonInitResult,
  BaseAddon,
  errMsg,
  type IntegrationTestConnectionResult,
  integrationInstancesCapability,
  type RecordIntegrationInstances,
} from '@camstack/types'
import {
  build<%= className %>Instances,
  <%= className %>RecordKinds,
  type <%= className %>ConnectionBody,
} from './<%= fileName %>-instances.js'

export class <%= className %>Addon extends BaseAddon<Readonly<Record<string, never>>> {
  private instances: RecordIntegrationInstances<<%= className %>ConnectionBody> | null = null

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<AddonInitResult> {
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('<%= fileName %>: ctx.records is required (hub-only addon)')
    }
    await records.declare(<%= className %>RecordKinds)
    const instances = build<%= className %>Instances(records, {
      onChanged: () => this.applyInstances(),
      probe: (values) => this.probe(values),
    })
    this.instances = instances
    await this.applyInstances()
    return {
      providers: [
        { capability: integrationInstancesCapability, provider: instances.toProvider() },
      ],
    }
  }

  /** Re-apply the runtime from the records; called at boot and after every instance change. */
  private async applyInstances(): Promise<void> {
    const all = (await this.instances?.listResolved()) ?? []
    this.ctx.logger.info('<%= displayName %> integrations applied', {
      meta: { count: all.length },
    })
  }

  /** Replace with a real call to the remote; \`rejected\` is a definite no, \`inconclusive\` is "could not tell". */
  private async probe(
    values: Readonly<Record<string, unknown>>,
  ): Promise<IntegrationTestConnectionResult> {
    const baseUrl = values['baseUrl']
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
      return { success: false, status: 'rejected', error: 'Base URL is required' }
    }
    try {
      new URL(baseUrl)
      return { success: true, status: 'validated' }
    } catch (err: unknown) {
      return { success: false, status: 'rejected', error: errMsg(err) }
    }
  }
}

export default <%= className %>Addon
`
