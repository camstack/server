/**
 * The Alexa exposure lists move into the `skill-exports` record (planning#408 P4). Two
 * migrations, both `block-owner`: the addon must not serve a membership it cannot trust, and
 * after them nothing reads the old keys.
 *
 *  1. `moveExposureToRecord` (procedure): `exposed` and `exposedActions` become the record under
 *     the instance id. An existing record is never overwritten. A record this pass just wrote is
 *     read BACK and must equal what the settings carried, or the pass throws.
 *  2. `planDropMovedExposure` (plan): the two keys are deleted only while the record holds every
 *     device and action the settings carried; a record that cannot be read leaves them in place.
 */
import { type MigrationPlan, type MigrationProcedureResult, preconditionOf } from '@camstack/types'
import type { ActionSceneEntry } from '../action-scenes.js'
import {
  ALEXA_INSTANCE_ID,
  ActionSceneEntrySchema,
  ExposedDeviceEntrySchema,
  MOVED_EXPOSURE_KEYS,
  SKILL_EXPORTS_NAME,
  type SkillExportsBody,
} from '../skill-records.js'
import type { ExposedDeviceEntry } from '../types.js'

export const ADDON_SETTINGS_TABLE = 'addon-settings'

export interface ExposureMigrationLog {
  warn(message: string): void
}

export interface MoveExposurePorts extends ExposureMigrationLog {
  /** The addon's stored settings as written. Throws when they cannot be read. */
  readRawStored(): Promise<Readonly<Record<string, unknown>>>
  /** Put the `skill-exports` record with `ifRev: 0`; `exists` when one is already there. */
  putExports(body: SkillExportsBody): Promise<'created' | 'exists'>
  /** The `skill-exports` record; null when absent. Throws when unreadable. */
  readExports(): Promise<SkillExportsBody | null>
}

export type DropMovedExposurePorts = Pick<
  MoveExposurePorts,
  'warn' | 'readRawStored' | 'readExports'
>

function devicesOf(value: unknown): readonly ExposedDeviceEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): ExposedDeviceEntry[] => {
    const parsed = ExposedDeviceEntrySchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

function actionsOf(value: unknown): readonly ActionSceneEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): ActionSceneEntry[] => {
    const parsed = ActionSceneEntrySchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

/** Key-order-independent JSON, so "identical" does not depend on how a store orders keys. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export async function moveExposureToRecord(
  ports: MoveExposurePorts,
): Promise<MigrationProcedureResult> {
  const stored = await ports.readRawStored()
  if (!MOVED_EXPOSURE_KEYS.some((key) => key in stored)) {
    return { outcome: 'already-done', summary: { moved: false } }
  }
  const devices = devicesOf(stored['exposed'])
  const actions = actionsOf(stored['exposedActions'])
  const dropped =
    (Array.isArray(stored['exposed']) ? stored['exposed'].length : 0) -
    devices.length +
    ((Array.isArray(stored['exposedActions']) ? stored['exposedActions'].length : 0) -
      actions.length)
  if (dropped > 0) {
    ports.warn(
      `Alexa migration: ${dropped} exposure entr(ies) were not understood and are left out`,
    )
  }
  const body: SkillExportsBody = { name: SKILL_EXPORTS_NAME, devices, actions }
  const put = await ports.putExports(body)
  if (put === 'exists') return { outcome: 'already-done', summary: { moved: false } }
  const held = await ports.readExports()
  if (
    held === null ||
    canonical(held.devices) !== canonical(devices) ||
    canonical(held.actions) !== canonical(actions)
  ) {
    throw new Error(
      'the Alexa exposure record does not match the legacy settings; nothing was cleared',
    )
  }
  return {
    outcome: 'done',
    summary: { moved: true, devices: devices.length, actions: actions.length },
  }
}

const rowId = (key: string): string => `${ALEXA_INSTANCE_ID}.${key}`

export async function planDropMovedExposure(ports: DropMovedExposurePorts): Promise<MigrationPlan> {
  const stored = await ports.readRawStored()
  const present = MOVED_EXPOSURE_KEYS.filter((key) => key in stored)
  if (present.length === 0) return { edits: [] }
  const refuse = (reason: string): never => {
    ports.warn(`Alexa migration: the legacy exposure keys are kept: ${reason}`)
    throw new Error(`the legacy Alexa exposure keys are not deleted: ${reason}`)
  }
  const held = await ports.readExports()
  if (held === null) return refuse('no exposure record exists')
  const heldDevices = new Set(held.devices.map((d) => d.deviceId))
  for (const device of devicesOf(stored['exposed'])) {
    if (!heldDevices.has(device.deviceId)) {
      return refuse(`the record lacks the device ${device.deviceId}`)
    }
  }
  const heldActions = new Set(held.actions.map((a) => a.actionId))
  for (const action of actionsOf(stored['exposedActions'])) {
    if (!heldActions.has(action.actionId)) {
      return refuse(`the record lacks the action ${action.actionId}`)
    }
  }
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys: present.map(rowId),
        precondition: preconditionOf(
          Object.fromEntries(
            present.map((key) => [
              rowId(key),
              { addonId: ALEXA_INSTANCE_ID, key, value: stored[key] },
            ]),
          ),
        ),
      },
    ],
  }
}
