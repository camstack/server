#!/usr/bin/env tsx
/**
 * Ecosystem-export coverage guard — a capability either exports, or someone
 * wrote down why it does not.
 *
 * ── The two bug classes this prevents ──────────────────────────────────────
 *
 * **1. A capability nobody decided about.** The previous Home Assistant
 * exporter had a default branch: anything it did not recognise still produced
 * an entity. Measured on 2026-08-05, 177 of 293 devices carried entities that
 * could never receive a value. The current exporter replaced the default
 * branch with two explicit tables (`CAP_ENTITY_MAP` / `CAPS_NOT_EXPORTED`) and
 * a `unclassifiedCaps` warning — but that warning fires at RECONCILE time, on
 * a hub that happens to have the device bound, into a log line nobody reads.
 * A new `*.cap.ts` therefore ships undecided and stays undecided. This guard
 * moves the question to CI, where it is asked of the author, in the diff that
 * introduces the cap.
 *
 * **2. A field name nobody checked against the schema.** Three tables describe
 * "which field of a cap's status carries the value":
 * `CAP_ENTITY_MAP` (Home Assistant), `SENSOR_MAP`
 * (`packages/types/src/device/device-control-resolution.ts`, the admin-ui /
 * viewer control decision) and `HAP_CAP_SERVICES` (HomeKit). They
 * are three hand-written tables that share no code, and they already disagree:
 * `celsius`/`temperature`, `percent`/`humidity`, `lux`/`illuminance`. Exactly
 * one side can be right, and the authority is neither table: it is the cap's
 * own status schema. The ecosystem-export plan (§3.1, constraint 2) defers the
 * shared descriptor table to a train and names THIS guard as what keeps the
 * tables aligned in the meantime. A mapped field that does not exist in the
 * schema is an entity that is published and can never carry a value — the same
 * failure as (1), arrived at from the other direction.
 *
 * ── Why there is an expectations file ──────────────────────────────────────
 * `scripts/check-export-coverage.expectations.json` holds the violations that
 * exist on `main` today, each with a written reason and the task that resolves
 * it. It is a RATCHET, in the same spirit as `scripts/ci-baseline.json`: an
 * entry that is no longer needed is itself a failure, so the list can only
 * shrink. Making the guard red on day one would have taught everyone to skip
 * it; making it advisory would have taught everyone to ignore it.
 *
 * Usage: npx tsx scripts/check-export-coverage.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')

const CAPS_INDEX = 'packages/types/src/capabilities/index.ts'
const ENTITY_CATALOG = 'packages/addon-provider-homeassistant/src/ha-export/entity-catalog.ts'
const ITEM_ENTITIES = 'packages/addon-provider-homeassistant/src/ha-export/item-entities.ts'
const CONTROL_RESOLUTION = 'packages/types/src/device/device-control-resolution.ts'
const HAP_GENERIC_ACCESSORY = 'packages/addon-export-hap/src/mappers/generic-accessory.ts'
const EXPECTATIONS = 'scripts/check-export-coverage.expectations.json'

// ── The expectations file ───────────────────────────────────────────────────

const ReasonSchema = z.string().min(1)
const ResolvedBySchema = z.string().min(1)

const UnclassifiedExpectationSchema = z.object({
  cap: z.string().min(1),
  reason: ReasonSchema,
  resolvedBy: ResolvedBySchema,
})

const MissingDefinitionExpectationSchema = z.object({
  cap: z.string().min(1),
  reason: ReasonSchema,
  resolvedBy: ResolvedBySchema,
})

const FieldExpectationSchema = z.object({
  cap: z.string().min(1),
  /** The field the table names today. */
  mappedField: z.string().min(1),
  /** The field the cap's status schema actually declares — the authority. */
  schemaField: z.string().min(1),
  reason: ReasonSchema,
  resolvedBy: ResolvedBySchema,
})

const HapGenericTableRefSchema = z.object({
  file: z.string().min(1),
  exportName: z.string().min(1),
})

