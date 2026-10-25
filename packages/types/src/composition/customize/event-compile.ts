/**
 * Compile a pulse or span OverrideDraft (D936). A pulse is the canonical
 * `latest(rose(...))` plus `count` feature. A span with the camera-sensors
 * authority is that list, not a claim on `detected`.
 */
import type { CustomizeCatalogTarget } from '../../capabilities/customize-catalog.js'
import { CAP_CUSTOMIZE_CATALOG } from '../../generated/customize-catalog.js'
import type { CustomizeCatalog } from '../../capabilities/customize-catalog.js'
import type {
  CompositionExpressionSource,
  CompositionFieldsFeature,
  CompositionSourceRef,
} from '../composition.js'
import {
  CameraSensorsConfigSchema,
  type CameraSensorMode,
  type CameraSensorsConfig,
} from '../../pipeline/camera-sensors.js'
import { expression, fromRead } from './field-source.js'
import type { PulseOverrideDraft, SpanOverrideDraft, SpanSourceDraft } from './override-draft.js'
import { isIdentifier, unsignedToken } from './scalar-expr.js'
import type { CustomizeRoundTrip } from './stored.js'

const catalog: CustomizeCatalog = CAP_CUSTOMIZE_CATALOG

export interface PulseCompileInput {
  readonly draft: PulseOverrideDraft
  readonly device: CompositionSourceRef
  readonly changedAtFields: readonly string[]
}

export interface SpanCompiled {
  readonly config: CameraSensorsConfig | null
  readonly timeoutMs: number
  readonly cooldownMs: number | undefined
}

export interface SpanCompileInput {
  readonly draft: SpanOverrideDraft
  readonly device: CompositionSourceRef
}

interface PulsePair {
  readonly source: PulseOverrideDraft['sources'][number]
  readonly changedAtField: string
}

interface SpanSensorEntry {
  readonly addonId: string
  readonly stableId: string
  readonly mode: CameraSensorMode
}

export function compilePulseOverride(
  input: PulseCompileInput,
): CustomizeRoundTrip<CompositionFieldsFeature> {
  const target = catalogTarget(input.draft.cap, input.draft.targetId)
  if (target === null || target.shape !== 'pulse') return fail('target')
  const timestampPath = target.timestampPath
  const counterPath = target.counterPath
  if (
    timestampPath === undefined ||
    counterPath === undefined ||
    !isIdentifier(timestampPath) ||
    !isIdentifier(counterPath)
  ) {
    return fail('path')
  }
  if (!(target.edges ?? []).includes('rising')) return fail('edge')
  const pairs = pairSources(input)
  if (!pairs.ok) return pairs
  if (pairs.value.length === 0) return fail('sources')
  const debounce = unsignedToken(input.draft.debounceMs)
  if (debounce === null) return fail('debounce')
  const ordered = pairs.value.toSorted((a, b) => pairKey(a).localeCompare(pairKey(b)))
  return {
    ok: true,
    value: {
      kind: 'fields',
      cap: input.draft.cap,
      enabled: input.draft.enabled,
      fields: {
        [timestampPath]: expression(pulseExpr(ordered.length, debounce), pulseBindings(ordered)),
        [counterPath]: expression(`count(${timestampPath})`, {
          [timestampPath]: fromRead(input.device, input.draft.cap, timestampPath),
        }),
      },
    },
  }
}

export function compileSpanOverride(input: SpanCompileInput): CustomizeRoundTrip<SpanCompiled> {
  const target = catalogTarget(input.draft.cap, input.draft.targetId)
  if (target === null || target.shape !== 'span') return fail('target')
  if (target.applyAuthority?.kind !== 'camera-sensors') return fail('authority')
  if (input.draft.timeoutMs < 0 || !Number.isFinite(input.draft.timeoutMs)) return fail('timeout')
  if (target.cooldownMs === undefined && input.draft.cooldownMs !== undefined)
    return fail('cooldown')
  if (input.draft.cooldownMs !== undefined && input.draft.cooldownMs < 0) return fail('cooldown')
  const sensors = sensorEntries(input.draft.sources, input.device, target.sourceModes)
  if (!sensors.ok) return sensors
  if (sensors.value.length === 0) {
    return {
      ok: true,
      value: {
        config: null,
        timeoutMs: input.draft.timeoutMs,
        cooldownMs: input.draft.cooldownMs,
      },
    }
  }
  const parsed = CameraSensorsConfigSchema.safeParse({ sensors: sensors.value })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return fail(issue === undefined ? 'cameraSensors' : issue.message)
  }
  return {
    ok: true,
    value: {
      config: parsed.data,
      timeoutMs: input.draft.timeoutMs,
      cooldownMs: input.draft.cooldownMs,
    },
  }
}

function pairSources(input: PulseCompileInput): CustomizeRoundTrip<readonly PulsePair[]> {
  if (input.changedAtFields.length !== input.draft.sources.length) return fail('changed-at')
  const pairs = input.draft.sources.map((source, index) => {
    const changedAtField = input.changedAtFields[index] ?? ''
    return { source, changedAtField }
  })
  if (
    pairs.some((pair) => pair.changedAtField.length === 0 || pair.source.fieldPath.length === 0)
  ) {
    return fail('changed-at')
  }
  return { ok: true, value: pairs }
}

function pairKey(pair: PulsePair): string {
  return `${pair.source.addonId}/${pair.source.stableId}#${pair.source.cap}#${pair.source.fieldPath}`
}

function pulseExpr(count: number, debounce: string): string {
  const roses: string[] = []
  for (let index = 0; index < count; index += 1) {
    roses.push(`rose(active${index}, changed${index}, ${debounce})`)
  }
  return `latest(${roses.join(', ')})`
}

function pulseBindings(pairs: readonly PulsePair[]): CompositionExpressionSource['bindings'] {
  const bindings: Record<string, ReturnType<typeof fromRead>> = {}
  pairs.forEach((pair, index) => {
    const ref = { addonId: pair.source.addonId, stableId: pair.source.stableId }
    bindings[`active${index}`] = fromRead(ref, pair.source.cap, pair.source.fieldPath)
    bindings[`changed${index}`] = fromRead(ref, pair.source.cap, pair.changedAtField)
  })
  return bindings
}

function sensorEntries(
  sources: readonly SpanSourceDraft[],
  device: CompositionSourceRef,
  modes: readonly string[] | undefined,
): CustomizeRoundTrip<readonly SpanSensorEntry[]> {
  const entries: SpanSensorEntry[] = []
  for (const source of sources) {
    if (source.addonId === device.addonId && source.stableId === device.stableId)
      return fail('self')
    const mode = source.mode ?? 'in-addition'
    if (modes !== undefined && !modes.includes(mode)) return fail('mode')
    if (modes === undefined && source.mode !== undefined && source.mode !== 'in-addition') {
      return fail('mode')
    }
    entries.push({ addonId: source.addonId, stableId: source.stableId, mode })
  }
  return { ok: true, value: entries }
}

function catalogTarget(cap: string, targetId: string): CustomizeCatalogTarget | null {
  const entry = catalog[cap]
  if (entry === undefined) return null
  return entry.targets.find((target) => target.id === targetId) ?? null
}

function fail<T>(reason: string): CustomizeRoundTrip<T> {
  return { ok: false, reason }
}
