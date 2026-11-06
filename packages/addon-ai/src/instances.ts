/**
 * The LLM profiles as `integration-instances` (epic 440 step 6, D1013): every profile is one
 * `llm-profiles` record, the kinds are `AI_KIND_DESCRIPTORS`, and the function cap they are
 * configured for is `llm`.
 *
 * The record body stays the nested one the dispatch reads (common fields + `providerConfig`, the
 * key in the row's keychain slot). The FORM is flat, because `ConfigFormBuilder` addresses a field
 * by one key: `providerConfig` is spread into it, `retry` becomes `retryEnabled` /
 * `retryMaxAttempts`, and the key is the kind's one secret field, shown as a `SecretFieldView`.
 * `updateInstance` folds the flat values back through the SAME save the old `upsertProfile` ran
 * (`validateProviderConfig`, the secret merge), so a malformed profile is refused here too.
 *
 * Secrets: a value omitted, `''`, the redaction token or the view the form was given KEEPS the
 * stored key; `{ $secretClear: true }` clears it; any other string replaces it.
 */
import { randomUUID } from 'node:crypto'
import {
  type ConfigField,
  type ConfigUISchema,
  type IIntegrationInstancesProvider,
  type IntegrationInstance,
  type IntegrationTestConnectionResult,
  type ILlmProvider,
  isInstanceEnabled,
  isSecretClear,
  isSecretFieldView,
  type LlmGenerateResult,
  type LlmProfile,
  type LlmProfileField,
  LlmProfileSchema,
  LlmTimeoutDefaults,
  type RecordRow,
  secretViewsOf,
} from '@camstack/types'
import { AI_KIND_DESCRIPTORS, descriptorOf, type KindDescriptor } from './kinds/descriptors.js'
import { secretFieldOf, validateProviderConfig } from './kinds/provider-config.js'
import { ProfileStore } from './profile-store.js'
import { aiRecordKinds, type LlmProfileBody } from './record-kinds.js'
import { REDACTED_MARKER } from './secrets.js'

const ADDON_ID = 'ai'
const LLM_FUNCTION_CAP = 'llm'
const DEFAULT_KIND = 'openai-compatible'

/**
 * How long `testInstance` waits for the generation. The kernel gives an `integration-instances`
 * method 60 s; the test must answer inside it, or the transport gives up first and the operator
 * reads a transport error for a model that was still loading.
 */
const TEST_BUDGET_MS = 50_000

export interface LlmInstancesDeps {
  readonly store: ProfileStore
  readonly llm: Pick<ILlmProvider, 'upsertProfile' | 'testProfile'>
  /** The records owner of the `llm-profiles` kind; the keychain refs of its secrets are bound to it. */
  readonly owner: string
  readonly testBudgetMs?: number
}

/** Form keys that are not `providerConfig`: the common profile fields and the row controls. */
const COMMON_KEYS: ReadonlySet<string> = new Set([
  'name',
  'model',
  'enabled',
  'kind',
  'supportsVision',
  'temperature',
  'topP',
  'topK',
  'maxTokens',
  'reasoningEffort',
  'contextLength',
  'systemPrompt',
  'timeoutMs',
  'connectTimeoutMs',
  'firstTokenTimeoutMs',
  'idleTimeoutMs',
  'retryEnabled',
  'retryMaxAttempts',
  'toolsEnabled',
])