const ExpectationsSchema = z.object({
  unclassifiedCaps: z.array(UnclassifiedExpectationSchema),
  mappedCapsWithoutDefinition: z.array(MissingDefinitionExpectationSchema),
  fieldsNotInStatusSchema: z.array(FieldExpectationSchema),
  hapGenericTable: HapGenericTableRefSchema.nullable(),
})

export type UnclassifiedExpectation = z.infer<typeof UnclassifiedExpectationSchema>
export type MissingDefinitionExpectation = z.infer<typeof MissingDefinitionExpectationSchema>
export type FieldExpectation = z.infer<typeof FieldExpectationSchema>
export type HapGenericTableRef = z.infer<typeof HapGenericTableRefSchema>
export type ExportCoverageExpectations = z.infer<typeof ExpectationsSchema>

/** Validate the expectations file at the boundary. A malformed entry (an empty
 *  reason, a missing owner) is refused rather than silently waiving a rule. */
export function parseExpectations(raw: unknown): ExportCoverageExpectations {
  return ExpectationsSchema.parse(raw)
}

// ── The decision ────────────────────────────────────────────────────────────

export interface CapFacts {
  readonly name: string
  /**
   * Top-level keys of the cap's status schema (falling back to its
   * runtime-state schema, which is the slice an exporter actually reads).
   * `null` when the cap declares neither — a `button` carries a command, not a
   * value, and no field assertion is meaningful.
   */
  readonly statusFields: readonly string[] | null
}

/** The two things a descriptor tells this guard: which slice field it reads,
 *  and which fields its SECONDARY entities read. Deliberately structural:
 *  `CAP_ENTITY_MAP` entries carry platform / deviceClass / unit / writable
 *  too, and pinning those here would make the guard a second copy of the
 *  table.
 *
 *  `extras` is read because the primary field was the only one checked, and
 *  a widened capability is mostly extras: a `climate-control` names ONE field
 *  as its primary and nine more underneath it, `media-player` five,
 *  `vacuum-control` four. Those nine were never asserted against the schema
 *  — and they are the fields the 2026-08-14 write routes made LOAD-BEARING,
 *  because `fanMode`, `operationMode`, `fanSpeed`, `source`, `targetLow` and
 *  `targetHigh` are now what a native Home Assistant control writes through.
 *  A typo there is a control that reads nothing and writes into the void,
 *  which is the exact failure the primary-field check exists to prevent,
 *  reached one level down. */
export interface FieldMapping {
  readonly field: string
  /** Suffix → the slice field that secondary entity reads. Absent is none. */
  readonly extras?: Readonly<Record<string, string>>
}

/** What this guard reads of a per-item mapping: where its items live. */
export interface ItemMapping {
  readonly itemsField: string
}

export interface ExportCoverageInput {
  /** Every device-scoped capability that declares `deviceTypes`. */
  readonly deviceCaps: readonly CapFacts[]
  readonly capEntityMap: Readonly<Record<string, FieldMapping>>
  readonly capsNotExported: readonly string[]
  /** `ITEM_ENTITY_MAP` — capabilities minted one entity set per item. */
  readonly itemEntityMap: Readonly<Record<string, ItemMapping>>
  readonly sensorMap: Readonly<Record<string, FieldMapping>>
  /** The generic (non-camera) HomeKit mapper exists — the trigger that makes
   *  the HomeKit half of this guard mandatory. */
  readonly hapGenericAccessoryExists: boolean
  /** The file `expectations.hapGenericTable` points at exists. */
  readonly hapGenericTableRefExists: boolean
  /** Cap names the HAP generic table covers, or `null` when it is not wired. */
  readonly hapGenericTableCaps: readonly string[] | null
  readonly expectations: ExportCoverageExpectations
}

