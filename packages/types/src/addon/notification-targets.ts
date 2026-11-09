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
 *  - {@link NotificationTargetStore}: the `Target`-shaped facade the provider's own code keeps
 *    using (send, the notification-center bridge), over one handle per kind;
 *  - {@link listNotificationTargets}: the targets as an addon on `ctx.api` reads them;
 *  - {@link buildNotificationTargetInstances}: the `integration-instances` provider, one kind each;
 *  - {@link moveTargetRows}: the D987 procedure that flattens the old `config` blobs into the bodies.
 */
import { z } from 'zod'
import type { CapCaller } from '../capabilities/capability-definition.js'
import type {
  IIntegrationInstancesProvider,
  IntegrationInstance,
  IntegrationInstanceKind,
} from '../capabilities/integration-instances.cap.js'
import type { IntegrationTestConnectionResult } from '../capabilities/integrations.cap.js'
import {
  type ProbeTargetConfigResult,
  type Target,
  type TargetKind,
  TargetSchema,
} from '../capabilities/notification-output.cap.js'
import type { ConfigField, ConfigUISchema } from '../interfaces/config-ui.js'
import type { IScopedLogger } from '../interfaces/logging.js'
import type { MigrationProcedureResult } from '../migrations/migration.js'
import { defineEntryKind } from '../records/entry-kind.js'
import type { DefinedRecordKind } from '../records/record-kind.js'
import type { RecordKindHandle, RecordsAccess } from '../records/records-access.js'
import { composeInstanceKinds, type InstanceKindPart } from './compose-instance-kinds.js'
import { type InstanceApi, instanceSourceOverApi, instancesOfCap } from './instances-of-cap.js'
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

/** The target kind a record kind name stands for: `notify-telegram` is the kind `telegram`. */
export function notificationTargetKindOf(recordKind: string): string {
  return recordKind.startsWith('notify-') ? recordKind.slice('notify-'.length) : recordKind
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

/**
 * Where a target that could not be moved still lives (its legacy source). The facade serves such a row
 * as long as the new records do not hold its id, so a row the migration skipped never goes dark, and a
 * write of that id moves it (the legacy row is dropped last).
 */
export interface LegacyTargets {
  list(): Promise<readonly OldTargetRow[]>
  delete(id: string): Promise<void>
}

/** What a store takes beyond its kinds. */
export interface NotificationTargetStoreOptions {
  readonly logger?: IScopedLogger
  readonly legacy?: LegacyTargets
}

function targetOfOld(addonId: string, row: OldTargetRow): Target {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    addonId,
    enabled: row.enabled,
    config: { ...row.config },
  }
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
    private readonly options: NotificationTargetStoreOptions,
  ) {}

  static of(
    records: Pick<RecordsAccess, 'kind'>,
    addonId: string,
    kinds: Readonly<Record<string, NotificationTargetRecordKind>>,
    descriptors: readonly TargetKind[],
    options: NotificationTargetStoreOptions = {},
  ): NotificationTargetStore {
    const handles: KindHandle[] = []
    for (const descriptor of descriptors) {
      const defined = kinds[notificationTargetKindName(descriptor.kind)]
      if (defined === undefined) continue
      handles.push({ kind: descriptor.kind, handle: records.kind(defined) })
    }
    return new NotificationTargetStore(addonId, handles, options)
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
        if (target !== null) {
          out.push(target)
          continue
        }
        // A row that is no target is named, never dropped silently: it would read as deleted.
        this.options.logger?.warn(
          'notification target record is not a valid target; left out of the list',
          {
            meta: { targetId: record.id, kind },
          },
        )
      }
    }
    const held = new Set(out.map((target) => target.id))
    for (const row of await this.legacyRows()) {
      if (!held.has(row.id)) out.push(targetOfOld(this.addonId, row))
    }
    return out
  }

  /** The legacy rows of a kind this provider serves (the others are not ours to show). */
  private async legacyRows(): Promise<readonly OldTargetRow[]> {
    const legacy = this.options.legacy
    if (legacy === undefined) return []
    const served = new Set(this.handles.map((entry) => entry.kind))
    return (await legacy.list()).filter((row) => served.has(row.kind))
  }

  async getById(id: string): Promise<Target | null> {
    for (const { kind, handle } of this.handles) {
      const row = await handle.getResolved(id)
      if (row !== null) return targetOfRecord(this.addonId, kind, row.id, row.data)
    }
    const old = (await this.legacyRows()).find((row) => row.id === id)
    return old === undefined ? null : targetOfOld(this.addonId, old)
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
    // The record now holds the id: the legacy row of it is moved, so it goes, last.
    await this.options.legacy?.delete(target.id)
  }

  async delete(id: string): Promise<void> {
    for (const { handle } of this.handles) await handle.delete(id)
    await this.options.legacy?.delete(id)
  }

  /** Flip the switch on an existing target; null when it does not exist. */
  async setEnabled(id: string, enabled: boolean): Promise<Target | null> {
    for (const { kind, handle } of this.handles) {
      if ((await handle.get(id)) === null) continue
      await handle.patch(id, { enabled })
      const row = await handle.get(id)
      return row === null ? null : targetOfRecord(this.addonId, kind, row.id, row.data)
    }
    // Only the legacy source has it: flipping the switch moves the row to its record.
    const old = (await this.legacyRows()).find((row) => row.id === id)
    if (old === undefined) return null
    const moved = { ...targetOfOld(this.addonId, old), enabled }
    await this.upsert(moved)
    return moved
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
  /**
   * The save-time rule of a kind, on the body a save would leave (the form's values flat, secrets
   * left out): throws a reason an operator can read to refuse the write, or returns keys the record
   * keeps with it. Absent: the kind accepts what its form accepts.
   */
  readonly validate?: (input: {
    readonly kind: string
    readonly config: Readonly<Record<string, unknown>>
  }) => Readonly<Record<string, unknown>> | undefined
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
    const kind: IntegrationInstanceKind = {
      id: descriptor.kind,
      label: descriptor.label,
      functionCap: NOTIFICATION_OUTPUT_CAP,
      role: 'services',
      canTest,
    }
    const instances = new RecordIntegrationInstances<InstanceBody>(records, defined, {
      description: {
        role: 'services',
        instanceMode: 'multiple',
        kind: 'target',
        canTest,
        kinds: [kind],
      },
      formSchema: () => formOf(descriptor),
      initialBody: (name): InstanceBody => ({ name }),
      mintId: () => spec.mintId(),
      configured: () => true,
      validateWrite: ({ body }) => spec.validate?.({ kind: descriptor.kind, config: body }),
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
    return [{ kind, provider: instances.toProvider() }]
  })
}

