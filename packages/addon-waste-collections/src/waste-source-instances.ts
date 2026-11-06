/**
 * The waste sources as `integration-instances` (planning#440 step 6): one instance per
 * `waste-source` record, of the function cap `calendar-source`. The form is derived from the
 * service catalog: the create form picks a country, which shows that country's services; the
 * edit form is the fields of the service the source was created for. A credential argument is a
 * password field the records door keeps in the keychain, bound to the row.
 */
import {
  type ConfigField,
  type ConfigUISchema,
  type IIntegrationInstancesProvider,
  type InstanceChange,
  type IntegrationInstance,
  type IntegrationInstanceDescription,
  type IntegrationInstanceKind,
  type IntegrationTestConnectionResult,
  isInstanceEnabled,
  isSecretClear,
  isSecretFieldView,
  REDACTED_SECRET,
  RecordIntegrationInstances,
  type RecordKindHandle,
  type RecordRow,
  type RecordsAccess,
  secretViewsOf,
} from '@camstack/types'
import {
  type FetchSourceDeps,
  fetchWasteSource,
  WasteFetchTimeoutError,
  WasteProviderRejectedError,
} from './fetch-source.js'
import { allocateSourceId, SOURCE_ID_PATTERN } from './source-id.js'
import {
  type CatalogService,
  findCatalogService,
  listCatalogCountries,
  listCatalogServices,
  matchCatalogService,
  mergeServiceArgs,
  serviceDisplayLabel,
  serviceFormSchema,
} from './waste-catalog.js'
import { hasUnresolvedCredential, isSecretArg } from './waste-secrets.js'
import { type WasteSourceBody, wasteSourceEntryKind } from './waste-source-record-kinds.js'
import { WasteSourceStore } from './waste-source-store.js'
import type { WasteCollectionEntry } from './waste-types.js'

export const WASTE_INSTANCE_KIND = 'waste-source'
export const COUNTRY_FIELD = 'countryId'

/** A probe waits this long for the provider; the daily refresh keeps its own, longer bound. */
export const WASTE_TEST_TIMEOUT_MS = 45_000

/** The create form's service select of one country; one per country, shown by `countryId`. */
export function serviceFieldKey(countryId: string): string {
  return `service:${countryId}`
}

const KIND: IntegrationInstanceKind = {
  id: WASTE_INSTANCE_KIND,
  label: 'Waste collection source',
  functionCap: 'calendar-source',
  role: 'services',
  canTest: true,
}

const DESCRIPTION: IntegrationInstanceDescription = {
  role: 'services',
  instanceMode: 'multiple',
  kind: WASTE_INSTANCE_KIND,
  canTest: true,
  mintsId: true,
  kinds: [KIND],
}

type ArgValue = string | number | boolean
type ArgPatch = Record<string, ArgValue | null>

export type WasteFetcher = (
  deps: FetchSourceDeps,
  input: {
    readonly source: string
    readonly args: Readonly<Record<string, unknown>>
  },
) => Promise<readonly WasteCollectionEntry[]>

export interface WasteInstancesDeps {
  /** Re-read the sources after any change, in the process that serves them. */
  readonly onChanged: (id: string, change: InstanceChange) => Promise<void>
  /** Where the provider script runs; null while the embedded Python is unavailable. */
  readonly fetchDeps: () => FetchSourceDeps | null
  /** The probe; the real fetch unless a spec supplies one. */
  readonly fetch?: WasteFetcher
}

function isArgValue(value: unknown): value is ArgValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/** A form key that is not an argument of the source. */
function isFormControl(key: string): boolean {
  return (
    key === COUNTRY_FIELD || key === 'serviceId' || key === 'enabled' || key.startsWith('service:')
  )
}

/**
 * The argument patch a form `values` object means. A credential left out, empty, the redaction
 * token or the view the form was given KEEPS what is stored; `{ $secretClear: true }` clears it;
 * any other text replaces it. An emptied plain field is removed.
 */
