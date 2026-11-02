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

export interface RecordIntegrationInstancesHooks<TBody extends Record<string, unknown>> {
  readonly description: {
    readonly instanceMode: 'single' | 'multiple'
    readonly kind: string
    readonly canTest: boolean
  }
  /** The form; `id: null` is the create form. */
  formSchema(id: string | null): ConfigUISchema
  /** The body a new instance starts with. It must satisfy the kind's schema. */
  initialBody(name: string): TBody
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

export class RecordIntegrationInstances<TBody extends Record<string, unknown>> {
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

  /** One instance with its secrets resolved, for the addon's own runtime; null when absent. */
  async getResolved(id: string): Promise<TBody | null> {
    let record: RecordRow<TBody> | null
    try {
      record = await this.handle.getResolved(id)
    } catch (err: unknown) {
      if (!(err instanceof RecordSecretUnavailableError)) throw err
      const stored = await this.handle.get(id)
      if (stored === null) return null
      // The keychain is locked: serve the row WITHOUT its secrets, never the marker.
      const open = Object.fromEntries(
        Object.entries(stored.data).filter(([key]) => !this.secretKeys.has(key)),
      )
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: the stored body minus its secret keys, which the kind schema marks optional
      return open as TBody
    }
    return record === null ? null : record.data
  }

  /** Every instance with its secrets resolved; one that cannot be read is skipped. */
  async listResolved(): Promise<readonly { readonly id: string; readonly body: TBody }[]> {
    const page = await this.handle.query({ limit: INSTANCES_LIST_MAX })
    const out: { id: string; body: TBody }[] = []
    for (const record of page.records) {
      const body = await this.getResolved(record.id)
      if (body !== null) out.push({ id: record.id, body })
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
    return {
      id: record.id,
      name: typeof rawName === 'string' ? rawName : record.id,
      configured: this.hooks.configured(record.data),
      formValues: shown,
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
  createInstance: IIntegrationInstancesProvider['createInstance'] = async ({ id, name }) => {
    await this.handle.put({ id, data: this.hooks.initialBody(name) }, { ifRev: 0 })
    await this.hooks.onChanged?.(id)
    return { id }
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
      deleteInstance: this.deleteInstance,
      testInstance: this.testInstance,
    }
  }
}