/** The body key that names the user a PERSONAL target belongs to (the open blob, no schema change). */
export const TARGET_OWNER_KEY = 'ownerUserId'

/**
 * The authorisation of a target as the instance door sees it. An admin (and an in-process caller
 * that holds no session) keeps the admin door: every target, any change. A user sees and changes
 * only the targets whose `ownerUserId` is theirs, and a target with no owner (a global target the
 * operator made) is nobody's. Nothing a client sends moves the owner of a user's target: the
 * server stamps it from the caller.
 */
export function scopeInstancesToCaller(
  inner: IIntegrationInstancesProvider,
): IIntegrationInstancesProvider {
  const ownerOf = (instance: IntegrationInstance): unknown => instance.formValues[TARGET_OWNER_KEY]
  const owned = (
    instance: IntegrationInstance | null,
    userId: string,
  ): instance is IntegrationInstance => instance !== null && ownerOf(instance) === userId
  const requireOwned = async (id: string, userId: string): Promise<void> => {
    if (!owned(await inner.getInstance({ id }), userId)) {
      throw new Error(`forbidden: target not owned: ${id}`)
    }
  }
  /** The user's own values: whatever the client sent for the owner is dropped and re-stamped. */
  const stamped = (
    values: Readonly<Record<string, unknown>> | undefined,
    userId: string,
  ): Record<string, unknown> => ({ ...values, [TARGET_OWNER_KEY]: userId })
  const userOnly = (caller: CapCaller | undefined): CapCaller | undefined =>
    caller !== undefined && !caller.isAdmin ? caller : undefined

  return {
    ...inner,
    describe: async () => ({ ...(await inner.describe()), userScoped: true }),
    listInstances: async (input) => {
      const all = await inner.listInstances(input)
      // An admin sees every row; one that asks for `mine` (a "my targets" screen) gets its own.
      const user = input?.['mine'] === true ? input.caller : userOnly(input?.caller)
      return user === undefined ? all : all.filter((instance) => owned(instance, user.userId))
    },
    getInstance: async (input) => {
      const found = await inner.getInstance(input)
      const user = userOnly(input.caller)
      return user === undefined || owned(found, user.userId) ? found : null
    },
    createInstance: async (input) => {
      const user = userOnly(input.caller)
      if (user === undefined) return inner.createInstance(input)
      // A user never names the id (it could collide with, or adopt, somebody else's row).
      const { id: _id, seed: _seed, ...rest } = input
      return inner.createInstance({ ...rest, values: stamped(input.values, user.userId) })
    },
    updateInstance: async (input) => {
      const user = userOnly(input.caller)
      if (user === undefined) return inner.updateInstance(input)
      await requireOwned(input.id, user.userId)
      return inner.updateInstance({ ...input, values: stamped(input.values, user.userId) })
    },
    setInstanceEnabled: async (input) => {
      const user = userOnly(input.caller)
      if (user !== undefined) await requireOwned(input.id, user.userId)
      return inner.setInstanceEnabled(input)
    },
    deleteInstance: async (input) => {
      const user = userOnly(input.caller)
      if (user !== undefined) await requireOwned(input.id, user.userId)
      return inner.deleteInstance(input)
    },
    ...(inner.testInstance === undefined
      ? {}
      : {
          testInstance: async (input) => {
            const user = userOnly(input.caller)
            // A user tests a STORED target of their own: an unsaved form would make the hub
            // probe any address the user types.
            if (user !== undefined) {
              if (input.id === null)
                throw new Error('forbidden: a draft target is tested by an admin')
              await requireOwned(input.id, user.userId)
            }
            return inner.testInstance === undefined
              ? { success: false, status: 'unsupported', error: 'This kind cannot be tested' }
              : inner.testInstance(input)
          },
        }),
  }
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

/**
 * The same provider, for a notification provider whose targets belong to users (the notifiers
 * addon): `describe().userScoped`, and every row filtered on the caller.
 */
export function buildUserScopedNotificationTargetInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  spec: NotificationTargetInstancesSpec,
): IIntegrationInstancesProvider {
  return scopeInstancesToCaller(buildNotificationTargetInstances(records, spec))
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
  /** A row left where it was (its legacy source keeps serving it), with the reason. */
  skipped(row: { readonly id: string; readonly kind: string; readonly reason: string }): void
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
 * the switch, each secret written to the keychain by the door and READ BACK before the old row goes.
 * One bad row never aborts the others: a row whose write or read-back fails (or disagrees) is undone,
 * reported through `skipped` with its id and reason, and its old row stays where it was, still served
 * by the facade. A row of a kind this provider does not serve is left alone the same way. Idempotent:
 * no old rows is `already-done`, and a row the new kind already holds equal is only dropped from the
 * old kind.
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
      ports.skipped({ id: row.id, kind: row.kind, reason: 'this provider does not serve the kind' })
      continue
    }
    const reason = await moveOne(ports, row, secretKeysByKind(row.kind))
    if (reason === null) {
      converted += 1
    } else {
      skipped += 1
      ports.skipped({ id: row.id, kind: row.kind, reason })
    }
  }
  return {
    outcome: converted > 0 ? 'done' : 'already-done',
    summary: { converted, skipped },
  }
}

