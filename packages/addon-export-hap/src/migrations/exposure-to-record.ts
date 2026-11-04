/**
 * The exposure lists the addon kept in its settings (`exposed`: the devices it mirrors, with
 * their per-device settings; `exposedActions`: the actions it publishes) move into the
 * `hap-bridge-exports` record of the default instance (D985, D996). Two migrations, in order:
 *
 *  1. `moveExposureToRecord` (procedure): put the record with `ifRev: 0`, read it BACK and
 *     compare it with what the settings carried; a record that does not hold the same lists
 *     throws and the settings are kept. An existing record is never overwritten.
 *  2. `planDropExposureKeys` (plan): the two keys are deleted from the canonical `addon-settings`
 *     rows, and only while the record holds exactly what they carry. A record that differs (the
 *     operator edited the lists since) keeps the old keys, which nothing reads any more.
 *
 * An entry the schema does not know (a mapper kind the addon no longer serves) is dropped on the
 * way, which is what the boot sweep did to it anyway.
 */
import { type MigrationPlan, type MigrationProcedureResult, preconditionOf } from '@camstack/types'
import {
  ActionExportEntrySchema,
  ExposedConfigEntrySchema,
  HAP_EXPOSURE_NAME,
  type HapBridgeExportsBody,
  MOVED_EXPOSURE_KEYS,
} from '../hap-export-records.js'
import { HAP_DEFAULT_INSTANCE_ID } from '../hap-instance-kinds.js'
import { ADDON_SETTINGS_TABLE, type HubNodeFieldsPorts } from './hub-node-fields.js'

export interface ExposureToRecordPorts extends HubNodeFieldsPorts {
  /** Put the default `hap-bridge-exports` record with `ifRev: 0`; `exists` when one is there. */
  putExposure(body: HapBridgeExportsBody): Promise<'created' | 'exists'>
  /** The default `hap-bridge-exports` record; null when absent. */
  readExposure(): Promise<HapBridgeExportsBody | null>
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

function parsedList<T>(
  value: unknown,
  parse: (entry: unknown) => { success: true; data: T } | { success: false },
): readonly T[] {
  if (!Array.isArray(value)) return []
  const kept: T[] = []
  for (const entry of value) {
    const parsed = parse(entry)
    if (parsed.success) kept.push(parsed.data)
  }
  return kept
}

/** The record body the legacy settings describe. */
export function exposureBodyFrom(stored: Readonly<Record<string, unknown>>): HapBridgeExportsBody {
  return {
    name: HAP_EXPOSURE_NAME,
    devices: parsedList(stored['exposed'], (e) => ExposedConfigEntrySchema.safeParse(e)),
    actions: parsedList(stored['exposedActions'], (e) => ActionExportEntrySchema.safeParse(e)),
  }
}

function sameLists(a: HapBridgeExportsBody, b: HapBridgeExportsBody): boolean {
  return (
    canonical(a.devices) === canonical(b.devices) && canonical(a.actions) === canonical(b.actions)
  )
}

export async function moveExposureToRecord(
  ports: ExposureToRecordPorts,
): Promise<MigrationProcedureResult> {
  const stored = await ports.readStored(MOVED_EXPOSURE_KEYS)
  if (!MOVED_EXPOSURE_KEYS.some((key) => key in stored)) {
    return { outcome: 'already-done', summary: { moved: false } }
  }
  const body = exposureBodyFrom(stored)
  const put = await ports.putExposure(body)
  const held = await ports.readExposure()
  if (held === null) throw new Error('the HomeKit exposure record cannot be read back')
  if (put === 'created' && !sameLists(held, body)) {
    throw new Error('the HomeKit exposure record does not hold the lists it adopted')
  }
  return put === 'created'
    ? {
        outcome: 'done',
        summary: { moved: true, devices: body.devices.length },
      }
    : { outcome: 'already-done', summary: { moved: false } }
}

const rowId = (key: string): string => `${HAP_DEFAULT_INSTANCE_ID}.${key}`

export async function planDropExposureKeys(ports: ExposureToRecordPorts): Promise<MigrationPlan> {
  const stored = await ports.readStored(MOVED_EXPOSURE_KEYS)
  const present = MOVED_EXPOSURE_KEYS.filter((key) => key in stored)
  if (present.length === 0) return { edits: [] }
  const held = await ports.readExposure()
  if (held === null || !sameLists(held, exposureBodyFrom(stored))) return { edits: [] }
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys: present.map(rowId),
        // The rows as the settings writer stores them: `{ addonId, key, value }`.
        precondition: preconditionOf(
          Object.fromEntries(
            present.map((key) => [
              rowId(key),
              { addonId: HAP_DEFAULT_INSTANCE_ID, key, value: stored[key] },
            ]),
          ),
        ),
      },
    ],
  }
}
