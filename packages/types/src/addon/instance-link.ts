/**
 * The one link primitive (D1013 rule 5), generalising `broker-link.ts`: a kind that points at
 * another instance declares it with {@link declareLinkKind}; the form draws it with an
 * `instance-select` ({@link linkFieldDescriptor}); the target's owner refuses to delete an
 * instance that is still linked, naming the users ({@link linkUserFinder} and the hub's
 * `InstanceLinksIndex`). The link lives on the CONSUMER, never on the target.
 */
import { z } from 'zod'
import type { IntegrationInstanceDescription } from '../capabilities/integration-instances.cap.js'
import type { ConfigInstanceSelectField, ConfigUISchema } from '../interfaces/config-ui.js'
import { defineEntryKind, entryBody } from '../records/entry-kind.js'
import type { DefinedRecordKind } from '../records/record-kind.js'
import type { RecordsAccess } from '../records/records-access.js'
import type { InstanceUser, InstanceUserFinder } from './instance-in-use.js'
import { linkField, linksOfKind, type KindLink, type LinkTarget } from './instance-link-meta.js'
import {
  type InstanceBody,
  type InstanceChange,
  RecordIntegrationInstances,
} from './record-integration-instances.js'

export { linkField, linksOfKind }
export type { KindLink, LinkTarget }

type FormSections = ConfigUISchema['sections']

/** The words a link picker shows. */
export interface LinkLabels {
  readonly label: string
  readonly description?: string
  /** The words of the empty choice of an optional link. */
  readonly noneLabel?: string
}

/** The `instance-select` field of a link, keyed like the body field it fills. */
export function linkFieldDescriptor(
  key: string,
  target: LinkTarget,
  labels: LinkLabels,
): ConfigInstanceSelectField {
  return {
    type: 'instance-select',
    key,
    label: labels.label,
    ...(labels.description !== undefined ? { description: labels.description } : {}),
    required: true,
    ...(labels.noneLabel !== undefined ? { noneLabel: labels.noneLabel } : {}),
    functionCap: target.cap,
    ...(target.kind !== undefined ? { kind: target.kind } : {}),
  }
}

export interface LinkKindSpec<
  Links extends Readonly<Record<string, LinkTarget>>,
  Fields extends z.ZodRawShape,
> {
  /** The record kind name. */
  readonly name: string
  readonly title: string
  readonly writeTrigger: string
  /** body field to what it links to; each becomes a {@link linkField}. */
  readonly links: Links
  /** The kind's OWN settings (never a copy of the target's host, sign-in or secrets). */
  readonly fields?: Fields
}

type LinkShape<Links extends Readonly<Record<string, LinkTarget>>> = {
  readonly [K in keyof Links]: z.ZodString
}

/**
 * Declare the record kind of a service that links to other instances. The body is
 * `{ name, ...links, ...fields }`; the links are recorded in the kind (read back by
 * {@link linksOfKind}) so the hub can index who points at what.
 */
export function declareLinkKind<
  Links extends Readonly<Record<string, LinkTarget>>,
  Fields extends z.ZodRawShape = Record<never, never>,
>(
  spec: LinkKindSpec<Links, Fields>,
): DefinedRecordKind<z.ZodObject<{ name: z.ZodString } & LinkShape<Links> & Fields>> {
  const linkShape: Record<string, z.ZodString> = {}
  for (const [field, target] of Object.entries(spec.links)) linkShape[field] = linkField(target)
  const schema = entryBody({ ...linkShape, ...spec.fields })
  // `entryBody` took a runtime-built shape; its static shape is exactly `LinkShape<Links> & Fields`.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: the shape was built from `spec.links` and `spec.fields` one line above
  const typed = schema as z.ZodObject<{ name: z.ZodString } & LinkShape<Links> & Fields>
  return defineEntryKind(spec.name, {
    title: spec.title,
    schema: typed,
    writeTrigger: spec.writeTrigger,
  })
}

/** The id a record holds in a link field; undefined while it names none. */
function linkedId(body: InstanceBody, field: string): string | undefined {
  const value = body[field]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Every record of the kind whose `field` names `instanceId`, as users of that instance. */
export function linkUserFinder<TBody extends InstanceBody>(
  instances: Pick<RecordIntegrationInstances<TBody>, 'listResolved'>,
  field: string,
  userKind = 'integration',
): InstanceUserFinder {
  return {
    find: async (instanceId): Promise<readonly InstanceUser[]> =>
      (await instances.listResolved())
        .filter((entry) => linkedId(entry.body, field) === instanceId)
        .map((entry) => ({
          kind: userKind,
          id: entry.id,
          name: typeof entry.body['name'] === 'string' ? entry.body['name'] : entry.id,
        })),
  }
}

export interface LinkedInstancesSpec<TBody extends InstanceBody> {
  readonly kind: DefinedRecordKind<z.ZodType<TBody>>
  /** `describe()` of the provider; `links` is added from the kind. */
  readonly description: IntegrationInstanceDescription
  /** The id of the kind an instance of this record kind is, in `describe().links[].kind`. */
  readonly instanceKind?: string
  /** Labels per link field; absent takes the field name. */
  readonly labels?: Readonly<Record<string, LinkLabels>>
  /** The service's own settings that do not depend on a link. */
  readonly linkSections?: FormSections
  /** Settings whose options come from the CHOSEN link (the first link field); called once it names one. */
  readonly dynamicSections?: (linkedInstanceId: string) => Promise<FormSections>
  /** Runs after a create / update / delete, in the process that serves the instance. */
  readonly onChanged?: (id: string, change: InstanceChange) => void | Promise<void>
}

/** The `integration-instances` provider of a service whose records link to other instances. */
export function buildLinkedInstances<TBody extends InstanceBody>(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  spec: LinkedInstancesSpec<TBody>,
): RecordIntegrationInstances<TBody> {
  const links = linksOfKind(spec.kind)
  const kindId = spec.instanceKind ?? spec.kind.name
  const instances: RecordIntegrationInstances<TBody> = new RecordIntegrationInstances<TBody>(
    records,
    spec.kind,
    {
      description: {
        ...spec.description,
        links: links.map((link) => ({ kind: kindId, field: link.field, to: link.to })),
      },
      formSchema: async (id) => {
        const first = links[0]
        const chosen =
          id === null || first === undefined || spec.dynamicSections === undefined
            ? undefined
            : linkedId((await instances.getResolved(id)) ?? {}, first.field)
        const dynamic =
          chosen !== undefined && spec.dynamicSections !== undefined
            ? await spec.dynamicSections(chosen)
            : []
        return {
          sections: [
            {
              id: 'links',
              title: 'Linked instances',
              columns: 1,
              fields: links.map((link) =>
                linkFieldDescriptor(
                  link.field,
                  link.to,
                  spec.labels?.[link.field] ?? { label: link.field },
                ),
              ),
            },
            ...(spec.linkSections ?? []),
            ...dynamic,
          ],
        }
      },
      initialBody: (name) =>
        spec.kind.schema.parse({
          name,
          ...Object.fromEntries(links.map((link) => [link.field, ''])),
        }),
      configured: (body) => links.every((link) => linkedId(body, link.field) !== undefined),
      ...(spec.onChanged !== undefined ? { onChanged: spec.onChanged } : {}),
    },
  )
  return instances
}
