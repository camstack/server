#!/usr/bin/env tsx
/**
 * Codegen: the Customize catalog (D936).
 *
 * Emits `packages/types/src/generated/customize-catalog.ts` — one entry per
 * cap that declares `customize`, with no Zod on the wire. Fails when the
 * declaration guard finds a path, type or vocabulary error.
 *
 * Run manually: npx tsx scripts/generate-customize-catalog.ts
 */
import * as path from 'node:path'
import { writeIfChanged } from './codegen-write.ts'
import { DeviceType } from '../packages/types/src/device/device-type.ts'
import {
  judgeCustomize,
  loadCustomizeCaps,
  loadRuntimeFieldUnits,
  type CustomizeCapView,
} from './lib/customize-declaration.ts'
import { projectCustomize } from './lib/customize-project.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUTPUT = path.join(ROOT, 'packages/types/src/generated/customize-catalog.ts')

const DEVICE_TYPE_KEYS: ReadonlyMap<string, string> = new Map(
  Object.entries(DeviceType).map(([key, value]) => [value, key]),
)

async function main(): Promise<void> {
  const caps = await loadCustomizeCaps()
  const violations = caps.flatMap((cap) => judgeCustomize(cap))
  if (violations.length > 0) {
    // eslint-disable-next-line no-console
    console.error('\n\x1b[31m✘ customize catalog: declaration guard failed\x1b[0m')
    for (const violation of violations) {
      const target = violation.targetId === undefined ? '' : `.${violation.targetId}`
      // eslint-disable-next-line no-console
      console.error(`    - ${violation.capName}${target} [${violation.rule}] ${violation.message}`)
    }
    process.exit(1)
  }
  const entries = caps
    .map((cap) => `  '${cap.capName}': ${print(projectCustomize(cap), 2)},`)
    .join('\n')
  const units = await loadRuntimeFieldUnits()
  const unitEntries = Object.keys(units)
    .toSorted()
    .map((cap) => `  '${cap}': ${print(units[cap], 2)},`)
    .join('\n')
  const out = render(caps, entries, unitEntries)
  writeIfChanged(OUTPUT, out)
  // eslint-disable-next-line no-console
  console.log(`customize catalog → ${path.relative(ROOT, OUTPUT)} (${caps.length} caps)`)
}

function render(caps: readonly CustomizeCapView[], entries: string, unitEntries: string): string {
  return `// AUTO-GENERATED — do not edit manually.
// Regenerate with: npx tsx scripts/generate-customize-catalog.ts
/* eslint-disable */

import type { CustomizeCatalog } from '../capabilities/customize-catalog.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Customize catalog, projected from every \`*.cap.ts\` \`customize\` block.
 * ${caps.length} caps. Field keys are \`runtimeState\` paths. No Zod.
 */
export const CAP_CUSTOMIZE_CATALOG = {
${entries}
} as const satisfies CustomizeCatalog

/**
 * Unit meta on runtime-state fields. The composed-device row reads this;
 * it is not an override list (D944).
 */
export const CAP_RUNTIME_FIELD_UNITS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
${unitEntries}
}
`
}

function print(value: unknown, indent: number): string {
  if (typeof value === 'string') return `'${value.replaceAll("'", "\\'")}'`
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) return printArray(value, indent)
  if (isPlain(value)) return printObject(value, indent)
  throw new Error(`customize catalog: cannot print ${typeof value}`)
}

type UnknownList = readonly unknown[]

function printArray(values: UnknownList, indent: number): string {
  if (values.length === 0) return '[]'
  const pad = ' '.repeat(indent + 2)
  const inner = values.map((item) => `${pad}${print(item, indent + 2)}`).join(',\n')
  return `[\n${inner},\n${' '.repeat(indent)}]`
}

type PlainRecord = Readonly<Record<string, unknown>>

function printObject(value: PlainRecord, indent: number): string {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined)
  if (entries.length === 0) return '{}'
  const pad = ' '.repeat(indent + 2)
  const inner = entries
    .map(
      ([key, item]) =>
        `${pad}${key}: ${key === 'deviceTypes' ? printDeviceTypes(item) : print(item, indent + 2)}`,
    )
    .join(',\n')
  return `{\n${inner},\n${' '.repeat(indent)}}`
}

function printDeviceTypes(value: unknown): string {
  if (!Array.isArray(value)) throw new Error('customize catalog: deviceTypes is not an array')
  if (value.length === 0) return '[]'
  const parts = value.map((item) => {
    if (typeof item !== 'string') throw new Error('customize catalog: device type is not a string')
    const key = DEVICE_TYPE_KEYS.get(item)
    if (key === undefined) throw new Error(`customize catalog: \`${item}\` is not a DeviceType`)
    return `DeviceType.${key}`
  })
  return `[${parts.join(', ')}]`
}

function isPlain(value: unknown): value is PlainRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

void main()
