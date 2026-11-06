/**
 * Notification targets as instances of the function cap `notification-output` (epic #440, step 6).
 *
 * A notification target used to be one row of one record kind (`{ name, kind, addonId, enabled,
 * config }`) with a free-form `config` blob whose secrets nobody could name. Now every target KIND
 * the provider offers (ntfy, telegram, webhook, ...) is a record kind of its own whose flat body IS
 * that kind's form: the adapter's `configSchema` lifted into a Zod object, a `password` field marked
 * `.meta({ secret: true })` so the records door keeps it in the keychain, an `instance-select` field
 * declared as a link so the hub refuses to delete what a target points at.
 *
 * Three providers (notifiers, Home Assistant, Alexa) serve the same shape, so the pieces are shared:
 *  - {@link defineNotificationTargetKind}: the record kind of one `TargetKind` descriptor;
 *  - {@link NotificationTargetStore}: the `Target`-shaped facade the existing provider code keeps
 *    using, over one handle per kind (the old `notification-output` CRUD keeps working on it);
 *  - {@link buildNotificationTargetInstances}: the `integration-instances` provider, one kind each;
 *  - {@link moveTargetRows}: the D987 procedure that flattens the old `config` blobs into the bodies.
 */
import { z } from 'zod'
import type { IIntegrationInstancesProvider } from '../capabilities/integration-instances.cap.js'
import type { IntegrationTestConnectionResult } from '../capabilities/integrations.cap.js'
import {
  type ProbeTargetConfigResult,
  type Target,
  type TargetKind,
  TargetSchema,
} from '../capabilities/notification-output.cap.js'
import type { ConfigField, ConfigUISchema } from '../interfaces/config-ui.js'
import type { MigrationProcedureResult } from '../migrations/migration.js'
import { defineEntryKind } from '../records/entry-kind.js'
import type { DefinedRecordKind } from '../records/record-kind.js'
import type { RecordKindHandle, RecordsAccess } from '../records/records-access.js'
import { composeInstanceKinds, type InstanceKindPart } from './compose-instance-kinds.js'
import { optionalLinkField } from './instance-link-meta.js'
import {
  type InstanceBody,
  isInstanceEnabled,
  RecordIntegrationInstances,
} from './record-integration-instances.js'

/** The function cap every notification target is an instance of. */
export const NOTIFICATION_OUTPUT_CAP = 'notification-output'

/** The most targets one provider lists (a settings page, not a table). */
const TARGETS_LIST_MAX = 1000

/** The record kind name of one target kind: `telegram` is stored under `notify-telegram`. */
export function notificationTargetKindName(kind: string): string {
  return `notify-${kind}`
}

/** The body schema of a target kind: the entry's name and switch plus the adapter's fields. */
const TargetBodyBaseSchema = z.looseObject({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
})

/** A target kind's record kind. */
export type NotificationTargetRecordKind = DefinedRecordKind<
  z.ZodObject<
    z.core.util.Extend<typeof TargetBodyBaseSchema.shape, Record<string, z.ZodType>>,
    z.core.$loose
  >
>

/** The shape of one `editable-array` row: the item fields, a `password` one a secret. */
function rowSchemaOf(itemFields: readonly ConfigField[]): {
  readonly row: z.ZodType
  readonly idKey: string | null
  readonly hasSecret: boolean
} {
  const shape: Record<string, z.ZodType> = {}
  let idKey: string | null = null
  let hasSecret = false
  for (const item of itemFields) {
    if (item.type === 'password') {
      shape[item.key] = z.string().optional().meta({ secret: true })
      hasSecret = true
      continue
    }
    shape[item.key] = z.unknown().optional()
    idKey ??= item.key
  }
  return { row: z.looseObject(shape), idKey, hasSecret }
}

/**
 * The Zod fields of a descriptor's form. A `password` field is a secret; an `instance-select` field is
 * a link to an instance of its function cap; an `editable-array` keeps its rows (a password inside a
 * row is a secret matched by the row's first plain field); every other field keeps whatever the
 * adapter's own parse accepts, because the form already validated its shape. The body is loose, so a key
 * the schema does not know (the owner of a personal target) survives a write.
 */
