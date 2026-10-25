/**
 * What a composition may BUILD on a device type (G2, D676): the caps a new
 * device of that type, or an existing one that lacks them, can be given. The
 * blockers are the validator's own refusal codes, and a spec compares this
 * listing with `planComposition` for every capability — the editor can never
 * offer a feature the save would refuse for the same reason.
 */
import { z } from 'zod'
import type { CapabilityDefinition } from '../capabilities/capability-definition.js'
import type { DeviceType } from '../device/device-type.js'
import { planCompositionEvents } from './composition-events.js'
import { CompositionFieldKindSchema, type CompositionProblemCode } from './composition-report.js'
import { describeTopLevelStateFields, requiredTopLevelKeys } from './state-fields.js'
import { BASE_DEVICE_CAPS } from './validate-composition.js'

export const ComposableFieldSchema = z.object({
  path: z.string(),
  kind: CompositionFieldKindSchema,
  nullable: z.boolean(),
  required: z.boolean(),
  enumValues: z.array(z.string()).optional(),
})
export type ComposableField = z.infer<typeof ComposableFieldSchema>

export const ComposableCapabilitySchema = z.object({
  cap: z.string(),
  fields: z.array(ComposableFieldSchema),
  /** Present for an item-array cap (`consumables.items`). */
  itemArray: z.object({ path: z.string(), keyField: z.string() }).optional(),
})
export type ComposableCapability = z.infer<typeof ComposableCapabilitySchema>

export const ComposableCapabilitiesSchema = z.object({ caps: z.array(ComposableCapabilitySchema) })
export type ComposableCapabilities = z.infer<typeof ComposableCapabilitiesSchema>

/** Why a cap cannot be BUILT (new device, or added to an existing one) on `deviceType`; [] = it can. */
export function builtCapabilityBlockers(
  def: CapabilityDefinition,
  deviceType: DeviceType,
): readonly CompositionProblemCode[] {
  if (BASE_DEVICE_CAPS.has(def.name)) return ['not-composable']
  const state = def.runtimeState
  if (def.scope !== 'device' || state === undefined) return ['not-composable']
  const blockers: CompositionProblemCode[] = []
  if (def.deviceTypes !== undefined && !def.deviceTypes.includes(deviceType))
    blockers.push('wrong-device-type')
  const served = Object.entries(def.methods).filter(
    ([name, m]) => m.systemOnly !== true && def.composedMethods?.[name] === undefined,
  )
  if (served.length > 0) blockers.push('has-commands')
  const fields = describeTopLevelStateFields(state)
  const itemArrayPath = def.status?.itemArray?.path ?? null
  const nestedRequired = requiredTopLevelKeys(state).some(
    (key) => key !== itemArrayPath && !fields.has(key),
  )
  if (nestedRequired) blockers.push('not-composable')
  // A declared state-derived event the composer cannot emit (no category
  // mapping, payload not buildable from { deviceId, timestamp }) refuses the
  // cap as `not-composable` in `planCompositionEvents` — the same verdict here.
  const eventBlocked = planCompositionEvents(
    def,
    { featureIndex: 0, cap: def.name, mode: 'new' },
    [],
  ).problems.some((p) => p.code === 'not-composable')
  if (eventBlocked && !blockers.includes('not-composable')) blockers.push('not-composable')
  return blockers
}

/** Every cap with no blocker, sorted by name. */
export function describeComposableCaps(
  defs: readonly CapabilityDefinition[],
  deviceType: DeviceType,
): readonly ComposableCapability[] {
  return defs
    .filter((def) => builtCapabilityBlockers(def, deviceType).length === 0)
    .map((def) => {
      const state = def.runtimeState
      const fields = state === undefined ? [] : [...describeTopLevelStateFields(state).values()]
      const itemArray = def.status?.itemArray
      return {
        cap: def.name,
        fields: fields.map((f) => ({
          path: f.path,
          kind: f.kind,
          nullable: f.nullable,
          required: f.required,
          ...(f.enumValues === undefined ? {} : { enumValues: [...f.enumValues] }),
        })),
        ...(itemArray === undefined
          ? {}
          : { itemArray: { path: itemArray.path, keyField: itemArray.keyField } }),
      }
    })
    .toSorted((a, b) => a.cap.localeCompare(b.cap))
}
