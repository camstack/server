#!/usr/bin/env tsx
/**
 * Codegen: emit `METHOD_DEVICE_SELECTORS` — for every tRPC cap method, WHERE
 * the device references live in its input.
 *
 * Why this exists (scope model v3, F1 #3):
 *
 * The scope matcher only extracted `input.deviceId` when the CAP was declared
 * `scope: 'device'`. But ~17 SYSTEM-scope caps also take a `deviceId` —
 * `recording.getPlaybackManifest`, `pipelineOrchestrator.*`, `faceGallery.*`,
 * `vectorStore.*`, … — and those were never device-filtered at all. A
 * non-admin holding `category:system[view]` could therefore read ANY camera's
 * recordings, faces or plates, regardless of which cameras they were granted.
 * This map is what lets the matcher find the referenced devices on a
 * system-scope method too, so the device check applies uniformly.
 *
 * Detection is by INTROSPECTION of the method's Zod input (never a name
 * heuristic over source text): a top-level field is recorded when its name is
 * a known device reference AND its resolved type is `number` or
 * `array<number>`. `optional` / `nullable` / `default` wrappers are unwrapped
 * and recorded, so enforcement can skip an absent or explicitly-null value
 * (`linkDeviceId: null` means "clear the link", not "device null").
 *
 * Coverage is by INTROSPECTION of the method's Zod input (never a name
 * heuristic over source text): top-level numeric fields, arrays of numbers,
 * and — one level deep — arrays of objects carrying a numeric device field
 * (`targets[].deviceId`, the batch-link shape). The middleware resolves every
 * recorded form and requires EVERY referenced device to be covered, so new
 * batch methods are gated automatically the moment they are declared.
 *
 * The method set MUST be the same expansion `generate-method-access-map.ts` and
 * `generate-cap-routers.ts` read (`expandCapMethods`), never `capDef.methods`
 * (D590 follow-up). Auto-injected `getStatus` and contribution methods are in the
 * access map; without a selector here `referencedDeviceIds` returns [] and no
 * device grant can ever match them (FORBIDDEN for `device:all[view]` on
 * `battery.getStatus`, `motion.getStatus`, `networkLink.getStatus`).
 * `check-method-access-map-coverage.ts` fails when the two maps drift again.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { CapabilityDefinition } from '../packages/types/src/capabilities/capability-definition.js'
import { expandCapMethods } from '../packages/types/src/index.js'
import { writeIfChanged } from './codegen-write.ts'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')
const CAPS_DIR = path.join(ROOT, 'packages/types/src/capabilities')
const OUTPUT_FILE = path.join(ROOT, 'packages/types/src/generated/method-device-selectors.ts')

/**
 * Input field names that denote a DEVICE the call acts upon. Every one is an
 * authorization subject — including both ends of a copy (`sourceDeviceId` →
 * `targetDeviceId`) and the relationship ends (`parentDeviceId`,
 * `linkDeviceId`): linking your camera to a device you cannot see is exactly
 * the kind of cross-tenant write this map exists to gate.
 *
 * NOT here: `deviceKey` (an opaque STRING key, never a device id).
 */
const DEVICE_REF_FIELDS: ReadonlySet<string> = new Set([
  'deviceId',
  'deviceIds',
  'camDeviceId',
  'childDeviceId',
  'childDeviceIds',
  'parentDeviceId',
  // The plural of a subject is still the subject. `deviceManager.getChildrenBatch`
  // asks the same question as `getChildren` about a SET of parents; without the
  // plural here the batch would be the ungated way to ask it.
  'parentDeviceIds',
  'linkDeviceId',
  'sourceDeviceId',
  'targetDeviceId',
])

type DeviceRefForm = 'single' | 'array' | 'object-array'

interface DeviceRefField {
  readonly name: string
  readonly form: DeviceRefForm
  /** True when the field may be absent or explicitly null. */
  readonly optional: boolean
  /** For `object-array`: the device-id field inside each element
   *  (e.g. `targets[].deviceId` → 'deviceId'). */
  readonly itemField?: string
}