function fieldsOf(descriptor: TargetKind): {
  readonly shape: Record<string, z.ZodType>
  readonly secretArrayKeys: Record<string, string>
} {
  const shape: Record<string, z.ZodType> = {}
  const secretArrayKeys: Record<string, string> = {}
  for (const section of descriptor.configSchema.sections) {
    for (const field of section.fields) {
      switch (field.type) {
        case 'info':
          break
        case 'password':
          shape[field.key] = z.string().optional().meta({ secret: true })
          break
        case 'instance-select':
          shape[field.key] = optionalLinkField({
            cap: field.functionCap,
            ...(field.kind !== undefined ? { kind: field.kind } : {}),
          })
          break
        case 'editable-array': {
          const { row, idKey, hasSecret } = rowSchemaOf(field.itemFields)
          shape[field.key] = z.array(row).optional()
          if (hasSecret && idKey !== null) secretArrayKeys[field.key] = idKey
          break
        }
        default:
          shape[field.key] = z.unknown().optional()
      }
    }
  }
  return { shape, secretArrayKeys }
}

/** The record kind of one target kind, derived from its descriptor. */
export function defineNotificationTargetKind(descriptor: TargetKind): NotificationTargetRecordKind {
  const { shape, secretArrayKeys } = fieldsOf(descriptor)
  return defineEntryKind(notificationTargetKindName(descriptor.kind), {
    title: `${descriptor.label} notification targets`,
    schema: TargetBodyBaseSchema.extend(shape),
    writeTrigger: `an operator adds, edits, switches or removes a ${descriptor.label} notification target`,
    ...(Object.keys(secretArrayKeys).length > 0 ? { secretArrayKeys } : {}),
  })
}

/** The record kinds of a provider's descriptors, keyed by the record kind name (for `records.declare`). */
export function notificationTargetKinds(
  descriptors: readonly TargetKind[],
): Readonly<Record<string, NotificationTargetRecordKind>> {
  return Object.fromEntries(
    descriptors.map((descriptor): [string, NotificationTargetRecordKind] => {
      const defined = defineNotificationTargetKind(descriptor)
      return [defined.name, defined]
    }),
  )
}

/** The body a stored target becomes: the switch and the name, and the config fields flat beside them. */
export function targetBody(
  target: Pick<Target, 'id' | 'name' | 'enabled' | 'config'>,
): InstanceBody {
  return {
    ...target.config,
    name: target.name.length > 0 ? target.name : target.id,
    enabled: target.enabled,
  }
}

/** The `Target` a record of a kind is; null when the row is not a target. */
export function targetOfRecord(
  addonId: string,
  kind: string,
  id: string,
  data: InstanceBody,
): Target | null {
  const { name, enabled: _enabled, ...config } = data
  const parsed = TargetSchema.safeParse({
    id,
    name,
    kind,
    addonId,
    enabled: isInstanceEnabled(data),
    config,
  })
  return parsed.success ? parsed.data : null
}

interface KindHandle {
  readonly kind: string
  readonly handle: RecordKindHandle<InstanceBody>
}

/**
 * The `Target`-shaped facade over one record kind per target kind. `list` returns the stored form (a
 * secret is a keychain marker: every reader redacts it anyway); `getById` returns the target with its
 * secrets resolved, which is what a send, a probe and an edit's secret merge need. A keychain that
 * cannot answer throws: a write never goes ahead with a secret it could not read (D49).
 */
export class NotificationTargetStore {
  private constructor(
    private readonly addonId: string,
    private readonly handles: readonly KindHandle[],
  ) {}

  static of(
    records: Pick<RecordsAccess, 'kind'>,
    addonId: string,
    kinds: Readonly<Record<string, NotificationTargetRecordKind>>,
    descriptors: readonly TargetKind[],
  ): NotificationTargetStore {
    const handles: KindHandle[] = []
    for (const descriptor of descriptors) {
      const defined = kinds[notificationTargetKindName(descriptor.kind)]
      if (defined === undefined) continue
      handles.push({ kind: descriptor.kind, handle: records.kind(defined) })
    }
    return new NotificationTargetStore(addonId, handles)
  }

  /** The record handle of each kind, for the migration ports. */
  handlesByKind(): ReadonlyMap<string, RecordKindHandle<InstanceBody>> {
    return new Map(this.handles.map((entry) => [entry.kind, entry.handle]))
  }

  async list(): Promise<Target[]> {
    const out: Target[] = []
    for (const { kind, handle } of this.handles) {
      const page = await handle.query({ limit: TARGETS_LIST_MAX })
      for (const record of page.records) {
        const target = targetOfRecord(this.addonId, kind, record.id, record.data)
        if (target !== null) out.push(target)
      }
    }
    return out
  }

  async getById(id: string): Promise<Target | null> {
    for (const { kind, handle } of this.handles) {
      const row = await handle.getResolved(id)
      if (row !== null) return targetOfRecord(this.addonId, kind, row.id, row.data)
    }
    return null
  }

