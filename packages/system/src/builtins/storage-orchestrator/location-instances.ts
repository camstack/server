/**
 * The storage locations as `integration-instances` (planning#440 step 6, D985, D986): one
 * instance per location, one KIND per declared location type (`recordings`, `backups`, ...).
 * The form is the provider select, the provider's own fields and the location's state; the
 * credentials the provider declares go to the keychain bound to the location's record
 * (`location-secret-refs.ts`, D879).
 *
 * A location keeps ONE typed state (`mode`, D385) and only `storage-location-mode.ts` reads it.
 * The row switch maps to it: on is `active`; off is `readonly` (the write switch, D383), and a
 * location that is already `drain` or `disabled` stays as it is. Delete keeps the occupancy
 * refusal; the forced delete is NOT a flag here, it is the separate `forceDeleteLocation`
 * action (D49: destructive, confirmed by a second read).
 *
 * The edit form is the provider's schema as it is. The create form offers every provider, so
 * each provider's fields are namespaced `<providerId>.<key>` and shown for that provider; a
 * `notEquals` / `notIn` condition on a select is rewritten to the options it leaves, because the
 * selector of another provider is unset and an unset value would satisfy a negation.
 */
import {
  type ConfigCondition,
  type ConfigField,
  type ConfigSection,
  type ConfigUISchema,
  type IIntegrationInstancesProvider,
  type IntegrationInstance,
  type IntegrationInstanceDescription,
  type IntegrationInstanceKind,
  type IntegrationTestConnectionResult,
  isSecretClear,
  isSecretFieldView,
  isSecretMarker,
  modeForSwitch,
  REDACTED_SECRET,
  resolveLocationMode,
  STORAGE_LOCATION_MODES,
  type StorageLocation,
  type StorageLocationDeclaration,
  type StorageLocationMode,
  switchStateOfMode,
  toSecretFieldView,
} from '@camstack/types'
import type { StorageProviderListEntry } from './provider-discovery.js'

export const STORAGE_INSTANCE_KIND = 'storage-location'
export const STORAGE_FUNCTION_CAP = 'storage'
/** The generic widget id the admin UI maps to its path browser. */
export const STORAGE_PATH_WIDGET = 'storage/path-browser'
/** A probe of a remote provider waits this long; a hung host must not hang the form. */
export const LOCATION_TEST_TIMEOUT_MS = 20_000

const PROVIDER_FIELD = 'providerId'
const MODE_FIELD = 'mode'
const NODE_FIELD = 'nodeId'
const MIN_FREE_FIELD = 'minFreePercent'
const MAX_USED_FIELD = 'maxUsedGb'
/** Config keys the framework owns; a provider never declares them. */
const FRAMEWORK_NUMBER_KEYS: readonly string[] = [MIN_FREE_FIELD, MAX_USED_FIELD]
/** The legacy mirror of the mode; it is derived and never part of a form. */
const LEGACY_READ_ONLY = 'readOnly'
const LOCATION_ID_SLUG = /^[a-z0-9-]+$/

export type LocationSaveInput = Omit<StorageLocation, 'createdAt' | 'updatedAt'>

export interface LocationInstancesDeps {
  readonly locations: () => readonly StorageLocation[]
  readonly declarations: () => readonly StorageLocationDeclaration[]
  readonly providers: () => Promise<readonly StorageProviderListEntry[]>
  /** The one save every door goes through; `clearSecrets` names the credentials to remove. */
  readonly save: (
    input: LocationSaveInput,
    clearSecrets: readonly string[],
  ) => Promise<StorageLocation>
  /** Delete with the occupancy refusal; `force` is never passed from this provider. */
  readonly remove: (id: string) => Promise<void>
  /** Probe a config (markers allowed) against a provider; the addon resolves the markers. */
  readonly probe: (
    providerId: string,
    config: Readonly<Record<string, unknown>>,
  ) => Promise<{ readonly ok: boolean; readonly error?: string }>
  /** The config keys that are credentials; fails closed for an unregistered provider. */
  readonly secretKeys: (
    providerId: string,
    config: Readonly<Record<string, unknown>>,
  ) => ReadonlySet<string>
  readonly testTimeoutMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isConfigField(value: unknown): value is ConfigField {
  return (
    isRecord(value) &&
    typeof value['key'] === 'string' &&
    typeof value['label'] === 'string' &&
    typeof value['type'] === 'string'
  )
}

function isConfigSection(value: unknown): value is ConfigSection {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['title'] === 'string' &&
    Array.isArray(value['fields']) &&
    value['fields'].every(isConfigField)
  )
}

