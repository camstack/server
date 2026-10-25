/**
 * The Customize tab's "Added and replaced fields" (spec §3, D676). One row per
 * field the customization writes (COMPOSED, valued by the composer's own
 * report) and, for a REPLACED cap, one row per field it leaves to the
 * integration (NATIVE, valued by the device's merged state). `add` vs
 * `replace` is the validator's rule over `getBindings` (G8).
 *
 * A composed row is NEVER valued from the snapshot: during a D663 release
 * (`degraded`) the snapshot holds the native value and would look like the
 * composition's (D393).
 */
import {
  COMPOSITION_ITEM_ARRAY_PATH,
  type Composition,
  type CompositionFieldSource,
  type CompositionFieldState,
  type CompositionFieldsFeature,
  type CompositionStateRead,
  compositionFeatureEnabled,
  compositionItemFieldPath,
  compositionSourceKey,
  type ExpressionValue,
  toExpressionValue,
} from '@camstack/types'
import { type DeviceSnapshot, readPath } from './source-picker-model'
import i18n from '../../../i18n/index'

export type FieldsTableValue =
  | { readonly kind: 'value'; readonly value: ExpressionValue; readonly staleReason: string | null }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'unknown'; readonly reason: string }
  | { readonly kind: 'off' }

export type FieldsTableOrigin = 'native' | 'composed'
export type FieldsTableMode = 'add' | 'replace'

export interface FieldsTableRow {
  readonly key: string
  readonly cap: string
  readonly field: string
  readonly origin: FieldsTableOrigin
  readonly mode: FieldsTableMode
  readonly from: string
  readonly value: FieldsTableValue
}

export interface FieldsTableInput {
  readonly composition: Composition
  readonly nativeCaps: ReadonlySet<string>
  readonly state: CompositionStateRead
  readonly nativeFields: ReadonlyMap<string, readonly string[]>
  readonly snapshot: DeviceSnapshot | null
  readonly sourceNames: ReadonlyMap<string, string>
}

/** The `from` column's text of a native row — the UI translates it. */
export const INTEGRATION_ORIGIN = 'integration'

export function describeFieldSource(
  source: CompositionFieldSource,
  names: ReadonlyMap<string, string>,
): string {
  switch (source.kind) {
    case 'from': {
      const key = compositionSourceKey(source.source)
      return `${names.get(key) ?? key} · ${source.cap}.${source.fieldPath}`
    }
    case 'expression':
      return source.expr
    case 'code':
      return 'code'
  }
}

type FieldStateMatch = (field: CompositionFieldState) => boolean

function composedValue(state: CompositionStateRead, match: FieldStateMatch): FieldsTableValue {
  if (state.kind === 'unreachable') return { kind: 'unknown', reason: state.error }
  if (state.state === null) {
    return { kind: 'unknown', reason: i18n.t('helpers.fieldsTableRows.composerNotReported') }
  }
  const field = state.state.fields.find(match)
  if (field === undefined) {
    return { kind: 'unknown', reason: i18n.t('helpers.fieldsTableRows.noValue') }
  }
  if (field.state === 'unavailable') {
    return { kind: 'unavailable', reason: field.reason ?? i18n.t('common.unavailable') }
  }
  return {
    kind: 'value',
    value: field.value,
    staleReason: field.state === 'stale' ? (field.reason ?? i18n.t('common.stale')) : null,
  }
}

interface FeatureContext {
  readonly feature: CompositionFieldsFeature
  readonly mode: FieldsTableMode
  readonly enabled: boolean
  readonly input: FieldsTableInput
}

function composedRow(
  ctx: FeatureContext,
  field: string,
  source: CompositionFieldSource,
  match: FieldStateMatch,
): FieldsTableRow {
  return {
    key: `${ctx.feature.cap}.${field}`,
    cap: ctx.feature.cap,
    field,
    origin: 'composed',
    mode: ctx.mode,
    from: describeFieldSource(source, ctx.input.sourceNames),
    value: ctx.enabled ? composedValue(ctx.input.state, match) : { kind: 'off' },
  }
}

function topLevelRows(ctx: FeatureContext): readonly FieldsTableRow[] {
  const cap = ctx.feature.cap
  return Object.entries(ctx.feature.fields).map(([path, source]) =>
    composedRow(ctx, path, source, (f) => f.cap === cap && f.path === path && f.item === undefined),
  )
}

function itemRows(ctx: FeatureContext): readonly FieldsTableRow[] {
  const cap = ctx.feature.cap
  return Object.entries(ctx.feature.items ?? {}).flatMap(([key, item]) =>
    Object.entries(item.fields).map(([path, source]) =>
      composedRow(
        ctx,
        compositionItemFieldPath(COMPOSITION_ITEM_ARRAY_PATH, key, path),
        source,
        (f) =>
          f.cap === cap &&
          f.path === path &&
          f.item?.arrayPath === COMPOSITION_ITEM_ARRAY_PATH &&
          f.item.key === key,
      ),
    ),
  )
}

function nativeValue(snapshot: DeviceSnapshot | null, cap: string, path: string): FieldsTableValue {
  if (snapshot === null)
    return { kind: 'unknown', reason: i18n.t('helpers.fieldsTableRows.stateUnreadable') }
  const raw = readPath(snapshot[cap], path)
  const value = raw === undefined ? undefined : toExpressionValue(raw)
  return value === undefined
    ? { kind: 'unknown', reason: i18n.t('helpers.fieldsTableRows.notReported') }
    : { kind: 'value', value, staleReason: null }
}

/** A REPLACED cap's fields the customization leaves to the integration. */
function nativeRows(ctx: FeatureContext): readonly FieldsTableRow[] {
  if (ctx.mode !== 'replace') return []
  const cap = ctx.feature.cap
  const owned = new Set(Object.keys(ctx.feature.fields))
  return (ctx.input.nativeFields.get(cap) ?? [])
    .filter((path) => !owned.has(path))
    .map((path) => ({
      key: `${cap}.${path}`,
      cap,
      field: path,
      origin: 'native',
      mode: ctx.mode,
      from: INTEGRATION_ORIGIN,
      value: nativeValue(ctx.input.snapshot, cap, path),
    }))
}

export function buildFieldsTableRows(input: FieldsTableInput): readonly FieldsTableRow[] {
  return input.composition.features.flatMap((feature): readonly FieldsTableRow[] => {
    if (feature.kind !== 'fields') return []
    const ctx: FeatureContext = {
      feature,
      mode: input.nativeCaps.has(feature.cap) ? 'replace' : 'add',
      enabled: compositionFeatureEnabled(feature),
      input,
    }
    return [...topLevelRows(ctx), ...itemRows(ctx), ...nativeRows(ctx)]
  })
}