export type ViolationKind =
  | 'unclassified-cap'
  | 'stale-unclassified-expectation'
  | 'mapped-cap-without-definition'
  | 'stale-missing-definition-expectation'
  | 'field-not-in-status-schema'
  | 'extra-field-not-in-status-schema'
  | 'bad-field-expectation'
  | 'stale-field-expectation'
  | 'table-field-disagreement'
  | 'sensor-map-field-not-in-status-schema'
  | 'hap-generic-table-unwired'
  | 'stale-hap-generic-table'
  | 'hap-cap-without-definition'
  | 'item-field-not-in-status-schema'
  | 'item-cap-without-definition'
  | 'item-cap-also-excluded'

export interface Violation {
  readonly kind: ViolationKind
  readonly subject: string
  readonly message: string
  readonly fix: string
}

function fieldsOf(caps: readonly CapFacts[]): ReadonlyMap<string, readonly string[] | null> {
  return new Map(caps.map((c) => [c.name, c.statusFields]))
}

function checkCoverage(input: ExportCoverageInput, out: Violation[]): void {
  const classified = new Set([
    ...Object.keys(input.capEntityMap),
    ...Object.keys(input.itemEntityMap),
    ...input.capsNotExported,
  ])
  const expected = new Map(input.expectations.unclassifiedCaps.map((e) => [e.cap, e]))
  const defined = new Set(input.deviceCaps.map((c) => c.name))

  for (const cap of input.deviceCaps) {
    if (classified.has(cap.name) || expected.has(cap.name)) continue
    out.push({
      kind: 'unclassified-cap',
      subject: cap.name,
      message: `device-scoped capability '${cap.name}' is in none of CAP_ENTITY_MAP, ITEM_ENTITY_MAP and CAPS_NOT_EXPORTED`,
      fix: `map it in ${ENTITY_CATALOG}, or exclude it there with a written reason, or add it to ${EXPECTATIONS} naming the task that will`,
    })
  }

  for (const e of expected.values()) {
    if (!defined.has(e.cap)) {
      out.push({
        kind: 'stale-unclassified-expectation',
        subject: e.cap,
        message: `expectation for '${e.cap}', which is no longer a device-scoped capability`,
        fix: `drop the entry from ${EXPECTATIONS}`,
      })
      continue
    }
    if (classified.has(e.cap)) {
      out.push({
        kind: 'stale-unclassified-expectation',
        subject: e.cap,
        message: `'${e.cap}' is now classified — the expectation has been answered`,
        fix: `drop the entry from ${EXPECTATIONS}; this list only ever shrinks`,
      })
    }
  }
}

function checkMappedCapsExist(input: ExportCoverageInput, out: Violation[]): void {
  const defined = new Set(input.deviceCaps.map((c) => c.name))
  const expected = new Map(input.expectations.mappedCapsWithoutDefinition.map((e) => [e.cap, e]))

  for (const cap of Object.keys(input.capEntityMap)) {
    if (defined.has(cap) || expected.has(cap)) continue
    out.push({
      kind: 'mapped-cap-without-definition',
      subject: cap,
      message: `CAP_ENTITY_MAP maps '${cap}', which is not a device-scoped capability`,
      fix: `remove the mapping in ${ENTITY_CATALOG}, or record it in ${EXPECTATIONS} with the reason it is still there`,
    })
  }

  for (const e of expected.values()) {
    if (defined.has(e.cap)) {
      out.push({
        kind: 'stale-missing-definition-expectation',
        subject: e.cap,
        message: `'${e.cap}' now has a capability definition — the expectation has been answered`,
        fix: `drop the entry from ${EXPECTATIONS}`,
      })
      continue
    }
    if (!(e.cap in input.capEntityMap)) {
      out.push({
        kind: 'stale-missing-definition-expectation',
        subject: e.cap,
        message: `'${e.cap}' is no longer in CAP_ENTITY_MAP`,
        fix: `drop the entry from ${EXPECTATIONS}`,
      })
    }
  }
}

