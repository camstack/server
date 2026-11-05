/**
 * The generic binding of a service to a broker (D1011). A service (an integration today; a
 * notifier target, a calendar source or an exporter later) names the broker it runs through by id
 * and keeps only its OWN link settings: never a copy of the broker's host, sign-in or secrets,
 * which stay with the broker and are edited on the Brokers page.
 *
 * One primitive serves every consumer:
 *  - {@link declareBrokerLinkKind}: the record kind, body `{ name, brokerId, ...linkFields }`;
 *  - {@link buildBrokerLinkForm}: the form, a `broker-select` picker plus the service's link
 *    sections, which may be DYNAMIC (a list read from the chosen broker, like HA calendars);
 *  - {@link buildBrokerLinkInstances}: the `integration-instances` provider of an integration;
 *  - {@link resolveBrokerId} / {@link brokerLinkUserFinder}: which broker a record names and which
 *    records name a broker, so a delete of a broker still in use can name its users generically.
 */
import { z } from 'zod'
import type { ConfigUISchema } from '../interfaces/config-ui.js'
import { defineEntryKind, entryBody } from '../records/entry-kind.js'
import type { DefinedRecordKind } from '../records/record-kind.js'
import type { RecordsAccess } from '../records/records-access.js'
import type { BrokerUser, BrokerUserFinder } from './broker-in-use.js'
import { type InstanceChange, RecordIntegrationInstances } from './record-integration-instances.js'

/** The record kind an integration is stored under. */
export const BROKER_LINK_KIND_NAME = 'connections'

/** What every broker-linked record carries; link fields of the service come on top. */
export const BrokerLinkBodySchema = entryBody({ brokerId: z.string().min(1).optional() })
export type BrokerLinkBody = z.infer<typeof BrokerLinkBodySchema>

type FormSections = ConfigUISchema['sections']

interface BrokerLinkKindSpec {
  readonly title: string
  readonly writeTrigger: string
}

/**
 * Declare the record kind of a broker-linked service. `linkFields` are the service's OWN link
 * settings (its choice among what the broker offers); they must never repeat a field of the
 * broker's connection form nor be a secret (`check-integration-instances-declared`).
 */
export function declareBrokerLinkKind(
  spec: BrokerLinkKindSpec,
): DefinedRecordKind<typeof BrokerLinkBodySchema>
export function declareBrokerLinkKind<Shape extends z.ZodRawShape>(
  spec: BrokerLinkKindSpec & { readonly linkFields: Shape },
): DefinedRecordKind<ReturnType<typeof BrokerLinkBodySchema.extend<Shape>>>
export function declareBrokerLinkKind(
  spec: BrokerLinkKindSpec & { readonly linkFields?: z.ZodRawShape },
): DefinedRecordKind<z.ZodType> {
  return defineEntryKind(BROKER_LINK_KIND_NAME, {
    title: spec.title,
    schema: BrokerLinkBodySchema.extend(spec.linkFields ?? {}),
    writeTrigger: spec.writeTrigger,
  })
}

export interface BrokerLinkFormSpec {
  readonly brokerKind: string
  readonly brokerLabel: string
  /** The service's own link fields that do not depend on the broker. */
  readonly linkSections?: FormSections
  /** Link fields whose options come from the CHOSEN broker; called once the link names one. */
  readonly dynamicSections?: (brokerId: string) => Promise<FormSections>
}

/** The form: a picker over the brokers of `brokerKind`, then the service's link sections. */
export async function buildBrokerLinkForm(
  spec: BrokerLinkFormSpec,
  brokerId: string | undefined,
): Promise<ConfigUISchema> {
  const dynamic =
    brokerId !== undefined && spec.dynamicSections !== undefined
      ? await spec.dynamicSections(brokerId)
      : []
  return {
    sections: [
      {
        id: 'broker-link',
        title: spec.brokerLabel,
        description: `Each integration links to a ${spec.brokerLabel} connection (Connectivity → Brokers). The connection and its sign-in are edited there.`,
        columns: 1,
        fields: [
          {
            type: 'broker-select',
            key: 'brokerId',
            label: spec.brokerLabel,
            brokerKind: spec.brokerKind,
          },
        ],
      },
      ...(spec.linkSections ?? []),
      ...dynamic,
    ],
  }
}

/** The broker a record names; undefined while it names none. */
export function resolveBrokerId(record: {
  readonly brokerId?: string | undefined
}): string | undefined {
  return record.brokerId
}

/** The broker an integration links to, from its record. */
export async function brokerIdOf<TBody extends BrokerLinkBody>(
  instances: Pick<RecordIntegrationInstances<TBody>, 'getResolved'>,
  integrationId: string,
): Promise<string | undefined> {
  const body = await instances.getResolved(integrationId)
  return body === null ? undefined : resolveBrokerId(body)
}

/** Every record of the kind that names `brokerId`, as users of that broker. */
export function brokerLinkUserFinder<TBody extends BrokerLinkBody>(
  instances: Pick<RecordIntegrationInstances<TBody>, 'listResolved'>,
  userKind = 'integration',
): BrokerUserFinder {
  return {
    find: async (brokerId): Promise<readonly BrokerUser[]> =>
      (await instances.listResolved())
        .filter((entry) => resolveBrokerId(entry.body) === brokerId)
        .map((entry) => ({ kind: userKind, id: entry.id, name: entry.body.name })),
  }
}

export interface BrokerLinkInstancesSpec<TBody extends BrokerLinkBody> extends BrokerLinkFormSpec {
  readonly kind: DefinedRecordKind<z.ZodType<TBody>>
  /** Runs after a create / update / delete, in the process that serves the integration. */
  readonly onChanged?: (id: string, change: InstanceChange) => void | Promise<void>
}

/** The `integration-instances` provider of an addon whose integrations link to a broker. */
export function buildBrokerLinkInstances<TBody extends BrokerLinkBody>(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  spec: BrokerLinkInstancesSpec<TBody>,
): RecordIntegrationInstances<TBody> {
  const instances: RecordIntegrationInstances<TBody> = new RecordIntegrationInstances<TBody>(
    records,
    spec.kind,
    {
      description: {
        role: 'devices',
        instanceMode: 'multiple',
        kind: 'connection',
        canTest: false,
      },
      formSchema: async (id) =>
        buildBrokerLinkForm(spec, id === null ? undefined : await brokerIdOf(instances, id)),
      initialBody: (name) => spec.kind.schema.parse({ name }),
      configured: (body) => resolveBrokerId(body) !== undefined,
      ...(spec.onChanged !== undefined ? { onChanged: spec.onChanged } : {}),
    },
  )
  return instances
}