function argPatchOf(values: Readonly<Record<string, unknown>>): ArgPatch {
  const patch: ArgPatch = {}
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || isFormControl(key)) continue
    if (isSecretArg(key)) {
      if (isSecretClear(value)) patch[key] = null
      else if (
        typeof value === 'string' &&
        value !== '' &&
        value !== REDACTED_SECRET &&
        !isSecretFieldView(value)
      ) {
        patch[key] = value
      }
    } else if (value === null || value === '') {
      patch[key] = null
    } else if (isArgValue(value)) {
      patch[key] = value
    }
  }
  return patch
}

/** The patch as the arguments of a NEW source: nothing is stored yet, so a removal is nothing. */
function freshArgs(values: Readonly<Record<string, unknown>>): Record<string, ArgValue> {
  const out: Record<string, ArgValue> = {}
  for (const [key, value] of Object.entries(argPatchOf(values))) {
    if (value !== null) out[key] = value
  }
  return out
}

function serviceIdOf(values: Readonly<Record<string, unknown>>): string | undefined {
  const country: unknown = values[COUNTRY_FIELD]
  const nested: unknown = typeof country === 'string' ? values[serviceFieldKey(country)] : undefined
  const flat: unknown = values['serviceId']
  const picked = typeof nested === 'string' && nested !== '' ? nested : flat
  return typeof picked === 'string' && picked !== '' ? picked : undefined
}

/** The create form: a country, then that country's services. */
function createFormSchema(): ConfigUISchema {
  const countries = listCatalogCountries()
  const serviceFields: ConfigField[] = countries.map((country) => ({
    type: 'select',
    key: serviceFieldKey(country.id),
    label: 'Service',
    options: listCatalogServices(country.id).map((s) => ({
      value: s.id,
      label: serviceDisplayLabel(s),
    })),
    showWhen: { field: COUNTRY_FIELD, equals: country.id },
  }))
  return {
    sections: [
      {
        id: 'service',
        title: 'Calendar service',
        description: 'Pick the country, then the service that publishes your collection calendar.',
        columns: 1,
        fields: [
          {
            type: 'select',
            key: COUNTRY_FIELD,
            label: 'Country',
            options: countries.map((c) => ({ value: c.id, label: c.label })),
          },
          ...serviceFields,
        ],
      },
    ],
  }
}

/** The edit form: only the fields of the service. The name and the switch are row controls. */
function editFormSchema(service: CatalogService | undefined): ConfigUISchema {
  if (service === undefined) {
    return {
      sections: [
        {
          id: 'args',
          title: 'Calendar service',
          description: 'This source matches no service of the catalog; delete it and add it again.',
          columns: 1,
          fields: [],
        },
      ],
    }
  }
  const args = serviceFormSchema(service).sections.filter((section) => section.id === 'args')
  return { sections: args }
}

function plainArgsOf(body: WasteSourceBody): Record<string, unknown> {
  return { ...body.args }
}

/** A test result that names no value of the source: a credential never reaches an error text. */
function scrubbed(message: string, args: Readonly<Record<string, unknown>>): string {
  let out = message
  for (const [key, value] of Object.entries(args)) {
    if (isSecretArg(key) && typeof value === 'string' && value.length > 0) {
      out = out.split(value).join('***')
    }
  }
  return out
}

export class WasteSourceInstances {
  private readonly handle: RecordKindHandle<WasteSourceBody>
  private readonly store: WasteSourceStore
  /** The one switch (D996): the record body's `enabled`, written by the shared helper only. */
  private readonly rowSwitch: RecordIntegrationInstances<WasteSourceBody>

  constructor(
    private readonly records: Pick<RecordsAccess, 'kind' | 'owner'>,
    private readonly deps: WasteInstancesDeps,
  ) {
    this.handle = records.kind(wasteSourceEntryKind)
    this.store = new WasteSourceStore(this.handle)
    this.rowSwitch = new RecordIntegrationInstances(records, wasteSourceEntryKind, {
      description: DESCRIPTION,
      formSchema: () => createFormSchema(),
      initialBody: (id) => {
        // A source is created by `createInstance` (service picked); the switch never invents one.
        throw new Error(`source '${id}' not found`)
      },
      configured: () => true,
      onChanged: (id, change) => deps.onChanged(id, change),
    })
  }

