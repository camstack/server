/**
 * The profile editor's form model, as pure functions (D893).
 *
 * A profile is two bags: the COMMON fields every kind shares (sampling, bounds,
 * policy — drawn by this file's schemas, offered per kind by the descriptor's
 * `profileFields`) and the provider's `providerConfig` (drawn by the
 * descriptor's own `connectionSchema` / `advancedSchema`). Nothing here names a
 * kind: a kind a third-party provider declares renders with no change here.
 *
 * `ConfigFormBuilder` addresses fields by one flat key, so the nested `retry`
 * object is spread into `retryEnabled` / `retryMaxAttempts` by
 * {@link commonValuesOf} and folded back by {@link draftToProfile}. Edit both
 * together — a field read here but not written there is a control that appears
 * to work and silently discards what the operator typed.
 */
import type {
  ConfigField,
  ConfigUISchema,
  LlmModelFeatures,
  LlmModelInfo,
  LlmProfile,
  LlmProfileField,
  LlmProfileKindDescriptor,
} from '@camstack/types'
import { LlmTimeoutDefaults } from '@camstack/types'
import i18n from '../../i18n/index'
import { AI_ADDON_ID, readBoolean, readNumber, readString } from './ai-page.helpers'

/**
 * Each common field, drawn once. A kind offers the ones its wire carries. Built
 * per call so the labels follow the current language.
 */
function fieldDefs(): Readonly<Record<LlmProfileField, readonly ConfigField[]>> {
  return {
    temperature: [
      {
        type: 'slider',
        key: 'temperature',
        label: i18n.t('helpers.aiProfileForm.temperature'),
        min: 0,
        max: 2,
        step: 0.1,
        showValue: true,
        showStepper: true,
        nullable: true,
        nullLabel: 'Provider default',
        description: i18n.t('helpers.aiProfileForm.temperatureHint'),
      },
    ],
    topP: [
      {
        type: 'slider',
        key: 'topP',
        label: i18n.t('helpers.aiProfileForm.topP'),
        min: 0,
        max: 1,
        step: 0.05,
        showValue: true,
        showStepper: true,
        nullable: true,
        nullLabel: 'Provider default',
      },
    ],
    topK: [{ type: 'number', key: 'topK', label: i18n.t('helpers.aiProfileForm.topK'), min: 1 }],
    maxTokens: [
      {
        type: 'number',
        key: 'maxTokens',
        label: i18n.t('helpers.aiProfileForm.maxTokens'),
        min: 1,
      },
    ],
    contextLength: [
      {
        type: 'number',
        key: 'contextLength',
        label: i18n.t('helpers.aiProfileForm.contextLength'),
        min: 512,
        unit: 'tokens',
        description: i18n.t('helpers.aiProfileForm.contextLengthHint'),
      },
    ],
    systemPrompt: [
      {
        type: 'textarea',
        key: 'systemPrompt',
        label: i18n.t('helpers.aiProfileForm.systemPrompt'),
        rows: 4,
        maxLength: 4000,
        span: 2,
        description: i18n.t('helpers.aiProfileForm.systemPromptHint'),
      },
    ],
    timeoutMs: [
      {
        type: 'number',
        key: 'timeoutMs',
        label: i18n.t('helpers.aiProfileForm.timeoutTotal'),
        min: 1000,
        default: LlmTimeoutDefaults.totalMs,
        unit: 'ms',
        description: i18n.t('helpers.aiProfileForm.timeoutTotalHint'),
      },
    ],
    connectTimeoutMs: [
      {
        type: 'number',
        key: 'connectTimeoutMs',
        label: i18n.t('helpers.aiProfileForm.timeoutConnect'),
        min: 500,
        default: LlmTimeoutDefaults.connectMs,
        unit: 'ms',
        description: i18n.t('helpers.aiProfileForm.timeoutConnectHint'),
      },
    ],
    firstTokenTimeoutMs: [
      {
        type: 'number',
        key: 'firstTokenTimeoutMs',
        label: i18n.t('helpers.aiProfileForm.timeoutFirstToken'),
        min: 1000,
        default: LlmTimeoutDefaults.firstTokenMs,
        unit: 'ms',
        description: i18n.t('helpers.aiProfileForm.timeoutFirstTokenHint'),
      },
    ],
    idleTimeoutMs: [
      {
        type: 'number',
        key: 'idleTimeoutMs',
        label: i18n.t('helpers.aiProfileForm.timeoutIdle'),
        min: 1000,
        default: LlmTimeoutDefaults.idleMs,
        unit: 'ms',
        description: i18n.t('helpers.aiProfileForm.timeoutIdleHint'),
      },
    ],
    retry: [
      {
        type: 'boolean',
        key: 'retryEnabled',
        label: i18n.t('helpers.aiProfileForm.retry'),
        description: i18n.t('helpers.aiProfileForm.retryHint'),
      },
      {
        type: 'number',
        key: 'retryMaxAttempts',
        label: i18n.t('helpers.aiProfileForm.retryMaxAttempts'),
        min: 1,
        max: 5,
        default: 1,
        showWhen: { field: 'retryEnabled', equals: true },
      },
    ],
    toolsEnabled: [
      {
        type: 'boolean',
        key: 'toolsEnabled',
        label: i18n.t('helpers.aiProfileForm.toolsEnabled'),
        description: i18n.t('helpers.aiProfileForm.toolsEnabledHint'),
      },
    ],
  }
}

