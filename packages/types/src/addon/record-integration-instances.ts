/**
 * `RecordIntegrationInstances` - the `integration-instances` provider over ONE
 * entry kind, so an addon that holds a connection serves it in ~30 lines.
 *
 * Every instance is one record of the addon's own kind, keyed by the
 * `integrations` registry id. The records door does the secret work: a field the
 * kind marks `.meta({ secret: true })` is a keychain marker bound to the row, so
 * deleting the row deletes the secret, and one row's value is never another's.
 *
 * Patch rules for a secret (`updateInstance`): omitted, `''`, the redaction
 * token or the view the form was given KEEP the stored secret;
 * `{ $secretClear: true }` clears it; any other string replaces it.
 */
import { z } from 'zod'
import type {
  IntegrationInstance,
  IntegrationInstanceDescription,
  IntegrationInstanceStatus,
  IIntegrationInstancesProvider,
} from '../capabilities/integration-instances.cap.js'
import type { IntegrationTestConnectionResult } from '../capabilities/integrations.cap.js'
import type { ConfigUISchema } from '../interfaces/config-ui.js'
import { REDACTED_SECRET } from '../interfaces/config-ui-secrets.js'
import { isSecretClear, isSecretFieldView } from '../keychain/secret-marker.js'
import { RecordSecretUnavailableError } from '../records/errors.js'
import type { DefinedRecordKind } from '../records/record-kind.js'
import type { RecordKindHandle, RecordRow, RecordsAccess } from '../records/records-access.js'
import { secretViewsOf } from '../records/secret-views.js'

/** The most instances one addon lists (an integrations page, not a table). */
const INSTANCES_LIST_MAX = 1000

/** What every instance body carries: an absent `enabled` means on (no data migration). */
export type InstanceBody = Record<string, unknown> & {
  readonly enabled?: boolean | undefined
}

/** What the instance went through when `onChanged` runs. */
export type InstanceChange = 'created' | 'updated' | 'enabled' | 'deleted'

export interface RecordIntegrationInstancesHooks<TBody extends InstanceBody> {
  /** Includes the optional `kinds` and `allowRestoreId` a provider offers the Add flow. */
  readonly description: IntegrationInstanceDescription
  /** The form; `id: null` is the create form. */
  formSchema(id: string | null): ConfigUISchema | Promise<ConfigUISchema>
  /** The body a new instance starts with (of `kind` when the caller picked one). It must satisfy the kind's schema. */
  initialBody(name: string, kind?: string): TBody
  /**
   * Mint the id of a new instance when the caller sent none. Without it a create without an id is
   * refused: the helper never invents an id a provider did not choose.
   */
  mintId?(input: { readonly name: string; readonly kind?: string }): string
  /** The kind a stored instance is of; surfaces as `IntegrationInstance.kind`. */
  kindOf?(body: TBody): string | undefined
  /** The instance's own health word and the time it was last probed, from the record. */
  health?(
    body: TBody,
    id: string,
  ): {
    readonly status?: IntegrationInstanceStatus
    readonly lastCheckedAt?: number
  }
  /** The addon's own rule for "this instance can work". */
  configured(body: TBody): boolean
  /**
   * Runs after every create / update / enable / delete, IN the process that serves the instance:
   * the addon re-applies its runtime from the record (`readResolved(id)`), so an edit takes effect
   * on the next use with no respawn. `change` says what happened; a `deleted` id has no record.
   * A device-bringing addon (`description.role !== 'services'`) is expected to declare it
   * (`check-integration-instances-declared`).
   */
  onChanged?(id: string, change: InstanceChange): void | Promise<void>
  /** Probe the remote with the (possibly unsaved) values. */
  test?(input: {
    readonly id: string | null
    readonly values: Readonly<Record<string, unknown>>
  }): Promise<IntegrationTestConnectionResult>
}

/** The keys of the kind's secret fields that sit at the top level of the body. */
function topLevelSecretKeys(paths: readonly string[]): ReadonlySet<string> {
  return new Set(paths.filter((p) => !p.includes('.') && !p.includes('[') && !p.includes('{')))
}