  private viewOf(record: RecordRow<WasteSourceBody>): IntegrationInstance {
    const body = record.data
    const matched = matchCatalogService(body.module, plainArgsOf(body))
    const shown = secretViewsOf(
      this.records.owner,
      wasteSourceEntryKind.name,
      record.id,
      wasteSourceEntryKind.declaration,
      { ...body },
    )
    const shownArgs: unknown = shown['args']
    const formValues: Record<string, unknown> =
      typeof shownArgs === 'object' && shownArgs !== null ? { ...shownArgs } : {}
    if (matched !== undefined) {
      for (const key of Object.keys(matched.defaultArgs)) delete formValues[key]
      formValues['serviceId'] = matched.id
      formValues[COUNTRY_FIELD] = matched.countryId
    }
    const configured =
      matched === undefined ||
      matched.fields.every((f) => !f.required || (body.args[f.key] ?? '') !== '')
    return {
      id: record.id,
      name: body.name,
      configured,
      enabled: isInstanceEnabled(body),
      kind: WASTE_INSTANCE_KIND,
      formValues,
    }
  }

  describe: IIntegrationInstancesProvider['describe'] = async () => DESCRIPTION

  instanceFormSchema: IIntegrationInstancesProvider['instanceFormSchema'] = async ({ id }) => {
    if (id === null) return createFormSchema()
    const source = await this.store.readResolved(id)
    if (source === null) throw new Error(`source '${id}' not found`)
    return editFormSchema(matchCatalogService(source.module, source.args))
  }

  listInstances: IIntegrationInstancesProvider['listInstances'] = async () => {
    const page = await this.handle.query({ limit: 1000 })
    return page.records.map((record) => this.viewOf(record))
  }

  getInstance: IIntegrationInstancesProvider['getInstance'] = async ({ id }) => {
    const record = await this.handle.get(id)
    return record === null ? null : this.viewOf(record)
  }

  createInstance: IIntegrationInstancesProvider['createInstance'] = async ({
    id,
    name,
    values,
  }) => {
    const form = values ?? {}
    const serviceId = serviceIdOf(form)
    if (serviceId === undefined) throw new Error('pick a country and a service')
    const service = findCatalogService(serviceId)
    if (service === undefined) throw new Error(`unknown service '${serviceId}'`)
    const taken = await this.store.listIds()
    if (id !== undefined && !SOURCE_ID_PATTERN.test(id)) {
      throw new Error('id must be a lowercase slug (e.g. ics-home, junker)')
    }
    const minted = id ?? allocateSourceId(name, taken)
    const parsed = wasteSourceEntryKind.schema.safeParse({
      name,
      module: service.module,
      args: mergeServiceArgs(service, freshArgs(form)),
      enabled: true,
    })
    if (!parsed.success) throw new Error(`invalid waste source: ${parsed.error.message}`)
    // `ifRev: 0`: an id that already exists is refused, never overwritten.
    await this.handle.put({ id: minted, data: parsed.data }, { ifRev: 0 })
    await this.deps.onChanged(minted, 'created')
    return { id: minted }
  }

  updateInstance: IIntegrationInstancesProvider['updateInstance'] = async ({
    id,
    name,
    values,
  }) => {
    if ((await this.handle.get(id)) === null) throw new Error(`source '${id}' not found`)
    const args = argPatchOf(values)
    const patch: Record<string, unknown> = {
      ...(Object.keys(args).length > 0 ? { args } : {}),
      ...(name !== undefined ? { name } : {}),
    }
    if (Object.keys(patch).length > 0) await this.handle.patch(id, patch)
    await this.deps.onChanged(id, 'updated')
    return { ok: true as const }
  }

  /** The row and its keychain refs go together (the records door). */
  deleteInstance: IIntegrationInstancesProvider['deleteInstance'] = async ({ id }) => {
    await this.handle.delete(id)
    await this.deps.onChanged(id, 'deleted')
    return { ok: true as const }
  }

