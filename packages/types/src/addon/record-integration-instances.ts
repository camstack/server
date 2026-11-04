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
import type { z } from 'zod'
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
export type InstanceBody = Record<string, unknown> & { readonly enabled?: boolean | undefined }

export interface RecordIntegrationInstancesHooks<TBody extends InstanceBody> {
  /** Includes the optional `kinds` and `allowRestoreId` a provider offers the Add flow. */
  readonly description: IntegrationInstanceDescription
  /** The form; `id: null` is the create form. */
  formSchema(id: string | null): ConfigUISchema
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
  health?(body: TBody): {
    readonly status?: IntegrationInstanceStatus
    readonly lastCheckedAt?: number
  }
  /** The addon's own rule for "this instance can work". */
  configured(body: TBody): boolean
  /** Runs after every create / update / delete; the addon re-applies its runtime. */
  onChanged?(id: string): void | Promise<void>
  /** Probe the remote with the (possibly unsaved) values. */
  test?(input: {
    readonly id: string | null
    readonly values: Readonly<Record<string, unknown>>
  }): Promise<IntegrationTestConnectionResult>
}

/** The keys of the kind's secret fields that sit at the top level of the body. */
function topLevelSecretKeys(paths: readonly string[]): ReadonlySet<string> {
  return new Set(paths.filter((p) => !p.includes('.') && !p.includes('[')))
}

/** Whether an instance's secret fields were read (`resolved`) or the keychain refused (`unavailable`). */
export type ResolvedSecretsState = 'resolved' | 'unavailable'

export interface ResolvedInstance<TBody extends InstanceBody> {
  readonly id: string
  readonly body: TBody
  /** The instance's own switch; an absent value in the body reads as on. */
  readonly enabled: boolean
  readonly secrets: ResolvedSecretsState
}

export class RecordIntegrationInstances<TBody extends InstanceBody> {
  private readonly handle: RecordKindHandle<TBody>
  private readonly secretKeys: ReadonlySet<string>
  private readonly nameField: string

  constructor(
    private readonly records: Pick<RecordsAccess, 'kind' | 'owner'>,
    private readonly kind: DefinedRecordKind<z.ZodType<TBody>>,
    private readonly hooks: RecordIntegrationInstancesHooks<TBody>,
  ) {
    this.handle = records.kind(kind)
    this.secretKeys = topLevelSecretKeys(kind.declaration.secretPaths)
    this.nameField = kind.declaration.entry?.nameField ?? 'name'
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
        : { id, body: record.data, enabled: record.data.enabled !== false, secrets: 'resolved' }
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
    const health = this.hooks.health?.(record.data)
    return {
      id: record.id,
      name: typeof rawName === 'string' ? rawName : record.id,
      configured: this.hooks.configured(record.data),
      enabled: record.data.enabled !== false,
      formValues: shown,
      ...(kind !== undefined ? { kind } : {}),
      ...(health?.status !== undefined ? { status: health.status } : {}),
      ...(health?.lastCheckedAt !== undefined ? { lastCheckedAt: health.lastCheckedAt } : {}),
    }
  }

  describe: IIntegrationInstancesProvider['describe'] = async () => this.hooks.description

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
  createInstance: IIntegrationInstancesProvider['createInstance'] = async ({ id, name, kind }) => {
    const minted = id ?? this.hooks.mintId?.({ name, ...(kind !== undefined ? { kind } : {}) })
    if (minted === undefined) {
      throw new Error('createInstance needs an id: this provider does not mint one')
    }
    await this.handle.put({ id: minted, data: this.hooks.initialBody(name, kind) }, { ifRev: 0 })
    await this.hooks.onChanged?.(minted)
    return { id: minted }
  }

  updateInstance: IIntegrationInstancesProvider['updateInstance'] = async ({
    id,
    name,
    values,
  }) => {
    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue
      if (!this.secretKeys.has(key)) {
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
    if (name !== undefined) patch[this.nameField] = name
    await this.handle.patch(id, patch)
    await this.hooks.onChanged?.(id)
    return { ok: true as const }
  }

  /** The switch lives in the record body; the addon is told so it applies it (D996). */
  setInstanceEnabled: IIntegrationInstancesProvider['setInstanceEnabled'] = async ({
    id,
    enabled,
  }) => {
    await this.handle.patch(id, { enabled })
    await this.hooks.onChanged?.(id)
    return { ok: true as const }
  }

  /** The row and its keychain refs go together (the records door). */
  deleteInstance: IIntegrationInstancesProvider['deleteInstance'] = async ({ id }) => {
    await this.handle.delete(id)
    await this.hooks.onChanged?.(id)
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