function checkFields(input: ExportCoverageInput, out: Violation[]): void {
  const schema = fieldsOf(input.deviceCaps)
  const waived = new Map(input.expectations.fieldsNotInStatusSchema.map((e) => [e.cap, e]))

  for (const [cap, mapping] of Object.entries(input.capEntityMap)) {
    const fields = schema.get(cap)
    // A cap with no definition is already reported by checkMappedCapsExist; a
    // cap with no status schema carries a command, not a value.
    if (fields === undefined || fields === null) continue
    if (fields.includes(mapping.field)) continue
    const waiver = waived.get(cap)
    if (waiver !== undefined && waiver.mappedField === mapping.field) continue
    out.push({
      kind: 'field-not-in-status-schema',
      subject: cap,
      message: `CAP_ENTITY_MAP['${cap}'].field is '${mapping.field}', absent from the cap status schema [${fields.join(', ')}]`,
      fix: `the schema is the authority — use one of those fields in ${ENTITY_CATALOG}, or waive it in ${EXPECTATIONS} naming the authoritative field`,
    })
  }

  /**
   * The SECONDARY entities, checked against the same authority. A capability
   * that Tier A widened is mostly extras, and the 2026-08-14 write routes
   * made six of them the field a native Home Assistant control writes
   * through. There is deliberately no waiver list for these: the primary
   * one exists because eleven descriptors were already wrong when the guard
   * was written, and none of the extras is.
   */
  for (const [cap, mapping] of Object.entries(input.capEntityMap)) {
    const fields = schema.get(cap)
    if (fields === undefined || fields === null) continue
    for (const [suffix, field] of Object.entries(mapping.extras ?? {})) {
      if (fields.includes(field)) continue
      out.push({
        kind: 'extra-field-not-in-status-schema',
        subject: `${cap}.${suffix}`,
        message: `CAP_ENTITY_MAP['${cap}'].extras['${suffix}'].field is '${field}', absent from the cap status schema [${fields.join(', ')}]`,
        fix: `the schema is the authority — use one of those fields in ${ENTITY_CATALOG}`,
      })
    }
  }

  for (const e of waived.values()) {
    const fields = schema.get(e.cap)
    if (fields === undefined || fields === null) {
      out.push({
        kind: 'stale-field-expectation',
        subject: e.cap,
        message: `field waiver for '${e.cap}', which declares no status schema (or no longer exists)`,
        fix: `drop the entry from ${EXPECTATIONS}`,
      })
      continue
    }
    if (!fields.includes(e.schemaField)) {
      out.push({
        kind: 'bad-field-expectation',
        subject: e.cap,
        message: `field waiver for '${e.cap}' names schemaField '${e.schemaField}', which the status schema [${fields.join(', ')}] does not declare`,
        fix: `a waiver must record the RIGHT answer, so the fix is already written down — correct schemaField in ${EXPECTATIONS}`,
      })
      continue
    }
    const mapping = input.capEntityMap[e.cap]
    if (mapping === undefined || mapping.field !== e.mappedField) {
      out.push({
        kind: 'stale-field-expectation',
        subject: e.cap,
        message: `field waiver for '${e.cap}' no longer describes CAP_ENTITY_MAP (mapped field is now '${mapping?.field ?? 'absent'}')`,
        fix: `drop the entry from ${EXPECTATIONS}`,
      })
    }
  }
}

function checkTablesAgree(input: ExportCoverageInput, out: Violation[]): void {
  const schema = fieldsOf(input.deviceCaps)
  const waived = new Map(input.expectations.fieldsNotInStatusSchema.map((e) => [e.cap, e]))

  for (const [cap, sensor] of Object.entries(input.sensorMap)) {
    const fields = schema.get(cap)
    if (fields !== undefined && fields !== null && !fields.includes(sensor.field)) {
      out.push({
        kind: 'sensor-map-field-not-in-status-schema',
        subject: cap,
        message: `SENSOR_MAP['${cap}'].field is '${sensor.field}', absent from the cap status schema [${fields.join(', ')}]`,
        fix: `fix it in ${CONTROL_RESOLUTION} — this table carries no waivers`,
      })
      // One root cause per fix: a bogus SENSOR_MAP field also disagrees with
      // CAP_ENTITY_MAP, and reporting that too would send the reader at the
      // wrong table.
      continue
    }

    const ha = input.capEntityMap[cap]
    if (ha === undefined || ha.field === sensor.field) continue
    // The disagreement is tolerated only while the HA side is the KNOWN-wrong
    // one and its waiver already names the field SENSOR_MAP uses. Any other
    // disagreement means the two tables drifted with nobody deciding.
    const waiver = waived.get(cap)
    if (
      waiver !== undefined &&
      waiver.mappedField === ha.field &&
      waiver.schemaField === sensor.field
    ) {
      continue
    }
    out.push({
      kind: 'table-field-disagreement',
      subject: cap,
      message: `CAP_ENTITY_MAP says '${ha.field}' and SENSOR_MAP says '${sensor.field}' for '${cap}'`,
      fix: `resolve both against the cap status schema and make them agree; the plan defers a SHARED table to a train, so this guard is what keeps them aligned`,
    })
  }
}