/** Move one row; the reason it stayed, or null when it moved. Never throws: the row stays on failure. */
async function moveOne(
  ports: TargetRowPorts,
  row: OldTargetRow,
  secretKeys: readonly string[],
): Promise<string | null> {
  const body = targetBody(row)
  try {
    await ports.writeNew(row.kind, row.id, body)
    const back = await ports.readNew(row.kind, row.id)
    const wrong = secretKeys.filter((key) => {
      const sent = body[key]
      const got = back?.[key]
      return (typeof sent === 'string' ? sent : '') !== (typeof got === 'string' ? got : '')
    })
    if (back !== null && wrong.length === 0) {
      await ports.dropOld(row.id)
      return null
    }
    await ports.dropNew(row.kind, row.id)
    return back === null ? 'the new record is missing' : `${wrong.join(', ')} did not read back`
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await ports.dropNew(row.kind, row.id).catch(() => undefined)
    return reason
  }
}

/** The body of a row of the retired single kind (`{ name, kind, addonId, enabled, config }`, no id). */
export const OldTargetBodySchema = TargetSchema.omit({ id: true })

/** The legacy source that is the retired single kind: its valid rows, an invalid one named and left. */
export function legacyTargetsOver(
  oldKind: RecordKindHandle<z.infer<typeof OldTargetBodySchema>>,
  logger: IScopedLogger,
): LegacyTargets {
  return {
    list: async () => {
      const page = await oldKind.query({ limit: TARGETS_LIST_MAX })
      return page.records.flatMap((record) => {
        const parsed = OldTargetBodySchema.safeParse(record.data)
        if (parsed.success) return [{ id: record.id, ...parsed.data }]
        logger.warn('legacy notification target is not a valid target; left in place', {
          meta: { targetId: record.id, error: parsed.error.message },
        })
        return []
      })
    },
    delete: async (id) => {
      await oldKind.delete(id)
    },
  }
}

