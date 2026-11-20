/**
 * Reolink integrations as `integration-instances` (planning#416, D985, D1007): one `connections`
 * record per integration under its registry id. The default integration (standalone cameras) holds
 * a name only; an NVR / Home Hub integration also holds its connection, the password a keychain
 * secret declared in the schema. The integrations registry owns the on/off switch (`role: devices`).
 */
import {
  type ConfigUISchema,
  defineEntryKind,
  entryBody,
  type IntegrationInstance,
  type IntegrationTestConnectionResult,
  linkFieldDescriptor,
  REDACTED_SECRET,
  RecordIntegrationInstances,
  type RecordsAccess,
  type ResolvedInstance,
} from '@camstack/types'
import { z } from 'zod'
import { MAILBOX_LINK_FIELD, mailboxLinkField, SMTP_MAILBOX_LINK } from './email-push-bridge.js'
import {
  buildHubInstanceSchema,
  type HubConnectionRead,
  isHubIntegration,
  readHubConnection,
} from './hub-connection.js'
import { type ReolinkHubProbeFactory, testReolinkHubConnection } from './reolink-connection-test.js'
import type { HubIntegrationConnection } from './reolink-hub-manager.js'
import { ReolinkSocketDebugFlagSchema } from './schema.js'

export const ReolinkConnectionBodySchema = entryBody({
  host: z.string().nullish(),
  port: z.number().int().min(1).max(65535).nullish(),
  rtspPort: z.number().int().min(1).max(65535).nullish(),
  username: z.string().nullish(),
  password: z.string().optional().meta({ secret: true }),
  transport: z.enum(['tcp', 'udp']).nullish(),
  uid: z.string().nullish(),
  model: z.string().nullish(),
  debugGeneral: z.boolean().nullish(),
  debugSocketLogs: z.array(ReolinkSocketDebugFlagSchema).nullish(),
  // The camera mailbox the DEFAULT integration's standalone cameras mail (a link, D1013). The
  // bridge fills it; empty or absent on a hub integration and while no camera uses a mailbox.
  mailboxId: mailboxLinkField(),
})
export type ReolinkConnectionBody = z.infer<typeof ReolinkConnectionBodySchema>

export const reolinkConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Reolink integrations',
  schema: ReolinkConnectionBodySchema,
  writeTrigger: 'an operator adds, edits or removes a Reolink integration',
})

/** The kind of the default integration (standalone cameras): a name and the mailbox link, no Test. */
export const REOLINK_DEFAULT_KIND = 'default'
/** The kind of an NVR / Home Hub integration: its connection, with a Test. */
export const REOLINK_HUB_KIND = 'connection'

/** The form of the default integration: which camera mailbox its standalone cameras use. */
export function buildDefaultInstanceSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'mailbox',
        title: 'Camera mailbox',
        titleKey: 'provider-reolink:connection.s_mailbox.title',
        description: 'The mailbox the standalone cameras send their email push to.',
        descriptionKey: 'provider-reolink:connection.s_mailbox.description',
        columns: 1,
        fields: [
          {
            ...linkFieldDescriptor(MAILBOX_LINK_FIELD, SMTP_MAILBOX_LINK, {
              label: 'Camera mailbox',
              required: false,
            }),
            labelKey: 'provider-reolink:connection.s_mailbox.mailboxId.label',
          },
        ],
      },
    ],
  }
}

/** Every kind this addon declares, keyed by its name. */
export const reolinkRecordKinds = {
  connections: reolinkConnectionsEntryKind,
} as const

/** The registry facts that tell a hub integration from the default one. */
export interface ReolinkRegistryEvidence {
  readonly originStableId?: string | undefined
  readonly info: Readonly<Record<string, unknown>>
}

/**
 * What the addon last learned of each integration's registry row. The request path
 * (`listInstances` / `getInstance`) reads ONLY this — the hub's own `integrations.get` projects
 * the switches by calling this provider's `listInstances` again, so asking the hub from there is
 * an unbounded call cycle. It is filled off the request path (the integration reconcile, the
 * form schema read); a failed read leaves it as it was.
 */
export class ReolinkEvidenceCache {
  private readonly rows = new Map<string, ReolinkRegistryEvidence>()

  get(id: string): ReolinkRegistryEvidence | null {
    return this.rows.get(id) ?? null
  }

  set(id: string, evidence: ReolinkRegistryEvidence): void {
    this.rows.set(id, evidence)
  }

  /** The registry's full answer for this addon: integrations it no longer lists are dropped. */
  replaceAll(entries: ReadonlyArray<readonly [string, ReolinkRegistryEvidence]>): void {
    this.rows.clear()
    for (const [id, evidence] of entries) this.rows.set(id, evidence)
  }
}