interface MethodEntry {
  readonly path: string
  readonly capScope: 'device' | 'system'
  readonly fields: readonly DeviceRefField[]
}

function kebabToCamel(str: string): string {
  return str.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

/** Zod v4 internal def accessor. Introspection-only — never used to build. */
function zodDef(schema: unknown): Record<string, unknown> | null {
  if (schema === null || typeof schema !== 'object') return null
  const internal: unknown = Reflect.get(schema, '_zod')
  if (internal === null || typeof internal !== 'object') return null
  const def: unknown = Reflect.get(internal, 'def')
  if (def === null || typeof def !== 'object') return null
  return { ...(def as Record<string, unknown>) }
}

function defType(schema: unknown): string | null {
  const def = zodDef(schema)
  const t = def?.['type']
  return typeof t === 'string' ? t : null
}

/** Peel `optional` / `nullable` / `default` / `readonly` wrappers. Reports
 *  whether any wrapper made the value skippable (absent or null). */
function unwrap(schema: unknown): { inner: unknown; optional: boolean } {
  let current = schema
  let optional = false
  for (let hop = 0; hop < 8; hop++) {
    const t = defType(current)
    if (t === 'optional' || t === 'nullable' || t === 'default' || t === 'nullish') {
      optional = true
    } else if (t !== 'readonly') {
      break
    }
    const def = zodDef(current)
    const inner = def?.['innerType']
    if (inner === undefined) break
    current = inner
  }
  return { inner: current, optional }
}

/** Classify a field schema as a numeric device reference, or null. */
function classifyField(schema: unknown): { form: DeviceRefForm; itemField?: string } | null {
  const { inner } = unwrap(schema)
  const t = defType(inner)
  if (t === 'number') return { form: 'single' }
  if (t === 'array') {
    const def = zodDef(inner)
    const { inner: element } = unwrap(def?.['element'])
    if (defType(element) === 'number') return { form: 'array' }
    // Array of objects carrying a device id — `targets[].deviceId`
    // (`snapshot.getSnapshotLinks`) is the canonical shape. One nesting
    // level, device-id field by name: the middleware reads it with a flat
    // `element[field]` walk, so deeper nesting stays unmapped ON PURPOSE
    // (and the input should be redesigned before it is extended again).
    if (defType(element) === 'object') {
      const shape = inputShape(element)
      if (shape) {
        for (const itemName of DEVICE_REF_FIELDS) {
          const itemSchema = shape[itemName]
          if (itemSchema === undefined) continue
          const { inner: itemInner } = unwrap(itemSchema)
          if (defType(itemInner) === 'number') return { form: 'object-array', itemField: itemName }
        }
      }
    }
  }
  return null
}

/** The top-level object shape of a method input, or null when the input is not
 *  an object (void, union, …). */
function inputShape(input: unknown): Record<string, unknown> | null {
  const { inner } = unwrap(input)
  if (defType(inner) !== 'object') return null
  const def = zodDef(inner)
  const shape = def?.['shape']
  if (shape === null || typeof shape !== 'object') return null
  return { ...(shape as Record<string, unknown>) }
}

function deviceRefsOf(input: unknown): DeviceRefField[] {
  const shape = inputShape(input)
  if (!shape) return []
  const out: DeviceRefField[] = []
  for (const [name, fieldSchema] of Object.entries(shape)) {
    const classified = classifyField(fieldSchema)
    if (classified === null) continue
    if (!DEVICE_REF_FIELDS.has(name)) {
      // The NAME gate is what keeps unrelated numeric fields out — but an
      // array whose ELEMENTS carry a device id is a device reference
      // regardless of the array's own name (`targets[].deviceId` is the
      // canonical batch shape, and the batch method below is the reason
      // this map exists). Any other form under an unknown name stays out.
      if (classified.form !== 'object-array') continue
    }
    const { optional } = unwrap(fieldSchema)
    out.push({
      name,
      form: classified.form,
      optional,
      ...(classified.itemField !== undefined ? { itemField: classified.itemField } : {}),
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

async function loadCaps(): Promise<MethodEntry[]> {
  const files = fs.readdirSync(CAPS_DIR).filter((f) => f.endsWith('.cap.ts'))
  const out: MethodEntry[] = []
  for (const file of files) {
    const mod: Record<string, unknown> = await import(path.join(CAPS_DIR, file))
    const exportName = Object.keys(mod).find((k) => k.endsWith('Capability'))
    if (!exportName) continue
    const capDef = mod[exportName] as CapabilityDefinition
    const routerKey = kebabToCamel(capDef.name)
    const capScope = capDef.scope === 'device' ? 'device' : 'system'
    // The EFFECTIVE surface, not the declared one: `getStatus` and the three
    // device-settings contribution methods are injected by `expandCapMethods`.
    const methods: Record<string, unknown> = { ...expandCapMethods(capDef) }
    for (const [methodName, m] of Object.entries(methods)) {
      const input = m !== null && typeof m === 'object' ? Reflect.get(m, 'input') : undefined
      const fields = deviceRefsOf(input)
      if (fields.length === 0) continue
      out.push({ path: `${routerKey}.${methodName}`, capScope, fields })
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path))
  return out
}

function renderField(f: DeviceRefField): string {
  const itemField = f.itemField !== undefined ? `, itemField: ${JSON.stringify(f.itemField)}` : ''
  return `{ name: ${JSON.stringify(f.name)}, form: ${JSON.stringify(f.form)}, optional: ${String(f.optional)}${itemField} }`
}

async function main(): Promise<void> {
  const entries = await loadCaps()
  const systemScoped = entries.filter((e) => e.capScope === 'system')

  const content = `/**
 * AUTO-GENERATED by scripts/generate-method-device-selectors.ts — DO NOT EDIT.
 *
 * Where the DEVICE REFERENCES live in each cap method's input, so the scope
 * matcher can apply the per-device check to SYSTEM-scope methods too (a
 * system-scope cap that takes a deviceId was previously never device-filtered
 * — see the generator header).
 *
 * Coverage: ${entries.length} methods carry a device reference, of which
 * ${systemScoped.length} are on SYSTEM-scope caps.
 *
 * Top-level fields, number arrays, and one-level arrays of objects carrying
 * a numeric device field (targets[].deviceId) are all mapped; the matcher
 * resolves every form and requires EVERY referenced device to be covered.
 */
/* eslint-disable */

/** How a device reference is carried: one number, an array of numbers, or an
 *  array of objects each carrying a numeric device field. */
export type DeviceRefForm = 'single' | 'array' | 'object-array'

export interface DeviceRefField {
  readonly name: string
  readonly form: DeviceRefForm
  /** When true the field may be absent or null — enforcement skips it. */
  readonly optional: boolean
  /** For object-array: the device-id field inside each element. */
  readonly itemField?: string
}

export const METHOD_DEVICE_SELECTORS: Readonly<Record<string, readonly DeviceRefField[]>> =
  Object.freeze({
${entries
  .map((e) => `  '${e.path}': [${e.fields.map(renderField).join(', ')}] as const,`)
  .join('\n')}
  } as const)

/** Cap-method paths that carry a device reference AND live on a system-scope
 *  cap — the set the v3 device check newly reaches. */
export const SYSTEM_SCOPE_DEVICE_METHODS: readonly string[] = [
${systemScoped.map((e) => `  ${JSON.stringify(e.path)},`).join('\n')}
] as const
`

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true })
  writeIfChanged(OUTPUT_FILE, content)
  // eslint-disable-next-line no-console
  console.log(
    `Wrote ${entries.length} device-bearing methods (${systemScoped.length} system-scope) → ${path.relative(ROOT, OUTPUT_FILE)}`,
  )
}

void main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