const GENERATION_FIELDS: readonly LlmProfileField[] = [
  'temperature',
  'topP',
  'topK',
  'maxTokens',
  'contextLength',
  'systemPrompt',
]
const ADVANCED_FIELDS: readonly LlmProfileField[] = [
  'timeoutMs',
  'connectTimeoutMs',
  'firstTokenTimeoutMs',
  'idleTimeoutMs',
  'retry',
  'toolsEnabled',
]

function fieldsOf(
  offered: readonly LlmProfileField[],
  group: readonly LlmProfileField[],
): ConfigField[] {
  const defs = fieldDefs()
  return group.filter((f) => offered.includes(f)).flatMap((f) => defs[f])
}

/** ④ Generation — the sampling fields the kind offers; `null` = none. */
export function generationSchema(offered: readonly LlmProfileField[]): ConfigUISchema | null {
  const fields = fieldsOf(offered, GENERATION_FIELDS)
  if (fields.length === 0) return null
  return {
    sections: [{ id: 'generation', title: i18n.t('helpers.aiProfileForm.generation'), fields }],
  }
}

/** ▸ Advanced, common part — bounds and policy the kind offers; `null` = none. */
export function advancedCommonSchema(offered: readonly LlmProfileField[]): ConfigUISchema | null {
  const fields = fieldsOf(offered, ADVANCED_FIELDS)
  if (fields.length === 0) return null
  return { sections: [{ id: 'bounds', title: i18n.t('helpers.aiProfileForm.bounds'), fields }] }
}

/** A profile's common fields, flat for the builder. */
export function commonValuesOf(profile: LlmProfile | null): Record<string, unknown> {
  if (profile === null) return {}
  return {
    temperature: profile.temperature,
    topP: profile.topP,
    topK: profile.topK,
    maxTokens: profile.maxTokens,
    contextLength: profile.contextLength,
    systemPrompt: profile.systemPrompt,
    timeoutMs: profile.timeoutMs,
    connectTimeoutMs: profile.connectTimeoutMs,
    firstTokenTimeoutMs: profile.firstTokenTimeoutMs,
    idleTimeoutMs: profile.idleTimeoutMs,
    retryEnabled: profile.retry.enabled,
    retryMaxAttempts: profile.retry.maxAttempts,
    toolsEnabled: profile.toolsEnabled,
  }
}