/** The ports over the records: the retired kind in, the per-kind records out. */
export function targetRowPortsOver(deps: {
  readonly legacy: LegacyTargets
  readonly store: NotificationTargetStore
  readonly logger: IScopedLogger
}): TargetRowPorts {
  const handles = deps.store.handlesByKind()
  return {
    listOld: () => deps.legacy.list(),
    hasKind: (kind) => handles.has(kind),
    readNew: async (kind, id) => (await handles.get(kind)?.getResolved(id))?.data ?? null,
    writeNew: async (kind, id, body) => {
      await handles.get(kind)?.put({ id, data: body })
    },
    dropNew: async (kind, id) => {
      await handles.get(kind)?.delete(id)
    },
    dropOld: (id) => deps.legacy.delete(id),
    skipped: (row) => {
      deps.logger.warn('notification target left in its legacy store; it keeps being served', {
        meta: { targetId: row.id, kind: row.kind, reason: row.reason },
      })
    },
  }
}

// ── Reading the targets from another addon ───────────────────────────────────────────────────────

/** A notification target as a reader on `ctx.api` sees it: enough to list, pick and address a send. */
export interface NotificationTargetRef {
  readonly id: string
  readonly name: string
  readonly kind: string
  /** The provider that holds the target: `notificationOutput.send` is routed by it. */
  readonly addonId: string
  readonly enabled: boolean
  /** The user a personal target belongs to; absent for a system target. */
  readonly ownerUserId?: string
}

/** The answer of {@link listNotificationTargets}: what was read, and who could not be read. */
export interface NotificationTargetsRead {
  readonly targets: readonly NotificationTargetRef[]
  readonly unreadable: readonly { readonly addonId: string; readonly error: string }[]
}

/**
 * Every notification target, read as the instances of `notification-output` (D1013 rule 5). A holder
 * that could not answer is NAMED in `unreadable`: a caller that acts on a target's absence (drops a
 * selection, refuses a send) must check it first, because a partial read is not "deleted" (D315, D49).
 */
export async function listNotificationTargets(api: InstanceApi): Promise<NotificationTargetsRead> {
  const { instances, unreadable } = await instancesOfCap(
    instanceSourceOverApi(api),
    NOTIFICATION_OUTPUT_CAP,
  )
  const targets = instances.map(({ addonId, kind, instance }): NotificationTargetRef => {
    const owner = instance.formValues['ownerUserId']
    return {
      id: instance.id,
      name: instance.name,
      kind: kind.id,
      addonId,
      enabled: instance.enabled !== false,
      ...(typeof owner === 'string' && owner.length > 0 ? { ownerUserId: owner } : {}),
    }
  })
  return { targets, unreadable }
}

/**
 * The `ctx.api` slice {@link listNotificationTargets} reads, answering from the targets as they are NOW (read on every call):
 * one holder per `addonId`, one record kind per target kind. For the specs of the addons that read the
 * targets; it serves nothing at runtime.
 */
export function instanceApiOverTargets(targetsNow: () => readonly Target[]): InstanceApi {
  const rowsOf = (addonId: string): readonly Target[] =>
    targetsNow().filter((target) => target.addonId === addonId)
  return {
    capabilities: {
      getCapability: {
        query: async () => ({ providers: [...new Set(targetsNow().map((t) => t.addonId))] }),
      },
    },
    integrationInstances: {
      describe: {
        query: async ({ addonId }) => ({
          role: 'services',
          instanceMode: 'multiple',
          kind: addonId,
          canTest: true,
          kinds: [...new Set(rowsOf(addonId).map((target) => target.kind))].map((kind) => ({
            id: notificationTargetKindName(kind),
            label: kind,
            functionCap: NOTIFICATION_OUTPUT_CAP,
          })),
        }),
      },
      listInstances: {
        query: async ({ addonId }) =>
          rowsOf(addonId).map((target) => ({
            id: target.id,
            name: target.name,
            configured: true,
            enabled: target.enabled,
            kind: notificationTargetKindName(target.kind),
            formValues: { ...target.config },
          })),
      },
    },
  }
}