  /**
   * Fetch the source once. `validated`: the provider answered with collections. `rejected`: the
   * provider ran and refused these arguments. `inconclusive`: nothing is known (no Python, a
   * locked keychain, a timeout, no collections in the answer).
   */
  testInstance: NonNullable<IIntegrationInstancesProvider['testInstance']> = async ({
    id,
    values,
  }) => {
    const target = await this.probeTarget(id, values)
    if ('result' in target) return target.result
    const missing = missingRequiredArgs(target)
    if (missing.length > 0) {
      return {
        success: false,
        status: 'inconclusive',
        error: `Configure the source first: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required before it can be tested`,
      }
    }
    const fetchDeps = this.deps.fetchDeps()
    if (fetchDeps === null) {
      return {
        success: false,
        status: 'inconclusive',
        error: 'The embedded Python is not available on this node',
      }
    }
    const run = this.deps.fetch ?? fetchWasteSource
    const started = Date.now()
    try {
      const entries = await run(
        { ...fetchDeps, timeoutMs: WASTE_TEST_TIMEOUT_MS },
        { source: target.module, args: target.args },
      )
      const latencyMs = Date.now() - started
      if (entries.length === 0) {
        return {
          success: false,
          status: 'inconclusive',
          error: 'The service answered but listed no collections',
          latencyMs,
        }
      }
      return {
        success: true,
        status: 'validated',
        detail: `${entries.length} collections found`,
        latencyMs,
      }
    } catch (err: unknown) {
      const message = scrubbed(err instanceof Error ? err.message : String(err), target.args)
      if (err instanceof WasteProviderRejectedError) {
        return { success: false, status: 'rejected', error: message }
      }
      if (err instanceof WasteFetchTimeoutError) {
        return { success: false, status: 'inconclusive', error: message }
      }
      return { success: false, status: 'inconclusive', error: message }
    }
  }

  private async probeTarget(
    id: string | null,
    values: Readonly<Record<string, unknown>>,
  ): Promise<ProbeTarget | { readonly result: IntegrationTestConnectionResult }> {
    if (id === null) {
      const serviceId = serviceIdOf(values)
      const service = serviceId === undefined ? undefined : findCatalogService(serviceId)
      if (service === undefined) {
        return refusal('inconclusive', 'Pick a country and a service first')
      }
      return {
        module: service.module,
        args: mergeServiceArgs(service, freshArgs(values)),
      }
    }
    const stored = await this.store.readResolved(id)
    if (stored === null) return refusal('inconclusive', `source '${id}' not found`)
    if (hasUnresolvedCredential(stored.args)) {
      return refusal(
        'inconclusive',
        'The stored credential is unavailable (is the keychain locked?)',
      )
    }
    const args: Record<string, unknown> = { ...stored.args }
    for (const [key, value] of Object.entries(argPatchOf(values))) {
      if (value === null) delete args[key]
      else args[key] = value
    }
    return { module: stored.module, args }
  }

  toProvider(): IIntegrationInstancesProvider {
    return {
      describe: this.describe,
      instanceFormSchema: this.instanceFormSchema,
      listInstances: this.listInstances,
      getInstance: this.getInstance,
      createInstance: this.createInstance,
      updateInstance: this.updateInstance,
      setInstanceEnabled: this.rowSwitch.setInstanceEnabled,
      deleteInstance: this.deleteInstance,
      testInstance: this.testInstance,
    }
  }
}

interface ProbeTarget {
  readonly module: string
  readonly args: Record<string, unknown>
}

/** The labels of the catalog's required arguments the probe would send empty. */
function missingRequiredArgs(target: ProbeTarget): readonly string[] {
  const service = matchCatalogService(target.module, target.args)
  if (service === undefined) return []
  return service.fields
    .filter((f) => {
      if (!f.required) return false
      const value = target.args[f.key]
      return value === undefined || value === null || value === ''
    })
    .map((f) => f.label)
}

function refusal(
  status: 'inconclusive' | 'rejected',
  error: string,
): { readonly result: IntegrationTestConnectionResult } {
  return { result: { success: false, status, error } }
}
