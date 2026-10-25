/**
 * Recover a pulse draft only when compiling it again reproduces the stored
 * feature. Anything else is another formula.
 */
import type {
  CompositionExpressionSource,
  CompositionFieldsFeature,
  CompositionFromSource,
  CompositionSourceRef,
} from '../composition.js'
import { compilePulseOverride } from './event-compile.js'
import type { CustomizeStored } from './stored.js'
import { sameStored } from './normalize.js'
import type { PulseOverrideDraft } from './override-draft.js'

export interface PulseDecoded {
  readonly draft: PulseOverrideDraft
  readonly changedAtFields: readonly string[]
}

export interface PulseDecodeInput {
  readonly feature: CompositionFieldsFeature
  readonly device: CompositionSourceRef
  readonly cap: string
  readonly targetId: string
  readonly timestampPath: string
  readonly counterPath: string
}

const ROSE_SOURCE = String.raw`rose\(active(\d+), changed(\d+), (\d+(?:\.\d+)?)\)`

export function decodePulseOverride(input: PulseDecodeInput): PulseDecoded | null {
  if (input.feature.cap !== input.cap || input.feature.kind !== 'fields') return null
  if (input.feature.enabled === undefined) return null
  const timestamp = input.feature.fields[input.timestampPath]
  const counter = input.feature.fields[input.counterPath]
  if (timestamp === undefined || counter === undefined) return null
  if (Object.keys(input.feature.fields).length !== 2) return null
  const edges = readEdges(timestamp)
  if (edges === null) return null
  const count = readCount(counter, input)
  if (count === null) return null
  const draft: PulseOverrideDraft = {
    kind: 'pulse',
    cap: input.cap,
    targetId: input.targetId,
    enabled: input.feature.enabled,
    debounceMs: edges.debounceMs,
    sources: edges.sources,
  }
  const decoded: PulseDecoded = { draft, changedAtFields: edges.changedAtFields }
  const compiled = compilePulseOverride({
    draft,
    device: input.device,
    changedAtFields: edges.changedAtFields,
  })
  if (!compiled.ok) return null
  return sameFeature(compiled.value, input.feature) ? decoded : null
}

interface ReadEdges {
  readonly debounceMs: number
  readonly sources: PulseOverrideDraft['sources']
  readonly changedAtFields: readonly string[]
}

function readEdges(field: CompositionFieldsFeature['fields'][string]): ReadEdges | null {
  if (
    field.kind !== 'expression' ||
    !field.expr.startsWith('latest(') ||
    !field.expr.endsWith(')')
  ) {
    return null
  }
  const inner = field.expr.slice('latest('.length, -1)
  const found = [...inner.matchAll(new RegExp(ROSE_SOURCE, 'g'))]
  if (found.length === 0 || found.map((match) => match[0]).join(', ') !== inner) return null
  if (Object.keys(field.bindings).length !== found.length * 2) return null
  const rows = found.map((match, index) => readRose(match, index, field.bindings))
  if (rows.some((row) => row === null)) return null
  const edges = rows.filter((row): row is RoseRow => row !== null)
  const debounceMs = edges[0]?.debounceMs
  if (debounceMs === undefined || edges.some((row) => row.debounceMs !== debounceMs)) return null
  return {
    debounceMs,
    sources: edges.map((row) => row.source),
    changedAtFields: edges.map((row) => row.changedAtField),
  }
}

interface RoseRow {
  readonly debounceMs: number
  readonly source: PulseOverrideDraft['sources'][number]
  readonly changedAtField: string
}

function readRose(
  match: RegExpMatchArray,
  index: number,
  bindings: CompositionExpressionSource['bindings'],
): RoseRow | null {
  const activeIndex = Number(match[1])
  const changedIndex = Number(match[2])
  const debounceMs = Number(match[3])
  if (activeIndex !== index || changedIndex !== index || !Number.isFinite(debounceMs)) return null
  const active = fromBinding(bindings[`active${index}`])
  const changed = fromBinding(bindings[`changed${index}`])
  if (active === null || changed === null) return null
  if (active.cap !== changed.cap) return null
  if (active.source.addonId !== changed.source.addonId) return null
  if (active.source.stableId !== changed.source.stableId) return null
  return {
    debounceMs,
    changedAtField: changed.fieldPath,
    source: {
      addonId: active.source.addonId,
      stableId: active.source.stableId,
      cap: active.cap,
      fieldPath: active.fieldPath,
    },
  }
}

function fromBinding(
  value: CompositionExpressionSource['bindings'][string] | undefined,
): CompositionFromSource | null {
  if (value === undefined || value.kind !== 'from') return null
  return value
}

function readCount(
  field: CompositionFieldsFeature['fields'][string],
  input: PulseDecodeInput,
): true | null {
  if (field.kind !== 'expression' || field.expr !== `count(${input.timestampPath})`) return null
  const binding = fromBinding(field.bindings[input.timestampPath])
  if (binding === null) return null
  if (Object.keys(field.bindings).length !== 1) return null
  if (binding.cap !== input.cap || binding.fieldPath !== input.timestampPath) return null
  if (binding.source.addonId !== input.device.addonId) return null
  if (binding.source.stableId !== input.device.stableId) return null
  return true
}

function sameFeature(left: CompositionFieldsFeature, right: CompositionFieldsFeature): boolean {
  return sameStored(wrap(left), wrap(right))
}

function wrap(feature: CompositionFieldsFeature): CustomizeStored {
  return { family: 'composition', target: { addonId: 't', stableId: 't' }, feature }
}