  /** Insert or replace by id; a target whose kind changed leaves the record of its old kind. */
  async upsert(target: Target): Promise<void> {
    const own = this.handles.find((entry) => entry.kind === target.kind)
    if (own === undefined)
      throw new Error(`invalid target '${target.id}': unknown kind '${target.kind}'`)
    await own.handle.put({ id: target.id, data: targetBody(target) })
    for (const other of this.handles) {
      if (other !== own) await other.handle.delete(target.id)
    }
  }

  async delete(id: string): Promise<void> {
    for (const { handle } of this.handles) await handle.delete(id)
  }

  /** Flip the switch on an existing target; null when it does not exist. */
  async setEnabled(id: string, enabled: boolean): Promise<Target | null> {
    for (const { kind, handle } of this.handles) {
      if ((await handle.get(id)) === null) continue
      await handle.patch(id, { enabled })
      const row = await handle.get(id)
      return row === null ? null : targetOfRecord(this.addonId, kind, row.id, row.data)
    }
    return null
  }
}

/** What a provider hands {@link buildNotificationTargetInstances}. */
export interface NotificationTargetInstancesSpec {
  readonly descriptors: readonly TargetKind[]
  readonly kinds: Readonly<Record<string, NotificationTargetRecordKind>>
  /** Mint the id of a new target when the caller sent none. */
  readonly mintId: () => string
  /**
   * The existing credential probe of a kind, run on the (possibly unsaved) form values; `targetId` lets
   * the provider restore the secrets of a stored target the form left blank. Absent for a kind that has no
   * probe: that kind reports `unsupported`.
   */
  readonly probe?: (input: {
    readonly kind: string
    readonly config: Readonly<Record<string, unknown>>
    readonly targetId: string | undefined
  }) => Promise<ProbeTargetConfigResult>
  /** Which kinds have a probe (the others are `canTest: false`). */
  readonly canProbe: (kind: string) => boolean
}

/**
 * A probe's answer as the tri-state of `testInstance`: `ok` validated; a refusal that carries an HTTP
 * status is the remote saying no (`rejected`); a failure with no answer at all (the network, a missing
 * field) proves nothing about the credentials (`inconclusive`).
 */
export function probeToTestResult(
  probed: ProbeTargetConfigResult,
): IntegrationTestConnectionResult {
  if (probed.ok) {
    return {
      success: true,
      status: 'validated',
      ...(probed.stateInstance !== undefined ? { detail: probed.stateInstance } : {}),
    }
  }
  const error = probed.error ?? 'the probe failed'
  return {
    success: false,
    status: probed.httpStatus !== undefined ? 'rejected' : 'inconclusive',
    error,
  }
}

/** The form of a kind: the adapter's own sections. */
function formOf(descriptor: TargetKind): ConfigUISchema {
  return descriptor.configSchema
}

/** The instance kinds of a notification provider, one per target kind: a part a composition can take. */
export function notificationTargetParts(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  spec: NotificationTargetInstancesSpec,
): readonly InstanceKindPart[] {
  return spec.descriptors.flatMap((descriptor) => {
    const defined = spec.kinds[notificationTargetKindName(descriptor.kind)]
    if (defined === undefined) return []
    const canTest = spec.probe !== undefined && spec.canProbe(descriptor.kind)
    const instances = new RecordIntegrationInstances<InstanceBody>(records, defined, {
      description: {
        role: 'services',
        instanceMode: 'multiple',
        kind: 'target',
        canTest,
      },
      formSchema: () => formOf(descriptor),
      initialBody: (name): InstanceBody => ({ name }),
      mintId: () => spec.mintId(),
      configured: () => true,
      test: async ({ id, values }) => {
        if (spec.probe === undefined || !canTest) {
          return {
            success: false,
            status: 'unsupported',
            error: 'This kind cannot be tested',
          }
        }
        return probeToTestResult(
          await spec.probe({
            kind: descriptor.kind,
            config: values,
            targetId: id ?? undefined,
          }),
        )
      },
    })
    return [
      {
        kind: {
          id: descriptor.kind,
          label: descriptor.label,
          functionCap: NOTIFICATION_OUTPUT_CAP,
          role: 'services' as const,
          canTest,
        },
        provider: instances.toProvider(),
      },
    ]
  })
}

/** The `integration-instances` provider of a notification provider: one kind per target kind. */
export function buildNotificationTargetInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  spec: NotificationTargetInstancesSpec,
): IIntegrationInstancesProvider {
  const parts = notificationTargetParts(records, spec)
  return composeInstanceKinds(parts, {
    role: 'services',
    instanceMode: 'multiple',
    kind: 'target',
    canTest: parts.some((part) => part.kind.canTest === true),
    mintsId: true,
  })
}