export interface ReolinkInstancesDeps {
  /** Bring the hub sessions in line with the records after a change. */
  readonly onChanged: () => Promise<void>
  /** The registry row of an integration; null when the registry does not know it. */
  readonly registryEvidenceOf: (id: string) => Promise<ReolinkRegistryEvidence | null>
  /** The Baichuan session the connection test logs in with. */
  readonly makeHubProbe: ReolinkHubProbeFactory
}

/**
 * The connection test: the stored hub under the edited form. A saved password is never retyped
 * (the form hands back its redacted view), so the keychain value stands in.
 */
async function testReolinkInstance(
  records: Pick<RecordsAccess, 'kind'>,
  deps: Pick<ReolinkInstancesDeps, 'makeHubProbe'>,
  input: { readonly id: string | null; readonly values: Readonly<Record<string, unknown>> },
): Promise<IntegrationTestConnectionResult> {
  const handle = records.kind(reolinkConnectionsEntryKind)
  const stored = input.id === null ? null : ((await handle.getResolved(input.id))?.data ?? null)
  const typed = input.values['password']
  const password =
    typeof typed === 'string' && typed !== '' && typed !== REDACTED_SECRET
      ? typed
      : stored?.password
  const merged: Record<string, unknown> = {}
  for (const [key, value] of Object.entries({ ...stored, ...input.values, password })) {
    if (key === 'name' || value === null || value === undefined) continue
    merged[key] = value
  }
  const read = readHubConnection(merged)
  switch (read.kind) {
    case 'no-host':
      return {
        success: false,
        status: 'inconclusive',
        error:
          'reolink: no NVR / Home Hub host on this integration — standalone cameras are tested one by one when they are added',
      }
    case 'no-password':
      return {
        success: false,
        status: 'rejected',
        error: 'reolink: enter the NVR / Home Hub password',
      }
    case 'password-locked':
      return {
        success: false,
        status: 'inconclusive',
        error: 'reolink: the stored password cannot be read right now (keychain unavailable)',
      }
    case 'ok':
      return testReolinkHubConnection(read.connection, deps.makeHubProbe)
  }
}

/** The record body as the connection form's flat values: no name, no unset keys. */
export function hubSettingsOf(body: ReolinkConnectionBody): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (key === 'name' || value === null || value === undefined) continue
    out[key] = value
  }
  return out
}

/**
 * What a resolved record says about its hub. A keychain that is locked yields a record WITHOUT
 * its password: that is `password-locked`, never an empty password (D49).
 */
export function hubConnectionOf(
  resolved: ResolvedInstance<ReolinkConnectionBody>,
): HubConnectionRead {
  const read = readHubConnection(hubSettingsOf(resolved.body))
  return read.kind === 'no-password' && resolved.secrets === 'unavailable'
    ? { kind: 'password-locked' }
    : read
}

/**
 * What each enabled integration's RECORD says about its hub: the one reader of the connection.
 * A record that is absent reads as `no-host` (no session), exactly as an empty settings blob did.
 */
export async function readHubConnections(
  instances: Pick<RecordIntegrationInstances<ReolinkConnectionBody>, 'readResolved'>,
  integrations: readonly { readonly id: string; readonly name: string }[],
): Promise<readonly HubIntegrationConnection[]> {
  const out: HubIntegrationConnection[] = []
  for (const integration of integrations) {
    const resolved = await instances.readResolved(integration.id)
    out.push({
      id: integration.id,
      name: integration.name,
      read: resolved === null ? { kind: 'no-host' } : hubConnectionOf(resolved),
    })
  }
  return out
}

export function buildReolinkInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: ReolinkInstancesDeps,
): RecordIntegrationInstances<ReolinkConnectionBody> {
  const instances = new RecordIntegrationInstances<ReolinkConnectionBody>(
    records,
    reolinkConnectionsEntryKind,
    {
      description: {
        role: 'devices',
        discovery: { mode: 'lan', scopedToInstance: false },
        instanceMode: 'multiple',
        kind: 'connection',
        canTest: true,
        kinds: [
          {
            id: REOLINK_DEFAULT_KIND,
            label: 'Reolink standalone cameras',
            functionCap: 'device-provider',
            role: 'devices',
            canTest: false,
            creatable: false,
          },
          {
            id: REOLINK_HUB_KIND,
            label: 'Reolink NVR / Home Hub',
            functionCap: 'device-provider',
            role: 'devices',
            canTest: true,
          },
        ],
        // Only the default integration's standalone cameras mail the mailbox.
        links: [{ kind: REOLINK_DEFAULT_KIND, field: MAILBOX_LINK_FIELD, to: SMTP_MAILBOX_LINK }],
      },
      // The record alone cannot tell the default from a hub; the provider's registry evidence does
      // (`reolinkInstancesProvider`), and an instance it knows nothing about is a connection.
      kindOf: () => REOLINK_HUB_KIND,
      formSchema: () => buildHubInstanceSchema(),
      initialBody: (name): ReolinkConnectionBody => ({ name }),
      configured: (body) => (body.host ?? '').length === 0 || (body.password ?? '').length > 0,
      onChanged: () => deps.onChanged(),
      test: (input) => testReolinkInstance(records, deps, input),
    },
  )
  return instances
}