/** The keys of the kind's top-level MAPS whose values are secrets (`applianceSecrets{}`). */
function secretMapKeys(paths: readonly string[]): ReadonlySet<string> {
  return new Set(
    paths
      .filter((p) => p.endsWith('{}') && !p.slice(0, -2).match(/[.[{]/))
      .map((p) => p.slice(0, -2)),
  )
}

/**
 * A patch value for a map of secrets: an entry that is omitted, `''`, the redaction token or the
 * view the form was given KEEPS its stored secret (it is left out of the merge); `{ $secretClear }`
 * or `null` removes the entry; any other string replaces it. Null when nothing is left to merge.
 */
function secretMapPatch(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || isSecretClear(entry)) out[key] = null
    else if (
      typeof entry === 'string' &&
      entry !== '' &&
      entry !== REDACTED_SECRET &&
      !isSecretFieldView(entry)
    ) {
      out[key] = entry
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

/** Whether an instance's secret fields were read (`resolved`) or the keychain refused (`unavailable`). */
export type ResolvedSecretsState = 'resolved' | 'unavailable'

export interface ResolvedInstance<TBody extends InstanceBody> {
  readonly id: string
  readonly body: TBody
  /** The instance's own switch; an absent value in the body reads as on. Always true for role "devices": the registry gates the addon. */
  readonly enabled: boolean
  readonly secrets: ResolvedSecretsState
}

/** Does the kind's body schema carry an `enabled` field? */
function declaresEnabled(kind: DefinedRecordKind<z.ZodType>): boolean {
  const json = z.toJSONSchema(kind.schema, {
    unrepresentable: 'any',
    io: 'input',
  })
  const properties = Reflect.get(json, 'properties')
  return typeof properties === 'object' && properties !== null && 'enabled' in properties
}

export class RecordIntegrationInstances<TBody extends InstanceBody> {
  private readonly handle: RecordKindHandle<TBody>
  private readonly secretKeys: ReadonlySet<string>
  private readonly secretMaps: ReadonlySet<string>
  private readonly nameField: string
  /** The `integrations` registry owns the on/off switch (`role: devices`); the body has none. */
  private readonly registryOwnsEnabled: boolean

  constructor(
    private readonly records: Pick<RecordsAccess, 'kind' | 'owner'>,
    private readonly kind: DefinedRecordKind<z.ZodType<TBody>>,
    private readonly hooks: RecordIntegrationInstancesHooks<TBody>,
  ) {
    this.handle = records.kind(kind)
    this.secretKeys = topLevelSecretKeys(kind.declaration.secretPaths)
    this.secretMaps = secretMapKeys(kind.declaration.secretPaths)
    this.nameField = kind.declaration.entry?.nameField ?? 'name'
    this.registryOwnsEnabled = hooks.description.role === 'devices'
    if (this.registryOwnsEnabled && declaresEnabled(kind)) {
      throw new Error(
        `kind "${kind.name}": the integrations registry owns the on/off switch of a role "devices" addon, so the body must not declare "enabled"`,
      )
    }
  }

  /**
   * One instance read for the addon's own runtime; null when absent. When the keychain is
   * locked the row is served WITHOUT its secrets and says so (`secrets: 'unavailable'`), so the
   * caller can keep what it had instead of reconfiguring with an empty secret (D49).
   */
  async readResolved(id: string): Promise<ResolvedInstance<TBody> | null> {
    try {
      const record = await this.handle.getResolved(id)
      return record === null
        ? null
        : {
            id,
            body: record.data,
            enabled: record.data.enabled !== false,
            secrets: 'resolved',
          }
    } catch (err: unknown) {
      if (!(err instanceof RecordSecretUnavailableError)) throw err
      const stored = await this.handle.get(id)
      if (stored === null) return null
      // The keychain is locked: the row WITHOUT its secrets, never the marker.
      const open = Object.fromEntries(
        Object.entries(stored.data).filter(([key]) => !this.secretKeys.has(key)),
      )
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: the stored body minus its secret keys, which the kind schema marks optional
      return {
        id,
        body: open as TBody,
        enabled: stored.data.enabled !== false,
        secrets: 'unavailable',
      }
    }
  }

  /** The body of {@link readResolved} alone; a locked keychain yields the row without secrets. */
  async getResolved(id: string): Promise<TBody | null> {
    return (await this.readResolved(id))?.body ?? null
  }

  /** Every instance, secrets resolved where the keychain allows; an absent one is skipped. */
  async listResolved(): Promise<readonly ResolvedInstance<TBody>[]> {
    const page = await this.handle.query({ limit: INSTANCES_LIST_MAX })
    const out: ResolvedInstance<TBody>[] = []
    for (const record of page.records) {
      const read = await this.readResolved(record.id)
      if (read !== null) out.push(read)
    }
    return out
  }

  private viewOf(record: RecordRow<TBody>): IntegrationInstance {
    const shown = secretViewsOf(
      this.records.owner,
      this.kind.name,
      record.id,
      this.kind.declaration,
      record.data,
    )
    const rawName = record.data[this.nameField]
    const kind = this.hooks.kindOf?.(record.data)
    const health = this.hooks.health?.(record.data, record.id)
    return {
      id: record.id,
      name: typeof rawName === 'string' ? rawName : record.id,
      configured: this.hooks.configured(record.data),
      ...(this.registryOwnsEnabled ? {} : { enabled: record.data.enabled !== false }),
      formValues: shown,
      ...(kind !== undefined ? { kind } : {}),
      ...(health?.status !== undefined ? { status: health.status } : {}),
      ...(health?.lastCheckedAt !== undefined ? { lastCheckedAt: health.lastCheckedAt } : {}),
    }
  }

  describe: IIntegrationInstancesProvider['describe'] = async () =>
    this.hooks.mintId === undefined
      ? this.hooks.description
      : { ...this.hooks.description, mintsId: true }

  instanceFormSchema: IIntegrationInstancesProvider['instanceFormSchema'] = async ({ id }) =>
    this.hooks.formSchema(id)

  listInstances: IIntegrationInstancesProvider['listInstances'] = async () => {
    const page = await this.handle.query({ limit: INSTANCES_LIST_MAX })
    return page.records.map((record) => this.viewOf(record))
  }

  getInstance: IIntegrationInstancesProvider['getInstance'] = async ({ id }) => {
    const record = await this.handle.get(id)
    return record === null ? null : this.viewOf(record)
  }

  /** Insert ONE row (`ifRev: 0`: an existing id is refused, never overwritten). */
  createInstance: IIntegrationInstancesProvider['createInstance'] = async ({
    id,
    name,
    kind,
    values,
  }) => {
    const minted = id ?? this.hooks.mintId?.({ name, ...(kind !== undefined ? { kind } : {}) })
    if (minted === undefined) {
      throw new Error('createInstance needs an id: this provider does not mint one')
    }
    await this.handle.put({ id: minted, data: this.hooks.initialBody(name, kind) }, { ifRev: 0 })
    // Form values sent with the create (a link picked in the dialog, settings a migration carries)
    // are written under the same secret rules as an update, before the addon is told.
    const patch = this.patchOf(values ?? {})
    if (Object.keys(patch).length > 0) await this.handle.patch(minted, patch)
    await this.hooks.onChanged?.(minted, 'created')
    return { id: minted }
  }

  updateInstance: IIntegrationInstancesProvider['updateInstance'] = async ({
    id,
    name,
    values,
  }) => {
    const patch = this.patchOf(values)
    if (name !== undefined) patch[this.nameField] = name
    await this.handle.patch(id, patch)
    await this.hooks.onChanged?.(id, 'updated')
    return { ok: true as const }
  }

  /** The record patch a form `values` object means: secrets kept, cleared or replaced. */
  private patchOf(values: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue
      if (this.secretMaps.has(key)) {
        const entries = secretMapPatch(value)
        if (entries !== null) patch[key] = entries
      } else if (!this.secretKeys.has(key)) {
        patch[key] = value
      } else if (isSecretClear(value)) {
        patch[key] = null
      } else if (
        typeof value === 'string' &&
        value !== '' &&
        value !== REDACTED_SECRET &&
        !isSecretFieldView(value)
      ) {
        patch[key] = value
      }
      // else: omitted / '' / redaction token / the view handed out - KEEP.
    }
    return patch
  }

  /** The switch lives in the record body; the addon is told so it applies it (D996). */
  setInstanceEnabled: IIntegrationInstancesProvider['setInstanceEnabled'] = async ({
    id,
    enabled,
  }) => {
    if (this.registryOwnsEnabled) {
      throw new Error(
        `instance "${id}": the integrations registry owns the on/off switch of this addon; set it with integrations.update`,
      )
    }
    await this.handle.patch(id, { enabled })
    await this.hooks.onChanged?.(id, 'enabled')
    return { ok: true as const }
  }

  /** The row and its keychain refs go together (the records door). */
  deleteInstance: IIntegrationInstancesProvider['deleteInstance'] = async ({ id }) => {
    await this.handle.delete(id)
    await this.hooks.onChanged?.(id, 'deleted')
    return { ok: true as const }
  }

  testInstance: NonNullable<IIntegrationInstancesProvider['testInstance']> = async (input) => {
    if (this.hooks.test === undefined) {
      return {
        success: false,
        status: 'unsupported',
        error: 'This integration declares no connection test',
      }
    }
    return this.hooks.test(input)
  }

  /** The flat provider object to hand to `registerProvider`. */
  toProvider(): IIntegrationInstancesProvider {
    return {
      describe: this.describe,
      instanceFormSchema: this.instanceFormSchema,
      listInstances: this.listInstances,
      getInstance: this.getInstance,
      createInstance: this.createInstance,
      updateInstance: this.updateInstance,
      setInstanceEnabled: this.setInstanceEnabled,
      deleteInstance: this.deleteInstance,
      testInstance: this.testInstance,
    }
  }
}
