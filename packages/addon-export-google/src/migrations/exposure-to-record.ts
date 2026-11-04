/**
 * The Google exposure lists move into the `google-exports` record (planning#408 P4). Two
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
import { ADDON_SETTINGS_TABLE } from './drop-public-hub-url.js'
import {
  ActionSceneEntrySchema,
  ExposedDeviceEntrySchema,
  GOOGLE_EXPORTS_NAME,
  GOOGLE_INSTANCE_ID,
  type GoogleExportsBody,
  MOVED_EXPOSURE_KEYS,
} from '../export-records.js'
import type { ExposedDeviceEntry } from '../types.js'

export interface ExposureMigrationLog {
  warn(message: string): void
}

export interface MoveExposurePorts extends ExposureMigrationLog {
  /** The addon's stored settings as written. Throws when they cannot be read. */
  readStored(): Promise<Readonly<Record<string, unknown>>>
  /** Put the `google-exports` record with `ifRev: 0`; `exists` when one is already there. */
  putExports(body: GoogleExportsBody): Promise<'created' | 'exists'>
  /** The `google-exports` record; null when absent. Throws when unreadable. */
  readExports(): Promise<GoogleExportsBody | null>
}

export type DropMovedExposurePorts = Pick<MoveExposurePorts, 'warn' | 'readStored' | 'readExports'>

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
  const stored = await ports.readStored()
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
      `Google migration: ${dropped} exposure entr(ies) were not understood and are left out`,
    )
  }
  const body: GoogleExportsBody = { name: GOOGLE_EXPORTS_NAME, devices, actions }
  const put = await ports.putExports(body)
  if (put === 'exists') return { outcome: 'already-done', summary: { moved: false } }
  const held = await ports.readExports()
  if (
    held === null ||
    canonical(held.devices) !== canonical(devices) ||
    canonical(held.actions) !== canonical(actions)
  ) {
    throw new Error(
      'the Google exposure record does not match the legacy settings; nothing was cleared',
    )
  }
  return {
    outcome: 'done',
    summary: { moved: true, devices: devices.length, actions: actions.length },
  }
}

const rowId = (key: string): string => `${GOOGLE_INSTANCE_ID}.${key}`

export async function planDropMovedExposure(ports: DropMovedExposurePorts): Promise<MigrationPlan> {
  const stored = await ports.readStored()
  const present = MOVED_EXPOSURE_KEYS.filter((key) => key in stored)
  if (present.length === 0) return { edits: [] }
  const refuse = (reason: string): never => {
    ports.warn(`Google migration: the legacy exposure keys are kept: ${reason}`)
    throw new Error(`the legacy Google exposure keys are not deleted: ${reason}`)
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
              { addonId: GOOGLE_INSTANCE_ID, key, value: stored[key] },
            ]),
          ),
        ),
      },
    ],
  }
}