/** The sections a provider's `configSchema` carries; anything else is no form. */
export function providerSections(schema: unknown): readonly ConfigSection[] {
  if (!isRecord(schema)) return []
  const sections = schema['sections']
  return Array.isArray(sections) ? sections.filter(isConfigSection) : []
}

function isStorageMode(value: unknown): value is StorageLocationMode {
  return STORAGE_LOCATION_MODES.some((mode) => mode === value)
}

function namespaced(providerId: string, key: string): string {
  return `${providerId}.${key}`
}

function conditionOf(field: ConfigField): ConfigCondition | undefined {
  return 'showWhen' in field ? field.showWhen : undefined
}

/** The field under a new key and a new condition (a field type without one ignores it). */
function placed(field: ConfigField, key: string, showWhen: ConfigCondition): ConfigField {
  return Object.assign({}, field, { key, showWhen })
}

/** A provider's field as the create form shows it: its own key space, shown for that provider. */
function namespacedField(
  providerId: string,
  field: ConfigField,
  siblings: readonly ConfigField[],
): ConfigField {
  const key = namespaced(providerId, field.key)
  // An object-array field carries no condition and is left to the provider's own layout.
  if (field.type === 'object-array') return { ...field, key }
  const own = conditionOf(field)
  if (own === undefined) return placed(field, key, { field: PROVIDER_FIELD, equals: providerId })
  const sibling = siblings.find((f) => f.key === own.field)
  let showWhen: ConfigCondition = {
    ...own,
    field: namespaced(providerId, own.field),
  }
  if (sibling?.type === 'select') {
    const values = sibling.options.map((option) => option.value)
    if (own.notEquals !== undefined) {
      const excluded = own.notEquals
      const { notEquals: _dropped, ...rest } = showWhen
      showWhen = { ...rest, in: values.filter((value) => value !== excluded) }
    } else if (own.notIn !== undefined) {
      const excluded = own.notIn
      const { notIn: _dropped, ...rest } = showWhen
      showWhen = {
        ...rest,
        in: values.filter((value) => !excluded.includes(value)),
      }
    }
  }
  return placed(field, key, showWhen)
}

function createProviderSections(providers: readonly StorageProviderListEntry[]): ConfigSection[] {
  return providers.flatMap((provider) =>
    providerSections(provider.configSchema).map((section) => {
      const all = providerSections(provider.configSchema).flatMap((s) => s.fields)
      return {
        ...section,
        id: `${provider.providerId}:${section.id}`,
        fields: section.fields.map((field) => namespacedField(provider.providerId, field, all)),
      }
    }),
  )
}

/**
 * Where the location lives. On an existing location its state (`mode`) is not a form field: the
 * admin page changes it through its own control, which knows the last-writable guard and confirms
 * `disabled`. A new location asks only whether it takes writes or is only read (`withState`).
 */
function stateSection(nodeLocalIds: readonly string[] | null, withState = false): ConfigSection {
  const fields: ConfigField[] = []
  if (withState) {
    fields.push({
      type: 'select',
      key: MODE_FIELD,
      label: 'State',
      default: 'active',
      options: [
        { value: 'active', label: 'Active' },
        { value: 'readonly', label: 'Read-only' },
      ],
    })
  }
  if (nodeLocalIds === null || nodeLocalIds.length > 0) {
    fields.push({
      type: 'text',
      key: NODE_FIELD,
      label: 'Node',
      description: 'The node whose disk this location is. Empty means the hub.',
      ...(nodeLocalIds === null
        ? {}
        : { showWhen: { field: PROVIDER_FIELD, in: [...nodeLocalIds] } }),
    })
  }
  return { id: 'state', title: withState ? 'Placement' : 'Node', columns: 1, fields }
}