const NUMBER_FIELDS = [
  'temperature',
  'topP',
  'topK',
  'maxTokens',
  'contextLength',
] as const satisfies readonly (keyof LlmProfile)[]
const BOUND_FIELDS = [
  'timeoutMs',
  'connectTimeoutMs',
  'firstTokenTimeoutMs',
  'idleTimeoutMs',
] as const satisfies readonly (keyof LlmProfile)[]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A number the form sent: `undefined` = not sent (keep), `null` = cleared. */
function numberOf(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

function commonFieldDefs(): Readonly<Record<LlmProfileField, readonly ConfigField[]>> {
  return {
    temperature: [
      {
        type: 'number',
        key: 'temperature',
        label: 'Temperature',
        min: 0,
        max: 2,
        step: 0.1,
      },
    ],
    topP: [
      {
        type: 'number',
        key: 'topP',
        label: 'Top P',
        min: 0,
        max: 1,
        step: 0.05,
      },
    ],
    topK: [{ type: 'number', key: 'topK', label: 'Top K', min: 1 }],
    maxTokens: [{ type: 'number', key: 'maxTokens', label: 'Max output tokens', min: 1 }],
    reasoningEffort: [
      {
        type: 'select',
        key: 'reasoningEffort',
        label: 'Reasoning effort',
        default: 'default',
        options: [
          { value: 'default', label: 'Model default' },
          { value: 'off', label: 'Off' },
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
        ],
      },
    ],
    contextLength: [
      {
        type: 'number',
        key: 'contextLength',
        label: 'Context length',
        min: 512,
        unit: 'tokens',
      },
    ],
    systemPrompt: [
      {
        type: 'textarea',
        key: 'systemPrompt',
        label: 'System prompt',
        rows: 4,
        maxLength: 4000,
        span: 2,
      },
    ],
    timeoutMs: [
      {
        type: 'number',
        key: 'timeoutMs',
        label: 'Total timeout',
        min: 1000,
        default: LlmTimeoutDefaults.totalMs,
        unit: 'ms',
      },
    ],
    connectTimeoutMs: [
      {
        type: 'number',
        key: 'connectTimeoutMs',
        label: 'Connect timeout',
        min: 500,
        default: LlmTimeoutDefaults.connectMs,
        unit: 'ms',
      },
    ],
    firstTokenTimeoutMs: [
      {
        type: 'number',
        key: 'firstTokenTimeoutMs',
        label: 'First-token timeout',
        min: 1000,
        default: LlmTimeoutDefaults.firstTokenMs,
        unit: 'ms',
      },
    ],
    idleTimeoutMs: [
      {
        type: 'number',
        key: 'idleTimeoutMs',
        label: 'Idle timeout',
        min: 1000,
        default: LlmTimeoutDefaults.idleMs,
        unit: 'ms',
      },
    ],
    retry: [
      { type: 'boolean', key: 'retryEnabled', label: 'Retry a failed call' },
      {
        type: 'number',
        key: 'retryMaxAttempts',
        label: 'Attempts',
        min: 1,
        max: 5,
        default: 1,
        showWhen: { field: 'retryEnabled', equals: true },
      },
    ],
    toolsEnabled: [{ type: 'boolean', key: 'toolsEnabled', label: 'Allow tools' }],
  }
}

/** The create/edit form of one kind: identity, the provider's own fields, then what its wire carries. */
export function formSchemaOf(descriptor: KindDescriptor): ConfigUISchema {
  const defs = commonFieldDefs()
  const general: ConfigField[] = [
    { type: 'text', key: 'name', label: 'Name', required: true },
    { type: 'text', key: 'model', label: 'Model', required: false },
  ]
  if (descriptor.visionEditable) {
    general.push({
      type: 'boolean',
      key: 'supportsVision',
      label: 'Understands images',
    })
  }
  const common = descriptor.profileFields.flatMap((field) => defs[field])
  return {
    sections: [
      { id: 'general', title: 'Profile', fields: general },
      ...descriptor.connectionSchema.sections,
      ...(common.length > 0 ? [{ id: 'parameters', title: 'Parameters', fields: common }] : []),
      ...(descriptor.advancedSchema?.sections ?? []),
    ],
  }
}

/** The flat form values of one stored row; the key slot becomes a `SecretFieldView`. */
function valuesOfRow(owner: string, row: RecordRow<LlmProfileBody>): Record<string, unknown> {
  const shown = secretViewsOf(
    owner,
    'llm-profiles',
    row.id,
    aiRecordKinds['llm-profiles'].declaration,
    row.data,
  )
  const { providerConfig, apiKey, retry, addonId: _stamp, ...common } = shown
  const kind = typeof common.kind === 'string' ? common.kind : ''
  const field = secretFieldOf(kind)
  const retryBody = isRecord(retry) ? retry : {}
  return {
    ...common,
    ...(isRecord(providerConfig) ? providerConfig : {}),
    retryEnabled: retryBody.enabled === true,
    retryMaxAttempts: typeof retryBody.maxAttempts === 'number' ? retryBody.maxAttempts : 1,
    ...(field !== null && apiKey !== undefined ? { [field]: apiKey } : {}),
  }
}

function viewOf(owner: string, row: RecordRow<LlmProfileBody>): IntegrationInstance {
  const body = row.data
  const checked = validateProviderConfig(body.kind, body.providerConfig)
  return {
    id: row.id,
    name: body.name,
    configured: checked.ok && body.model.trim().length > 0,
    enabled: isInstanceEnabled(body),
    kind: body.kind,
    formValues: valuesOfRow(owner, row),
  }
}

/** The secret field's value to hand the save: the keep token, a clear, or the new string. */
function secretValue(sent: unknown): string {
  if (isSecretClear(sent)) return ''
  if (
    typeof sent === 'string' &&
    sent !== '' &&
    sent !== REDACTED_MARKER &&
    !isSecretFieldView(sent)
  ) {
    return sent
  }
  return REDACTED_MARKER
}

/** Fold flat form values over `base` (the stored profile, or a blank one) into a profile. */
export function profileFromValues(
  base: LlmProfile,
  descriptor: KindDescriptor,
  values: Readonly<Record<string, unknown>>,
  name: string | undefined,
): LlmProfile {
  const next: Record<string, unknown> = { ...base }
  if (name !== undefined) next.name = name
  else if (typeof values.name === 'string' && values.name.length > 0) next.name = values.name
  if (typeof values.model === 'string') next.model = values.model
  if (descriptor.visionEditable && typeof values.supportsVision === 'boolean') {
    next.supportsVision = values.supportsVision
  }
  if (typeof values.toolsEnabled === 'boolean') next.toolsEnabled = values.toolsEnabled
  for (const key of NUMBER_FIELDS) {
    const sent = numberOf(values[key])
    if (sent === null) delete next[key]
    else if (sent !== undefined) next[key] = sent
  }
  for (const key of BOUND_FIELDS) {
    const sent = numberOf(values[key])
    if (typeof sent === 'number') next[key] = sent
  }
  if ('systemPrompt' in values) {
    const sent = values.systemPrompt
    if (typeof sent === 'string' && sent.length > 0) next.systemPrompt = sent
    else delete next.systemPrompt
  }
  if ('reasoningEffort' in values) {
    const parsed = LlmProfileSchema.shape.reasoningEffort.safeParse(values.reasoningEffort)
    if (parsed.success && parsed.data !== undefined) next.reasoningEffort = parsed.data
    else delete next.reasoningEffort
  }
  if ('retryEnabled' in values || 'retryMaxAttempts' in values) {
    const attempts = numberOf(values.retryMaxAttempts)
    next.retry = {
      enabled: values.retryEnabled === true,
      maxAttempts: typeof attempts === 'number' ? attempts : base.retry.maxAttempts,
    }
  }
  const config: Record<string, unknown> = { ...base.providerConfig }
  for (const [key, sent] of Object.entries(values)) {
    if (COMMON_KEYS.has(key) || sent === undefined || key === secretFieldOf(descriptor.kind))
      continue
    config[key] = sent
  }
  const field = secretFieldOf(descriptor.kind)
  if (field !== null) config[field] = secretValue(values[field])
  next.providerConfig = config
  return LlmProfileSchema.parse(next)
}

function blankProfile(id: string, name: string, kind: string, enabled: boolean): LlmProfile {
  return LlmProfileSchema.parse({
    id,
    name,
    kind,
    addonId: ADDON_ID,
    enabled,
    model: '',
    supportsVision: false,
  })
}

function testOutcome(result: LlmGenerateResult): IntegrationTestConnectionResult {
  if (result.ok) {
    return {
      success: true,
      status: 'validated',
      latencyMs: result.latencyMs,
      detail: `${result.model} answered`,
    }
  }
  const rejected =
    result.code === 'auth' || result.code === 'bad-request' || result.code === 'no-profile'
  return {
    success: false,
    status: rejected ? 'rejected' : 'inconclusive',
    error: result.message,
  }
}

export function createLlmInstances(deps: LlmInstancesDeps): IIntegrationInstancesProvider {
  const { store, llm, owner } = deps
  const budgetMs = deps.testBudgetMs ?? TEST_BUDGET_MS

  async function requireProfile(id: string): Promise<LlmProfile> {
    const profile = await store.getById(id)
    if (profile === null) throw new Error(`profile "${id}" not found`)
    return profile
  }

  function requireDescriptor(kind: string): KindDescriptor {
    const descriptor = descriptorOf(kind)
    if (descriptor === null) throw new Error(`this provider serves no kind "${kind}"`)
    return descriptor
  }

  return {
    describe: async () => ({
      role: 'services',
      instanceMode: 'multiple',
      kind: 'llm-profile',
      canTest: true,
      mintsId: true,
      kinds: AI_KIND_DESCRIPTORS.map((d) => ({
        id: d.kind,
        label: d.label,
        functionCap: LLM_FUNCTION_CAP,
        canTest: true,
      })),
    }),

    instanceFormSchema: async ({ id, kind }) => {
      const stored = id === null ? null : await store.getById(id)
      const wanted = stored?.kind ?? kind ?? DEFAULT_KIND
      return formSchemaOf(requireDescriptor(wanted))
    },

    listInstances: async () => (await store.rows()).map((row) => viewOf(owner, row)),

    getInstance: async ({ id }) => {
      const row = (await store.rows()).find((r) => r.id === id)
      return row === undefined ? null : viewOf(owner, row)
    },

    createInstance: async ({ id, name, kind, values }) => {
      const wanted = kind ?? DEFAULT_KIND
      const descriptor = requireDescriptor(wanted)
      const minted = id ?? `llm-${randomUUID().slice(0, 8)}`
      if ((await store.getById(minted)) !== null) throw new Error(`profile "${minted}" exists`)
      const supplied = values !== undefined && Object.keys(values).length > 0
      if (!supplied) {
        // A blank draft: off until the operator fills the connection in.
        await store.upsert(blankProfile(minted, name, wanted, false))
        return { id: minted }
      }
      const profile = profileFromValues(
        blankProfile(minted, name, wanted, true),
        descriptor,
        values,
        name,
      )
      await llm.upsertProfile({ profile })
      return { id: minted }
    },

    updateInstance: async ({ id, name, values }) => {
      const existing = await requireProfile(id)
      const profile = profileFromValues(existing, requireDescriptor(existing.kind), values, name)
      await llm.upsertProfile({ profile })
      return { ok: true as const }
    },

    setInstanceEnabled: async ({ id, enabled }) => {
      const existing = await requireProfile(id)
      // Straight to the store: a blank draft is switched, not validated; a key the keychain
      // cannot serve right now is kept as it is.
      await store.upsert(
        { ...existing, enabled },
        { keepStoredKey: store.lockedReason(id) !== null },
      )
      return { ok: true as const }
    },

    deleteInstance: async ({ id }) => {
      await store.delete(id)
      return { ok: true as const }
    },

    testInstance: async ({ id }) => {
      if (id === null) {
        return {
          success: false,
          status: 'unsupported',
          error:
            'Save the profile first: the test runs a real generation against the stored profile',
        }
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const gaveUp = new Promise<IntegrationTestConnectionResult>((resolve) => {
        timer = setTimeout(() => {
          resolve({
            success: false,
            status: 'inconclusive',
            error: `no answer within ${String(Math.round(budgetMs / 1000))} s; the model may still be loading`,
          })
        }, budgetMs)
      })
      try {
        const ran = llm
          .testProfile({ addonId: ADDON_ID, profileId: id })
          .then((result) => testOutcome(result))
        return await Promise.race([ran, gaveUp])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    },
  }
}