/** What the model can do: the kind's defaults, overridden per field by the model. */
export function effectiveFeatures(
  descriptor: Pick<LlmProfileKindDescriptor, 'features'>,
  model: LlmModelInfo | undefined,
): LlmModelFeatures {
  return { ...descriptor.features, ...model?.features }
}

/** The picker's list: what `listModels` answered, else the kind's static list. */
export function modelChoices(
  descriptor: Pick<LlmProfileKindDescriptor, 'modelCatalog' | 'staticModels'>,
  listed: readonly LlmModelInfo[] | null,
): readonly LlmModelInfo[] {
  if (listed !== null) return listed
  return descriptor.modelCatalog === 'static' ? (descriptor.staticModels ?? []) : []
}

/** Everything the editor collected. */
export interface ProfileDraft {
  readonly name: string
  readonly model: string
  readonly supportsVision: boolean
  readonly common: Record<string, unknown>
  readonly providerConfig: Record<string, unknown>
}

/**
 * The draft → the profile to save. Clearing a bound means "default", not
 * "keep": each falls back to the schema default rather than to the previous
 * profile. A common field the kind does not offer is carried over untouched.
 */
export function draftToProfile(
  descriptor: Pick<LlmProfileKindDescriptor, 'kind' | 'addonId' | 'profileFields'>,
  existing: LlmProfile | null,
  draft: ProfileDraft,
): LlmProfile {
  const offered = descriptor.profileFields
  const c = draft.common
  const bound = (key: LlmProfileField, fallback: number, prior: number | undefined): number =>
    offered.includes(key) ? (readNumber(c[key]) ?? fallback) : (prior ?? fallback)
  type OptionalNumber = 'temperature' | 'topP' | 'topK' | 'maxTokens' | 'contextLength'
  // An offered field comes from the form; one the kind does not offer keeps its value.
  const num = (key: OptionalNumber): number | undefined =>
    offered.includes(key) ? readNumber(c[key]) : existing?.[key]
  const temperature = num('temperature')
  const topP = num('topP')
  const topK = num('topK')
  const maxTokens = num('maxTokens')
  const contextLength = num('contextLength')
  const systemPrompt = offered.includes('systemPrompt')
    ? readString(c.systemPrompt)
    : existing?.systemPrompt
  return {
    id: existing?.id ?? crypto.randomUUID(),
    name: draft.name,
    kind: descriptor.kind,
    addonId: descriptor.addonId.length > 0 ? descriptor.addonId : AI_ADDON_ID,
    enabled: existing?.enabled ?? true,
    model: draft.model,
    supportsVision: draft.supportsVision,
    timeoutMs: bound('timeoutMs', LlmTimeoutDefaults.totalMs, existing?.timeoutMs),
    connectTimeoutMs: bound(
      'connectTimeoutMs',
      LlmTimeoutDefaults.connectMs,
      existing?.connectTimeoutMs,
    ),
    firstTokenTimeoutMs: bound(
      'firstTokenTimeoutMs',
      LlmTimeoutDefaults.firstTokenMs,
      existing?.firstTokenTimeoutMs,
    ),
    idleTimeoutMs: bound('idleTimeoutMs', LlmTimeoutDefaults.idleMs, existing?.idleTimeoutMs),
    retry: offered.includes('retry')
      ? { enabled: readBoolean(c.retryEnabled), maxAttempts: readNumber(c.retryMaxAttempts) ?? 1 }
      : (existing?.retry ?? { enabled: false, maxAttempts: 1 }),
    toolsEnabled: offered.includes('toolsEnabled')
      ? readBoolean(c.toolsEnabled)
      : (existing?.toolsEnabled ?? false),
    // exactOptionalPropertyTypes: an omitted optional is how "not set" is said.
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(topK !== undefined ? { topK } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    providerConfig: draft.providerConfig,
  }
}