// ── The D987 procedure: the old `config` blob becomes the flat body ──────────────────────────────

/** One old row: the record of the single `notification-targets` kind, its secrets resolved. */
export interface OldTargetRow {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly enabled: boolean
  readonly config: Readonly<Record<string, unknown>>
}

/** What {@link moveTargetRows} reads and writes. */
export interface TargetRowPorts {
  /** Every old row that is still there, with its secrets in clear (the old kind declared none). */
  listOld(): Promise<readonly OldTargetRow[]>
  /** The target kinds the provider knows; a row of another kind is left alone and counted. */
  hasKind(kind: string): boolean
  /** The new record of `kind` under `id`, secrets resolved; null when absent. */
  readNew(kind: string, id: string): Promise<Readonly<Record<string, unknown>> | null>
  /** Write the new record (`ifRev: 0`, or replace one a crashed run left half-done). */
  writeNew(kind: string, id: string, body: InstanceBody): Promise<void>
  /** Drop the new record of a row whose read-back disagreed. */
  dropNew(kind: string, id: string): Promise<void>
  /** Drop the old row, last. */
  dropOld(id: string): Promise<void>
}

/** The secret keys of a kind's body: the descriptor's `password` fields (top level). */
export function secretKeysOf(descriptor: TargetKind): readonly string[] {
  const { shape } = fieldsOf(descriptor)
  return Object.keys(shape).filter((key) => {
    const meta: unknown = z.globalRegistry.get(shape[key] ?? z.unknown())
    return typeof meta === 'object' && meta !== null && Reflect.get(meta, 'secret') === true
  })
}

/**
 * Move every old row to the record of its kind under the SAME id: the config flat beside the name and
 * the switch, each secret written to the keychain by the door and READ BACK before the old row goes. A
 * row whose read-back differs is undone and the migration throws naming the row (the owner is blocked,
 * nothing is lost: the old row is still there). A row of a kind this provider does not serve is left
 * alone. Idempotent: no old rows is `already-done`, and a row the new kind already holds equal is only
 * dropped from the old kind.
 */
export async function moveTargetRows(
  ports: TargetRowPorts,
  secretKeysByKind: (kind: string) => readonly string[],
): Promise<MigrationProcedureResult> {
  const rows = await ports.listOld()
  if (rows.length === 0) return { outcome: 'already-done', summary: { converted: 0 } }
  let converted = 0
  let skipped = 0
  for (const row of rows) {
    if (!ports.hasKind(row.kind)) {
      skipped += 1
      continue
    }
    const body = targetBody(row)
    await ports.writeNew(row.kind, row.id, body)
    const back = await ports.readNew(row.kind, row.id)
    const wrong = secretKeysByKind(row.kind).filter((key) => {
      const sent = body[key]
      const got = back?.[key]
      return (typeof sent === 'string' ? sent : '') !== (typeof got === 'string' ? got : '')
    })
    if (back === null || wrong.length > 0) {
      await ports.dropNew(row.kind, row.id)
      throw new Error(
        `target '${row.id}': ${back === null ? 'the new record is missing' : `${wrong.join(', ')} did not read back`} - the old row is unchanged`,
      )
    }
    await ports.dropOld(row.id)
    converted += 1
  }
  return {
    outcome: converted > 0 ? 'done' : 'already-done',
    summary: { converted, skipped },
  }
}

/** The body of a row of the retired single kind (`{ name, kind, addonId, enabled, config }`, no id). */
export const OldTargetBodySchema = TargetSchema.omit({ id: true })

/** The ports over the records: the retired kind in, the per-kind records out. */
export function targetRowPortsOver(deps: {
  readonly oldKind: RecordKindHandle<z.infer<typeof OldTargetBodySchema>>
  readonly store: NotificationTargetStore
}): TargetRowPorts {
  const handles = deps.store.handlesByKind()
  return {
    listOld: async () => {
      const page = await deps.oldKind.query({ limit: TARGETS_LIST_MAX })
      return page.records.flatMap((record) => {
        const parsed = OldTargetBodySchema.safeParse(record.data)
        return parsed.success ? [{ id: record.id, ...parsed.data }] : []
      })
    },
    hasKind: (kind) => handles.has(kind),
    readNew: async (kind, id) => (await handles.get(kind)?.getResolved(id))?.data ?? null,
    writeNew: async (kind, id, body) => {
      await handles.get(kind)?.put({ id, data: body })
    },
    dropNew: async (kind, id) => {
      await handles.get(kind)?.delete(id)
    },
    dropOld: async (id) => {
      await deps.oldKind.delete(id)
    },
  }
}
