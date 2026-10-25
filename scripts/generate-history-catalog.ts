#!/usr/bin/env tsx
/**
 * Codegen: the history catalog (D850).
 *
 * Emits `packages/types/src/generated/history-catalog.ts` — per cap with a
 * `history` block, field path → series spec; plus the list of caps that
 * answered `'none'`. device-history reads it by cap name, without importing
 * 69 cap definitions (the same projection argument as runtime-state-durability).
 *
 * Run manually: npx tsx scripts/generate-history-catalog.ts
 */

import * as path from 'node:path'
import { writeIfChanged } from './codegen-write.ts'
import { DeviceType } from '../packages/types/src/device/device-type.js'
import { enumValuesOf, loadHistoryCaps } from './lib/cap-history.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUTPUT = path.join(ROOT, 'packages/types/src/generated/history-catalog.ts')

const DEVICE_TYPE_KEYS: ReadonlyMap<string, string> = new Map(
  Object.entries(DeviceType).map(([key, value]) => [value, key]),
)

function deviceTypeLiteral(value: unknown): string {
  const key = typeof value === 'string' ? DEVICE_TYPE_KEYS.get(value) : undefined
  return key === undefined ? literal(value) : `DeviceType.${key}`
}

function literal(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`
  if (value !== null && typeof value === 'object') {
    const inner = Object.entries(value).map(([k, v]) =>
      k === 'excludeDeviceTypes' && Array.isArray(v)
        ? `${k}: [${v.map(deviceTypeLiteral).join(', ')}]`
        : `${k}: ${literal(v)}`,
    )
    return `{ ${inner.join(', ')} }`
  }
  return typeof value === 'string' ? `'${value}'` : String(value)
}

async function main(): Promise<void> {
  const caps = await loadHistoryCaps()
  // An `enum` field over a `z.enum` gets its `values` here, from the schema itself,
  // so the stored value list can never drift from the cap's declaration.
  const withSeries = caps.flatMap((c) => {
    if (c.history === undefined || c.history === 'none') return []
    const state = c.runtimeState
    const fields = Object.fromEntries(
      Object.entries(c.history.fields).map(([field, spec]) => {
        const values =
          spec.kind === 'enum' && state !== undefined ? enumValuesOf(state, field) : undefined
        return [field, values === undefined ? spec : { ...spec, values }]
      }),
    )
    return Object.keys(fields).length === 0 ? [] : [{ cap: c.capName, fields }]
  })
  // A keyed array (D917): its item fields, `values` projected from the ITEM schema.
  const withItems = caps.flatMap((c) => {
    if (c.history === undefined || c.history === 'none' || c.history.items === undefined) return []
    const items = c.history.items
    const state = c.runtimeState
    const fields = Object.fromEntries(
      Object.entries(items.fields).map(([field, spec]) => {
        const values =
          spec.kind === 'enum' && state !== undefined
            ? enumValuesOf(state, field, items.path)
            : undefined
        return [field, values === undefined ? spec : { ...spec, values }]
      }),
    )
    return [{ cap: c.capName, items: { ...items, fields } }]
  })
  const itemSeriesCount = withItems.reduce((n, c) => n + Object.keys(c.items.fields).length, 0)
  const none = caps.filter((c) => c.history === 'none').map((c) => c.capName)
  const seriesCount = withSeries.reduce((n, c) => n + Object.keys(c.fields).length, 0)

  const entries = withSeries
    .map(({ cap, fields }) => {
      const rows = Object.entries(fields)
        .map(([field, spec]) => `    '${field}': ${literal(spec)},`)
        .join('\n')
      return `  '${cap}': {\n${rows}\n  },`
    })
    .join('\n')

  const itemEntries = withItems
    .map(({ cap, items }) => {
      const rows = Object.entries(items.fields)
        .map(([field, spec]) => `      '${field}': ${literal(spec)},`)
        .join('\n')
      const label = items.label === undefined ? '' : `\n    label: '${items.label}',`
      return `  '${cap}': {\n    path: '${items.path}',\n    key: '${items.key}',${label}\n    fields: {\n${rows}\n    },\n  },`
    })
    .join('\n')

  const out = `// AUTO-GENERATED — do not edit manually.
// Regenerate with: npx tsx scripts/generate-history-catalog.ts
/* eslint-disable */

import type {
  CapabilityHistoryField,
  CapabilityHistoryItems,
} from '../capabilities/capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Cap history catalog, projected from every \`*.cap.ts\` \`history\` block.
 * ${withSeries.length} caps with series (${seriesCount} series), ${none.length} caps answered \`'none'\`.
 * Field keys are \`runtimeState\` paths (\`a.b\` into fixed objects only).
 */
export const HISTORY_CATALOG: Readonly<Record<string, Readonly<Record<string, CapabilityHistoryField>>>> = {
${entries}
}

/**
 * Keyed-array series (D917), projected from every \`history.items\` block:
 * ${withItems.length} caps (${itemSeriesCount} item fields). The item key is the series SCOPE;
 * the series key is \`cap:<capName>.<path>[].<field>\`.
 */
export const HISTORY_ITEM_CATALOG: Readonly<Record<string, CapabilityHistoryItems>> = {
${itemEntries}
}

/** Caps that declared \`history: 'none'\`, sorted. */
export const HISTORY_NONE_CAPS: readonly string[] = [
${none.map((n) => `  '${n}',`).join('\n')}
]

/** The series specs of \`capName\`; empty for a \`'none'\` cap or an unknown one. */
export function historyFieldsFor(capName: string): Readonly<Record<string, CapabilityHistoryField>> {
  return HISTORY_CATALOG[capName] ?? {}
}
`
  writeIfChanged(OUTPUT, out)
  // eslint-disable-next-line no-console
  console.log(
    `history catalog → ${path.relative(ROOT, OUTPUT)} (${withSeries.length} caps / ${seriesCount} series / ${withItems.length} keyed / ${none.length} none)`,
  )
}

void main()