/**
 * The provider handed to the hub: the default integration (no connection) shows no hub form, an
 * NVR / Home Hub one does, and a create wizard (no id yet) sets up a hub.
 */
export function reolinkInstancesProvider(
  instances: Pick<RecordIntegrationInstances<ReolinkConnectionBody>, 'toProvider' | 'getResolved'>,
  deps: Pick<ReolinkInstancesDeps, 'registryEvidenceOf'> & {
    readonly evidenceCache: Pick<ReolinkEvidenceCache, 'get' | 'set'>
  },
): ReturnType<RecordIntegrationInstances<ReolinkConnectionBody>['toProvider']> {
  const base = instances.toProvider()
  // What Add device offers is decided per instance, by the same rule as `integrationIsHub`: the
  // default integration holds standalone cameras (a scan adds more of them); an NVR / Home Hub
  // integration adopts only its own children (a scan there would offer other hosts, which are new
  // integrations).
  const withAddDevice = async (instance: IntegrationInstance): Promise<IntegrationInstance> => {
    const isHub = await integrationIsHubCached(instances, deps.evidenceCache, instance.id)
    // The default kind only for an integration the registry named and that is no hub: a hub with
    // a missing host stays testable, and so does one nothing is known about yet.
    const known = deps.evidenceCache.get(instance.id) !== null
    return {
      ...instance,
      kind: known && !isHub ? REOLINK_DEFAULT_KIND : REOLINK_HUB_KIND,
      addDevice: isHub ? 'children' : 'scan',
    }
  }
  return {
    ...base,
    listInstances: async (input) =>
      Promise.all((await base.listInstances(input)).map(withAddDevice)),
    getInstance: async (input) => {
      const found = await base.getInstance(input)
      return found === null ? null : withAddDevice(found)
    },
    instanceFormSchema: async ({ id }) => {
      if (id === null) return buildHubInstanceSchema()
      const [evidence, body] = await Promise.all([
        deps.registryEvidenceOf(id),
        instances.getResolved(id),
      ])
      if (evidence !== null) deps.evidenceCache.set(id, evidence)
      const isHub =
        evidence !== null &&
        isHubIntegration({
          originStableId: evidence.originStableId,
          info: evidence.info,
          settings: body === null ? {} : hubSettingsOf(body),
        })
      return isHub || body === null ? buildHubInstanceSchema() : buildDefaultInstanceSchema()
    },
  }
}

/**
 * Whether an integration IS one NVR / Home Hub (its devices come from the hub, so there is no
 * manual add by IP). An integration the registry cannot name is not a hub for this question.
 */
export async function integrationIsHub(
  instances: Pick<RecordIntegrationInstances<ReolinkConnectionBody>, 'getResolved'>,
  deps: Pick<ReolinkInstancesDeps, 'registryEvidenceOf'>,
  id: string,
): Promise<boolean> {
  const [evidence, body] = await Promise.all([
    deps.registryEvidenceOf(id),
    instances.getResolved(id),
  ])
  if (evidence === null) return false
  return isHubIntegration({
    originStableId: evidence.originStableId,
    info: evidence.info,
    settings: body === null ? {} : hubSettingsOf(body),
  })
}

/**
 * `integrationIsHub` from the cache alone, for the request path: no evidence yet reads as "not a
 * hub" (the same answer as a registry that cannot name the integration) and never asks the hub.
 */
export async function integrationIsHubCached(
  instances: Pick<RecordIntegrationInstances<ReolinkConnectionBody>, 'getResolved'>,
  cache: Pick<ReolinkEvidenceCache, 'get'>,
  id: string,
): Promise<boolean> {
  const evidence = cache.get(id)
  if (evidence === null) return false
  const body = await instances.getResolved(id)
  return isHubIntegration({
    originStableId: evidence.originStableId,
    info: evidence.info,
    settings: body === null ? {} : hubSettingsOf(body),
  })
}