function checkHapGenericTable(input: ExportCoverageInput, out: Violation[]): void {
  const ref = input.expectations.hapGenericTable
  if (ref === null) {
    if (input.hapGenericAccessoryExists) {
      out.push({
        kind: 'hap-generic-table-unwired',
        subject: HAP_GENERIC_ACCESSORY,
        message: `the HomeKit generic (non-camera) mapper exists but this guard does not read its capability table`,
        fix: `set "hapGenericTable": { "file": "…", "exportName": "…" } in ${EXPECTATIONS} so the same coverage question is asked of HomeKit`,
      })
    }
    return
  }
  if (!input.hapGenericTableRefExists) {
    out.push({
      kind: 'stale-hap-generic-table',
      subject: ref.file,
      message: `expectations point at '${ref.file}', which does not exist`,
      fix: `update or null out "hapGenericTable" in ${EXPECTATIONS}`,
    })
    return
  }
  const defined = new Set(input.deviceCaps.map((c) => c.name))
  for (const cap of input.hapGenericTableCaps ?? []) {
    if (defined.has(cap)) continue
    out.push({
      kind: 'hap-cap-without-definition',
      subject: cap,
      message: `${ref.exportName} maps '${cap}', which is not a device-scoped capability`,
      fix: `remove the row in ${ref.file}`,
    })
  }
}

/**
 * A per-item capability mints its entities from an ARRAY on its slice. The
 * array's field is checked against the status schema like any descriptor
 * field, the capability must exist, and it cannot also be excluded — two
 * answers to one question is the failure this guard exists for.
 */
function checkItemCaps(input: ExportCoverageInput, out: Violation[]): void {
  const schema = fieldsOf(input.deviceCaps)
  const excluded = new Set(input.capsNotExported)
  for (const [cap, mapping] of Object.entries(input.itemEntityMap)) {
    if (!schema.has(cap)) {
      out.push({
        kind: 'item-cap-without-definition',
        subject: cap,
        message: `ITEM_ENTITY_MAP mints '${cap}', which is not a device-scoped capability`,
        fix: `remove the mapping in ${ITEM_ENTITIES}`,
      })
      continue
    }
    const fields = schema.get(cap) ?? null
    if (fields !== null && !fields.includes(mapping.itemsField)) {
      out.push({
        kind: 'item-field-not-in-status-schema',
        subject: cap,
        message: `ITEM_ENTITY_MAP['${cap}'].itemsField is '${mapping.itemsField}', absent from the cap status schema [${fields.join(', ')}]`,
        fix: `name the array field the cap's status schema carries, in ${ITEM_ENTITIES}`,
      })
    }
    if (excluded.has(cap)) {
      out.push({
        kind: 'item-cap-also-excluded',
        subject: cap,
        message: `'${cap}' is minted per item AND listed in CAPS_NOT_EXPORTED`,
        fix: `drop it from CAPS_NOT_EXPORTED in ${ENTITY_CATALOG}`,
      })
    }
  }
}

/** Every rule, in one pass. Pure — the loader below is what touches disk. */
export function findExportCoverageViolations(input: ExportCoverageInput): readonly Violation[] {
  const out: Violation[] = []
  checkCoverage(input, out)
  checkMappedCapsExist(input, out)
  checkFields(input, out)
  checkTablesAgree(input, out)
  checkHapGenericTable(input, out)
  checkItemCaps(input, out)
  return out
}