function protectionSection(): ConfigSection {
  return {
    id: 'protection',
    title: 'Disk protection',
    columns: 2,
    fields: [
      {
        type: 'number',
        key: MIN_FREE_FIELD,
        label: 'Keep free (%)',
        min: 0,
        max: 100,
      },
      {
        type: 'number',
        key: MAX_USED_FIELD,
        label: 'Use at most (GB)',
        min: 0,
      },
    ],
  }
}

function stateOf(location: StorageLocation): StorageLocationMode {
  return resolveLocationMode(location)
}

/** A form value that names a credential KEPT: left out, empty, the redaction token or the view. */
function keepsSecret(value: unknown): boolean {
  return (
    value === undefined ||
    value === '' ||
    value === REDACTED_SECRET ||
    isSecretFieldView(value) ||
    isSecretMarker(value)
  )
}

function numberOrNull(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export class StorageLocationInstances {
  constructor(private readonly deps: LocationInstancesDeps) {}

  private kinds(): readonly IntegrationInstanceKind[] {
    return this.deps.declarations().map((declaration) => ({
      id: declaration.id,
      label: declaration.displayName,
      functionCap: STORAGE_FUNCTION_CAP,
      role: 'services' as const,
      canTest: true,
      // The folder of a node-local provider is picked by browsing that node's disk.
      widgets: [{ id: STORAGE_PATH_WIDGET, placement: 'connection' as const }],
    }))
  }

  private viewOf(location: StorageLocation): IntegrationInstance {
    const mode = stateOf(location)
    const secretKeys = this.deps.secretKeys(location.providerId, location.config)
    const formValues: Record<string, unknown> = {
      [PROVIDER_FIELD]: location.providerId,
      [MODE_FIELD]: mode,
    }
    if (location.nodeId !== undefined) formValues[NODE_FIELD] = location.nodeId
    for (const [key, value] of Object.entries(location.config)) {
      if (key === LEGACY_READ_ONLY) continue
      if (secretKeys.has(key)) {
        const view = toSecretFieldView(value)
        if (view !== null) formValues[key] = view
      } else {
        formValues[key] = value
      }
    }
    return {
      id: location.id,
      name: location.displayName,
      configured: true,
      enabled: switchStateOfMode(mode),
      kind: location.type,
      formValues,
      status: { state: switchStateOfMode(mode) ? 'ok' : 'off', label: mode },
    }
  }

  describe: IIntegrationInstancesProvider['describe'] =
    async (): Promise<IntegrationInstanceDescription> => ({
      role: 'services',
      instanceMode: 'multiple',
      kind: STORAGE_INSTANCE_KIND,
      canTest: true,
      mintsId: true,
      kinds: [...this.kinds()],
    })

  instanceFormSchema: IIntegrationInstancesProvider['instanceFormSchema'] = async ({
    id,
  }): Promise<ConfigUISchema> => {
    const providers = await this.deps.providers()
    if (id === null) {
      const nodeLocal = providers.filter((p) => p.nodeLocal).map((p) => p.providerId)
      return {
        sections: [
          {
            id: 'provider',
            title: 'Provider',
            columns: 1,
            fields: [
              {
                type: 'select',
                key: PROVIDER_FIELD,
                label: 'Provider',
                required: true,
                options: providers.map((p) => ({
                  value: p.providerId,
                  label: p.displayName,
                })),
              },
            ],
          },
          ...createProviderSections(providers),
          stateSection(nodeLocal, true),
          protectionSection(),
        ],
      }
    }
    const location = this.deps.locations().find((l) => l.id === id)
    if (location === undefined) throw new Error(`storage location '${id}' not found`)
    const provider = providers.find((p) => p.providerId === location.providerId)
    return {
      sections: [
        stateSection(provider?.nodeLocal === true ? [location.providerId] : []),
        ...(provider === undefined ? [] : providerSections(provider.configSchema)),
        protectionSection(),
      ],
    }
  }

  listInstances: IIntegrationInstancesProvider['listInstances'] = async () =>
    this.deps.locations().map((location) => this.viewOf(location))

  getInstance: IIntegrationInstancesProvider['getInstance'] = async ({ id }) => {
    const location = this.deps.locations().find((l) => l.id === id)
    return location === undefined ? null : this.viewOf(location)
  }

  /**
   * The config and credentials a form `values` object means for a provider: its own namespaced
   * keys (create form) or plain keys (edit form), the framework numbers, nothing of another
   * provider. `base` is the stored config; a credential kept stays as stored.
   */
  private configFrom(
    providerId: string,
    values: Readonly<Record<string, unknown>>,
    base: Readonly<Record<string, unknown>>,
  ): {
    readonly config: Record<string, unknown>
    readonly clear: readonly string[]
  } {
    const config: Record<string, unknown> = { ...base }
    const clear: string[] = []
    const prefix = `${providerId}.`
    const secretKeys = this.deps.secretKeys(providerId, base)
    const named: Array<readonly [string, unknown]> = []
    for (const [raw, value] of Object.entries(values)) {
      if (raw === PROVIDER_FIELD || raw === MODE_FIELD || raw === NODE_FIELD) continue
      if (raw.startsWith(prefix)) named.push([raw.slice(prefix.length), value])
      else if (!raw.includes('.')) named.push([raw, value])
    }
    for (const [key, value] of named) {
      if (value === undefined) continue
      if (FRAMEWORK_NUMBER_KEYS.includes(key)) {
        const number = numberOrNull(value)
        if (number === null) delete config[key]
        else if (number !== undefined) config[key] = number
        continue
      }
      if (secretKeys.has(key)) {
        if (isSecretClear(value)) clear.push(key)
        else if (keepsSecret(value)) continue
        else if (typeof value === 'string') config[key] = value
        continue
      }
      if (value === null || value === '') delete config[key]
      else config[key] = value
    }
    return { config, clear }
  }

  private async mintId(kind: string, name: string): Promise<string> {
    const taken = new Set(this.deps.locations().map((l) => l.id))
    const slug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    const base = `${kind}:${slug.length > 0 ? slug : 'default'}`
    if (!taken.has(base)) return base
    for (let n = 2; ; n += 1) {
      const candidate = `${base}-${n}`
      if (!taken.has(candidate)) return candidate
    }
  }

  createInstance: IIntegrationInstancesProvider['createInstance'] = async ({
    id,
    name,
    kind,
    values,
  }) => {
    const form = values ?? {}
    const declared = this.deps.declarations()
    const type = kind ?? (declared.length === 1 ? declared[0]?.id : undefined)
    if (type === undefined) throw new Error('pick the kind of location first')
    if (!declared.some((d) => d.id === type)) throw new Error(`unknown location kind '${type}'`)
    const providerId = form[PROVIDER_FIELD]
    if (typeof providerId !== 'string' || providerId === '') throw new Error('pick a provider')
    const minted = id ?? (await this.mintId(type, name))
    const slug = minted.slice(type.length + 1)
    if (!minted.startsWith(`${type}:`) || !LOCATION_ID_SLUG.test(slug)) {
      throw new Error(`id must be '${type}:<slug>' (lowercase letters, digits and hyphens)`)
    }
    if (this.deps.locations().some((l) => l.id === minted)) {
      throw new Error(`storage location '${minted}' already exists`)
    }
    const { config, clear } = this.configFrom(providerId, form, {})
    const mode = form[MODE_FIELD]
    const node = form[NODE_FIELD]
    await this.deps.save(
      {
        id: minted,
        type,
        displayName: name,
        providerId,
        config,
        isSystem: false,
        ...(typeof node === 'string' && node !== '' ? { nodeId: node } : {}),
        ...(isStorageMode(mode) ? { mode } : {}),
      },
      clear,
    )
    return { id: minted }
  }

  /** The whole location again, from the stored row, with `patch` on top (the save REPLACES). */
  private rebuilt(
    stored: StorageLocation,
    patch: {
      readonly displayName?: string
      readonly config?: Readonly<Record<string, unknown>>
      readonly mode?: StorageLocationMode
      readonly nodeId?: string
    },
  ): LocationSaveInput {
    const nodeId = patch.nodeId ?? stored.nodeId
    return {
      id: stored.id,
      type: stored.type,
      displayName: patch.displayName ?? stored.displayName,
      providerId: stored.providerId,
      config: patch.config ?? stored.config,
      isSystem: stored.isSystem,
      ...(nodeId !== undefined ? { nodeId } : {}),
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
    }
  }

  updateInstance: IIntegrationInstancesProvider['updateInstance'] = async ({
    id,
    name,
    values,
  }) => {
    const stored = this.deps.locations().find((l) => l.id === id)
    if (stored === undefined) throw new Error(`storage location '${id}' not found`)
    const { config, clear } = this.configFrom(stored.providerId, values, stored.config)
    const mode = values[MODE_FIELD]
    const node = values[NODE_FIELD]
    await this.deps.save(
      this.rebuilt(stored, {
        ...(name !== undefined ? { displayName: name } : {}),
        config,
        ...(isStorageMode(mode) ? { mode } : {}),
        ...(typeof node === 'string' && node !== '' ? { nodeId: node } : {}),
      }),
      clear,
    )
    return { ok: true as const }
  }

  setInstanceEnabled: IIntegrationInstancesProvider['setInstanceEnabled'] = async ({
    id,
    enabled,
  }) => {
    const stored = this.deps.locations().find((l) => l.id === id)
    if (stored === undefined) throw new Error(`storage location '${id}' not found`)
    const current = stateOf(stored)
    const move = modeForSwitch(enabled, current)
    if (move.kind === 'refuse') throw new Error(`storage location '${id}': ${move.reason}`)
    if (move.kind === 'set') await this.deps.save(this.rebuilt(stored, { mode: move.mode }), [])
    return { ok: true as const }
  }

  /** The occupancy refusal stays; the forced delete is the separate action. */
  deleteInstance: IIntegrationInstancesProvider['deleteInstance'] = async ({ id }) => {
    await this.deps.remove(id)
    return { ok: true as const }
  }

  testInstance: NonNullable<IIntegrationInstancesProvider['testInstance']> = async ({
    id,
    values,
  }) => {
    const stored = id === null ? undefined : this.deps.locations().find((l) => l.id === id)
    if (id !== null && stored === undefined) {
      return {
        success: false,
        status: 'inconclusive',
        error: `storage location '${id}' not found`,
      }
    }
    const formProvider = values[PROVIDER_FIELD]
    const providerId = stored?.providerId ?? (typeof formProvider === 'string' ? formProvider : '')
    if (providerId === '') {
      return {
        success: false,
        status: 'inconclusive',
        error: 'Pick a provider first',
      }
    }
    const { config } = this.configFrom(providerId, values, stored?.config ?? {})
    // A credential the form set replaces the stored one for this probe only: nothing is saved.
    const started = Date.now()
    const limit = this.deps.testTimeoutMs ?? LOCATION_TEST_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<IntegrationTestConnectionResult>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            success: false,
            status: 'inconclusive',
            error: `The provider did not answer within ${Math.round(limit / 1000)} s`,
          }),
        limit,
      )
    })
    const probe = this.deps
      .probe(providerId, config)
      .then(
        (result): IntegrationTestConnectionResult =>
          result.ok
            ? {
                success: true,
                status: 'validated',
                latencyMs: Date.now() - started,
              }
            : {
                success: false,
                status: 'rejected',
                error: result.error ?? 'The provider refused this configuration',
              },
      )
      .catch(
        (err: unknown): IntegrationTestConnectionResult => ({
          success: false,
          status: 'inconclusive',
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    try {
      return await Promise.race([probe, timedOut])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

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
