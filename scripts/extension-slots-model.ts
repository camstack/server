/**
 * The pure half of the extension-slot codegen and its guard (D648).
 *
 * `generate-extension-slots.ts` and `check-extension-slots.ts` both need the
 * same answer to "which slots are declared, by which cap, exported under which
 * names" — so it is computed HERE, once, from the cap modules' own exports.
 * Two readers with two collectors is the drift this repo keeps paying for.
 *
 * Nothing here touches the file system: the callers load the modules and read
 * the files, which is what lets the guard be tested on fixtures.
 */

import type { ExtensionSlotDescriptor } from '../packages/types/src/device-extension/slot-descriptor.js'
import type { CapabilityDefinition } from '../packages/types/src/capabilities/capability-definition.js'
import { DeviceType } from '../packages/types/src/device/device-type.js'

/** One loaded `*.cap.ts`: its path relative to `capabilities/`, and its exports. */
export interface CapModule {
  readonly file: string
  readonly exports: Readonly<Record<string, unknown>>
}

/** One declared slot, with everything codegen and the guard need to know. */
export interface CollectedSlot {
  readonly id: string
  readonly declaringCap: string
  readonly file: string
  readonly descriptor: ExtensionSlotDescriptor
  /** The export name of the descriptor, or null when it is not exported. */
  readonly descriptorExport: string | null
  /** The export name of `descriptor.value`, or null when it is not exported. */
  readonly valueExport: string | null
  /** `descriptor.hostDeviceTypes ?? cap.deviceTypes`, or null when neither says. */
  readonly hostDeviceTypes: readonly DeviceType[] | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A capability definition among a module's exports — structurally. */
function isCapabilityDefinition(value: unknown): value is CapabilityDefinition {
  return (
    isRecord(value) &&
    typeof value['name'] === 'string' &&
    (value['scope'] === 'system' || value['scope'] === 'device') &&
    isRecord(value['methods'])
  )
}

function exportNameOf(mod: CapModule, value: unknown): string | null {
  for (const [name, exported] of Object.entries(mod.exports)) {
    if (exported === value) return name
  }
  return null
}

/** Every slot declared by every cap, in a stable order (by slot id). */
export function collectExtensionSlots(modules: readonly CapModule[]): readonly CollectedSlot[] {
  const out: CollectedSlot[] = []
  for (const mod of modules) {
    for (const exported of Object.values(mod.exports)) {
      if (!isCapabilityDefinition(exported)) continue
      const slots = exported.extensionSlots ?? []
      for (const descriptor of slots) {
        out.push({
          id: descriptor.id,
          declaringCap: exported.name,
          file: mod.file,
          descriptor,
          descriptorExport: exportNameOf(mod, descriptor),
          valueExport: exportNameOf(mod, descriptor.value),
          hostDeviceTypes: descriptor.hostDeviceTypes ?? exported.deviceTypes ?? null,
        })
      }
    }
  }
  return out.toSorted(
    (a, b) => a.id.localeCompare(b.id) || a.declaringCap.localeCompare(b.declaringCap),
  )
}

/** `DeviceType.Camera` for `'camera'` — the enum MEMBER, never a string literal. */
function deviceTypeMember(value: DeviceType): string {
  for (const [key, member] of Object.entries(DeviceType)) {
    if (member === value) return `DeviceType.${key}`
  }
  throw new Error(`extension slots: "${value}" is not a DeviceType member`)
}

/**
 * Render `packages/types/src/generated/extension-slots.ts`.
 *
 * Refuses (throws) rather than emitting something that would not compile or
 * would lie: a slot whose descriptor or value schema is not a named export, a
 * slot with no host types, a duplicate id. The guard reports the same defects
 * by name; this is what stops codegen from writing them first.
 */
export function renderExtensionSlotsModule(slots: readonly CollectedSlot[]): string {
  if (slots.length === 0) throw new Error('extension slots: no cap declares a slot')
  const seen = new Set<string>()
  for (const slot of slots) {
    if (seen.has(slot.id))
      throw new Error(`extension slots: slot id "${slot.id}" is declared twice`)
    seen.add(slot.id)
    if (slot.descriptorExport === null || slot.valueExport === null) {
      throw new Error(
        `extension slots: "${slot.id}" (${slot.file}) — the descriptor and its value schema must both be named exports`,
      )
    }
    if (slot.hostDeviceTypes === null || slot.hostDeviceTypes.length === 0) {
      throw new Error(
        `extension slots: "${slot.id}" has no host device types — declare hostDeviceTypes on a cap without deviceTypes`,
      )
    }
  }

  const importsByFile = new Map<string, Set<string>>()
  for (const slot of slots) {
    const names = importsByFile.get(slot.file) ?? new Set<string>()
    if (slot.descriptorExport !== null) names.add(slot.descriptorExport)
    if (slot.valueExport !== null) names.add(slot.valueExport)
    importsByFile.set(slot.file, names)
  }
  const importLines = [...importsByFile.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(
      ([file, names]) =>
        `import { ${[...names].toSorted().join(', ')} } from '../capabilities/${file.replace(/\.ts$/, '.js')}'`,
    )

  const hostUnion = new Set<DeviceType>()
  for (const slot of slots) for (const t of slot.hostDeviceTypes ?? []) hostUnion.add(t)
  const hostUnionSorted = [...hostUnion].toSorted()

  const ids = slots.map((s) => `'${s.id}'`).join(', ')
  const table = slots
    .map(
      (s) =>
        `  '${s.id}': {\n` +
        `    descriptor: ${s.descriptorExport},\n` +
        `    declaringCap: '${s.declaringCap}',\n` +
        `    hostDeviceTypes: [${(s.hostDeviceTypes ?? []).map(deviceTypeMember).join(', ')}],\n` +
        `  },`,
    )
    .join('\n')
  const unionMembers = slots
    .map((s) => `  ${s.valueExport}.extend({ slot: z.literal('${s.id}') }),`)
    .join('\n')

  return `/**
 * AUTO-GENERATED by scripts/generate-extension-slots.ts — DO NOT EDIT.
 *
 * Every extension slot declared by a capability (\`extensionSlots\` in its
 * \`*.cap.ts\`, D648), folded into one typed table. Imports ONLY the declaring
 * caps' descriptors and value schemas — never the caps barrel — so
 * \`device-extension.cap.ts\` can import this module without a cycle.
 *
 * Coverage: ${slots.length} slot(s).
 */
import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import type { ExtensionSlotDescriptor } from '../device-extension/slot-descriptor.js'
${importLines.join('\n')}

/** Every declared slot id, in table order. */
export const EXTENSION_SLOT_IDS = [${ids}] as const

export const ExtensionSlotIdSchema = z.enum(EXTENSION_SLOT_IDS)
export type ExtensionSlotId = z.infer<typeof ExtensionSlotIdSchema>

/** One row of the table: the descriptor, who declared it, where it is offered. */
export interface ExtensionSlotEntry {
  readonly descriptor: ExtensionSlotDescriptor
  readonly declaringCap: string
  /** \`descriptor.hostDeviceTypes ?? declaringCap.deviceTypes\`, resolved here. */
  readonly hostDeviceTypes: readonly DeviceType[]
}

export const EXTENSION_SLOTS: Readonly<Record<ExtensionSlotId, ExtensionSlotEntry>> = {
${table}
}

/** A slot's editable value, discriminated on \`slot\`. */
export const ExtensionSlotValueSchema = z.discriminatedUnion('slot', [
${unionMembers}
])
export type ExtensionSlotValue = z.infer<typeof ExtensionSlotValueSchema>

/** Every device type at least one slot is offered on — \`device-extension\`'s \`deviceTypes\`. */
export const EXTENSION_HOST_DEVICE_TYPES: readonly DeviceType[] = [${hostUnionSorted.map(deviceTypeMember).join(', ')}]
`
}