// ── Loading the real tables ─────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Zod object shapes are read through a getter; anything else has no shape. */
function shapeKeys(schema: unknown): readonly string[] | null {
  if (!isRecord(schema)) return null
  const shape = schema.shape
  if (!isRecord(shape)) return null
  const keys = Object.keys(shape)
  return keys.length > 0 ? keys : null
}

/**
 * Read every device-scoped capability that declares `deviceTypes`, with the
 * fields of its status (or runtime-state) schema. Reads the DEFINITIONS, not
 * the source text — a cap file's prose and ordering are free to change.
 */
export function readDeviceCaps(module: Record<string, unknown>): readonly CapFacts[] {
  const caps: CapFacts[] = []
  for (const value of Object.values(module)) {
    if (!isRecord(value)) continue
    const { name, scope, deviceTypes } = value
    if (typeof name !== 'string' || scope !== 'device') continue
    if (!Array.isArray(deviceTypes) || deviceTypes.length === 0) continue
    const status = isRecord(value.status) ? value.status.schema : undefined
    caps.push({
      name,
      statusFields: shapeKeys(status) ?? shapeKeys(value.runtimeState),
    })
  }
  return caps.sort((a, b) => a.name.localeCompare(b.name))
}

/** Read a `Record<capName, { field }>` table without pinning its other keys. */
export function readFieldTable(
  value: unknown,
  where: string,
): Readonly<Record<string, FieldMapping>> {
  if (!isRecord(value)) throw new Error(`${where} is not an object — has the export been renamed?`)
  const table: Record<string, FieldMapping> = {}
  for (const [cap, mapping] of Object.entries(value)) {
    if (!isRecord(mapping) || typeof mapping.field !== 'string') {
      throw new Error(`${where}['${cap}'] has no string 'field' — the descriptor shape changed`)
    }
    const extras: Record<string, string> = {}
    if (isRecord(mapping.extras)) {
      for (const [suffix, extra] of Object.entries(mapping.extras)) {
        if (!isRecord(extra) || typeof extra.field !== 'string') {
          throw new Error(
            `${where}['${cap}'].extras['${suffix}'] has no string 'field' — the descriptor shape changed`,
          )
        }
        extras[suffix] = extra.field
      }
    }
    table[cap] = { field: mapping.field, extras }
  }
  return table
}

/** Read `ITEM_ENTITY_MAP` — `Record<capName, { itemsField }>`, other keys unpinned. */
export function readItemTable(
  value: unknown,
  where: string,
): Readonly<Record<string, ItemMapping>> {
  if (!isRecord(value)) throw new Error(`${where} is not an object — has the export been renamed?`)
  const table: Record<string, ItemMapping> = {}
  for (const [cap, mapping] of Object.entries(value)) {
    if (!isRecord(mapping) || typeof mapping.itemsField !== 'string') {
      throw new Error(`${where}['${cap}'] has no string 'itemsField' — the mapping shape changed`)
    }
    table[cap] = { itemsField: mapping.itemsField }
  }
  return table
}

/** Read `CAPS_NOT_EXPORTED` — an array of `{ cap, reason }`. */
export function readExcludedCaps(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${where} is not an array`)
  const caps: string[] = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.cap !== 'string') {
      throw new Error(`${where} carries an entry with no string 'cap'`)
    }
    caps.push(entry.cap)
  }
  return caps
}

/**
 * Read the cap names a target's capability table covers, from either shape a
 * table can honestly take: a `Record<capName, descriptor>` (what
 * `CAP_ENTITY_MAP` is) or an array of rows naming their caps (what
 * `HAP_CAP_SERVICES` is — one row can serve two caps, e.g. `switch` +
 * `brightness`). Refuses anything it cannot read rather than returning an
 * empty list: a silent zero here would pass the whole HomeKit half.
 */
export function readCapNames(value: unknown, where: string): readonly string[] {
  if (Array.isArray(value)) {
    const names: string[] = []
    for (const row of value) {
      if (!isRecord(row)) throw new Error(`${where} carries a row that is not an object`)
      const { caps, cap } = row
      if (typeof cap === 'string') names.push(cap)
      else if (Array.isArray(caps) && caps.every((c) => typeof c === 'string')) names.push(...caps)
      else throw new Error(`${where} carries a row with neither a 'cap' string nor a 'caps' array`)
    }
    if (names.length === 0) throw new Error(`${where} named no capabilities at all`)
    return [...new Set(names)]
  }
  if (!isRecord(value)) throw new Error(`${where} is neither a record nor an array`)
  const keys = Object.keys(value)
  if (keys.length === 0) throw new Error(`${where} named no capabilities at all`)
  return keys
}

async function loadInput(): Promise<ExportCoverageInput> {
  const caps: unknown = await import(path.join(ROOT, CAPS_INDEX))
  const catalog: unknown = await import(path.join(ROOT, ENTITY_CATALOG))
  const items: unknown = await import(path.join(ROOT, ITEM_ENTITIES))
  const control: unknown = await import(path.join(ROOT, CONTROL_RESOLUTION))
  if (!isRecord(caps) || !isRecord(catalog) || !isRecord(control) || !isRecord(items)) {
    throw new Error('a source module did not load as a module')
  }

  const expectations = parseExpectations(
    JSON.parse(fs.readFileSync(path.join(ROOT, EXPECTATIONS), 'utf-8')),
  )

  const ref = expectations.hapGenericTable
  const hapGenericTableRefExists = ref !== null && fs.existsSync(path.join(ROOT, ref.file))
  let hapGenericTableCaps: readonly string[] | null = null
  if (ref !== null && hapGenericTableRefExists) {
    const hap: unknown = await import(path.join(ROOT, ref.file))
    if (!isRecord(hap)) throw new Error(`${ref.file} did not load as a module`)
    hapGenericTableCaps = readCapNames(hap[ref.exportName], `${ref.file} → ${ref.exportName}`)
  }

  return {
    deviceCaps: readDeviceCaps(caps),
    capEntityMap: readFieldTable(catalog.CAP_ENTITY_MAP, 'CAP_ENTITY_MAP'),
    capsNotExported: readExcludedCaps(catalog.CAPS_NOT_EXPORTED, 'CAPS_NOT_EXPORTED'),
    itemEntityMap: readItemTable(items.ITEM_ENTITY_MAP, 'ITEM_ENTITY_MAP'),
    sensorMap: readFieldTable(control.SENSOR_MAP, 'SENSOR_MAP'),
    hapGenericAccessoryExists: fs.existsSync(path.join(ROOT, HAP_GENERIC_ACCESSORY)),
    hapGenericTableRefExists,
    hapGenericTableCaps,
    expectations,
  }
}

async function main(): Promise<void> {
  const violations = findExportCoverageViolations(await loadInput())
  if (violations.length === 0) {
    // eslint-disable-next-line no-console
    console.log('  \x1b[32m✔\x1b[0m export coverage: every device capability is decided')
    return
  }
  // eslint-disable-next-line no-console
  console.error(`\n\x1b[31m✘ ${violations.length} export-coverage violation(s)\x1b[0m:`)
  for (const v of violations) {
    // eslint-disable-next-line no-console
    console.error(`    [${v.kind}] ${v.message}`)
    // eslint-disable-next-line no-console
    console.error(`      → ${v.fix}`)
  }
  // eslint-disable-next-line no-console
  console.error(
    '\n  Why this matters: an undecided capability becomes an entity that is published and\n' +
      '  never carries a value — 177 of them, once. The expectations file is a ratchet; it\n' +
      '  only shrinks.\n',
  )
  process.exit(1)
}

// Only run when invoked directly — the pure helpers above are imported by tests.
if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`\x1b[31m✘ export-coverage guard could not run\x1b[0m: ${String(err)}`)
    process.exit(1)
  })
}
