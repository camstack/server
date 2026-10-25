import { parseXml, walkXml, type XmlElement } from './home-connect-xml.js'

/** Where an IDDF entity sits: which list of the description declares it. */
export type HomeConnectEntityKind =
  | 'status'
  | 'setting'
  | 'option'
  | 'command'
  | 'event'
  | 'program'
  | 'activeProgram'
  | 'selectedProgram'

export type HomeConnectAccess = 'none' | 'read' | 'readWrite' | 'writeOnly' | 'readStatic'

/** How a value is carried. `unknown` until the IDDF or the first value says. */
export type HomeConnectValueType = 'boolean' | 'number' | 'enum' | 'string' | 'unknown'

/** One feature entity from the IDDF / compact JSON description. */
export interface HomeConnectEntityDef {
  readonly uid: number
  readonly name: string
  readonly kind?: HomeConnectEntityKind
  readonly access?: HomeConnectAccess
  /** Declared availability; `undefined` when the description does not say. */
  readonly available?: boolean
  readonly enumeration?: Readonly<Record<number, string>>
  readonly valueType?: HomeConnectValueType
  /** Unit the description declares for this entity; `undefined` when it declares none. */
  readonly unit?: string
  readonly min?: number
  readonly max?: number
  readonly stepSize?: number
  readonly defaultValue?: unknown
  /** Event entities only: `acknowledge` / `none` and the severity level. */
  readonly handling?: string
  readonly level?: string
  readonly refCid?: string
  readonly refDid?: string
}

/** One option a program lists, with the program-level overrides of the entity's own constraints. */
export interface HomeConnectProgramOption {
  readonly key: string
  readonly access?: HomeConnectAccess
  readonly available?: boolean
  readonly defaultValue?: unknown
}

export interface HomeConnectProgramDef {
  /** Last segment of the feature name (`Eco50`). */
  readonly name: string
  /** Full feature name (`Dishcare.Dishwasher.Program.Eco50`). */
  readonly uid: string
  readonly available: boolean
  readonly options?: readonly HomeConnectProgramOption[]
}

export interface HomeConnectCompactDescription {
  /** `2` = carries kinds, constraints and program options. Absent = the pre-IDDF-model shape. */
  readonly version?: 2
  readonly info: {
    readonly deviceID: string
    readonly deviceType: string
    readonly model: string
    readonly brand?: string
  }
  readonly program: readonly HomeConnectProgramDef[]
  readonly entities: Readonly<Record<string, HomeConnectEntityDef>>
}

export const HOME_CONNECT_DESCRIPTION_VERSION = 2

function isDescriptionRoot(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseHexUid(raw: string): number {
  return Number.parseInt(raw, 16)
}

interface FeatureMapping {
  readonly features: ReadonlyMap<number, string>
  readonly enumerations: ReadonlyMap<number, Readonly<Record<number, string>>>
}

function parseFeatureMappingXml(xml: string): FeatureMapping {
  const features = new Map<number, string>()
  const enumerations = new Map<number, Record<number, string>>()
  const root = parseXml(xml)
  if (root === null) return { features, enumerations }
  walkXml(root, (el) => {
    if (el.name === 'feature') {
      const uidHex = el.attrs['refUID']
      const name = el.text.trim()
      if (uidHex && name) features.set(parseHexUid(uidHex), name)
      return
    }
    if (el.name === 'enumDescription') {
      const enidHex = el.attrs['refENID']
      if (!enidHex) return
      const members: Record<number, string> = {}
      for (const child of el.children) {
        if (child.name !== 'enumMember') continue
        const value = child.attrs['refValue']
        const label = child.text.trim()
        if (value !== undefined && label) members[Number.parseInt(value, 10)] = label
      }
      enumerations.set(parseHexUid(enidHex), members)
    }
  })
  return { features, enumerations }
}

const ENTITY_KIND_BY_TAG: Readonly<Record<string, HomeConnectEntityKind>> = {
  status: 'status',
  setting: 'setting',
  option: 'option',
  command: 'command',
  event: 'event',
  program: 'program',
  activeProgram: 'activeProgram',
  selectedProgram: 'selectedProgram',
}

const ACCESS_VALUES: readonly HomeConnectAccess[] = [
  'none',
  'read',
  'readWrite',
  'writeOnly',
  'readStatic',
]

function accessFrom(raw: string | undefined): HomeConnectAccess | undefined {
  return ACCESS_VALUES.find((a) => a === raw)
}

function boolAttr(raw: string | undefined): boolean | undefined {
  if (raw === 'true') return true
  if (raw === 'false') return false
  return undefined
}

function numberAttr(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/** A `default="…"` attribute: a number, a boolean, or the text as written. */
function defaultAttr(raw: string | undefined): unknown {
  if (raw === undefined) return undefined
  if (raw === 'true') return true
  if (raw === 'false') return false
  const n = numberAttr(raw)
  return n !== undefined ? n : raw
}

function featureName(features: ReadonlyMap<number, string>, uid: number, hexUid: string): string {
  const mapped = features.get(uid)
  if (mapped === undefined) return `Unmapped.${hexUid.toUpperCase()}`
  return mapped.includes('.') ? mapped : `BSH.Common.${mapped}`
}

function entityFromElement(
  el: XmlElement,
  kind: HomeConnectEntityKind,
  mapping: FeatureMapping,
): HomeConnectEntityDef | null {
  const uidRaw = el.attrs['uid']
  if (!uidRaw) return null
  const uid = parseHexUid(uidRaw)
  if (Number.isNaN(uid)) return null
  const enType = el.attrs['enumerationType']
  const enumeration = enType ? { ...mapping.enumerations.get(parseHexUid(enType)) } : undefined
  const min = numberAttr(el.attrs['min'])
  const max = numberAttr(el.attrs['max'])
  const stepSize = numberAttr(el.attrs['stepSize'])
  const valueType: HomeConnectValueType =
    enumeration !== undefined
      ? 'enum'
      : min !== undefined || max !== undefined || stepSize !== undefined
        ? 'number'
        : 'unknown'
  const unit = el.attrs['unit']
  const defaultValue = defaultAttr(el.attrs['default'])
  const handling = el.attrs['handling']
  const level = el.attrs['level']
  const refCid = el.attrs['refCID']
  const refDid = el.attrs['refDID']
  const access = accessFrom(el.attrs['access'])
  const available = boolAttr(el.attrs['available'])
  return {
    uid,
    name: featureName(mapping.features, uid, uidRaw),
    kind,
    ...(access !== undefined ? { access } : {}),
    ...(available !== undefined ? { available } : {}),
    ...(enumeration !== undefined ? { enumeration } : {}),
    valueType,
    ...(unit !== undefined && unit.length > 0 ? { unit } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(stepSize !== undefined ? { stepSize } : {}),
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    ...(handling !== undefined ? { handling } : {}),
    ...(level !== undefined ? { level } : {}),
    ...(refCid !== undefined ? { refCid } : {}),
    ...(refDid !== undefined ? { refDid } : {}),
  }
}

function infoFromDeviceXml(
  root: XmlElement,
  deviceIdFallback: string,
): HomeConnectCompactDescription['info'] {
  const text = (name: string): string | undefined => {
    let found: string | undefined
    walkXml(root, (el) => {
      if (found === undefined && el.name === name) {
        const t = el.text.trim()
        if (t.length > 0) found = t
      }
    })
    return found
  }
  const brand = text('brand')
  return {
    deviceID: deviceIdFallback,
    deviceType: text('type') ?? 'Appliance',
    model: text('model') ?? deviceIdFallback,
    ...(brand !== undefined ? { brand } : {}),
  }
}

function programOptionsOf(
  program: XmlElement,
  byUid: ReadonlyMap<number, HomeConnectEntityDef>,
): readonly HomeConnectProgramOption[] {
  const options: HomeConnectProgramOption[] = []
  for (const child of program.children) {
    if (child.name !== 'option') continue
    const ref = child.attrs['refUID']
    if (!ref) continue
    const def = byUid.get(parseHexUid(ref))
    if (def === undefined) continue
    const access = accessFrom(child.attrs['access'])
    const available = boolAttr(child.attrs['available'])
    const defaultValue = defaultAttr(child.attrs['default'])
    options.push({
      key: def.name,
      ...(access !== undefined ? { access } : {}),
      ...(available !== undefined ? { available } : {}),
      ...(defaultValue !== undefined ? { defaultValue } : {}),
    })
  }
  return options
}

/** Parse an IDDF XML pair into the compact JSON stored on the appliance connection. */
export function parseHomeConnectIddfXml(input: {
  readonly deviceDescriptionXml: string
  readonly featureMappingXml: string
  readonly haId: string
}): HomeConnectCompactDescription {
  const mapping = parseFeatureMappingXml(input.featureMappingXml)
  const root = parseXml(input.deviceDescriptionXml)
  const entities: Record<string, HomeConnectEntityDef> = {}
  const byUid = new Map<number, HomeConnectEntityDef>()
  const programElements: XmlElement[] = []
  if (root !== null) {
    walkXml(root, (el) => {
      const kind = ENTITY_KIND_BY_TAG[el.name]
      if (kind === undefined) return
      const def = entityFromElement(el, kind, mapping)
      if (def === null) return
      entities[String(def.uid)] = def
      byUid.set(def.uid, def)
      if (kind === 'program') programElements.push(el)
    })
  }
  const program: HomeConnectProgramDef[] = []
  for (const el of programElements) {
    const def = byUid.get(parseHexUid(el.attrs['uid'] ?? ''))
    if (def === undefined) continue
    const options = programOptionsOf(el, byUid)
    program.push({
      name: def.name.split('.').pop() ?? def.name,
      uid: def.name,
      available: def.available !== false,
      ...(options.length > 0 ? { options } : {}),
    })
  }
  return {
    version: HOME_CONNECT_DESCRIPTION_VERSION,
    info:
      root !== null
        ? infoFromDeviceXml(root, input.haId)
        : { deviceID: input.haId, deviceType: 'Appliance', model: input.haId },
    program,
    entities,
  }
}

function enumerationFrom(raw: unknown): Record<number, string> | undefined {
  if (!isDescriptionRoot(raw)) return undefined
  const out: Record<number, string> = {}
  for (const [ek, ev] of Object.entries(raw)) {
    if (typeof ev === 'string') out[Number.parseInt(ek, 10)] = ev
  }
  return out
}

function stringIn<T extends string>(raw: unknown, allowed: readonly T[]): T | undefined {
  return allowed.find((a) => a === raw)
}

const ENTITY_KINDS: readonly HomeConnectEntityKind[] = [
  'status',
  'setting',
  'option',
  'command',
  'event',
  'program',
  'activeProgram',
  'selectedProgram',
]
const VALUE_TYPES: readonly HomeConnectValueType[] = [
  'boolean',
  'number',
  'enum',
  'string',
  'unknown',
]

function finiteNumber(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
}

function entityFromJson(key: string, val: Record<string, unknown>): HomeConnectEntityDef | null {
  const name = val['name']
  const uid = Number.parseInt(key, 10)
  if (typeof name !== 'string' || Number.isNaN(uid)) return null
  const enumeration = enumerationFrom(val['enumeration'])
  const kind = stringIn(val['kind'], ENTITY_KINDS)
  const access = stringIn(val['access'], ACCESS_VALUES)
  const valueType = stringIn(val['valueType'], VALUE_TYPES)
  const available = typeof val['available'] === 'boolean' ? val['available'] : undefined
  const unit = typeof val['unit'] === 'string' && val['unit'].length > 0 ? val['unit'] : undefined
  const min = finiteNumber(val['min'])
  const max = finiteNumber(val['max'])
  const stepSize = finiteNumber(val['stepSize'])
  const handling = typeof val['handling'] === 'string' ? val['handling'] : undefined
  const level = typeof val['level'] === 'string' ? val['level'] : undefined
  const refCid = typeof val['refCid'] === 'string' ? val['refCid'] : undefined
  const refDid = typeof val['refDid'] === 'string' ? val['refDid'] : undefined
  const defaultValue = val['defaultValue']
  return {
    uid,
    name,
    ...(kind !== undefined ? { kind } : {}),
    ...(access !== undefined ? { access } : {}),
    ...(available !== undefined ? { available } : {}),
    ...(enumeration !== undefined ? { enumeration } : {}),
    ...(valueType !== undefined ? { valueType } : {}),
    ...(unit !== undefined ? { unit } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(stepSize !== undefined ? { stepSize } : {}),
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    ...(handling !== undefined ? { handling } : {}),
    ...(level !== undefined ? { level } : {}),
    ...(refCid !== undefined ? { refCid } : {}),
    ...(refDid !== undefined ? { refDid } : {}),
  }
}

function rootFromInput(
  input: string | Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (input === undefined || input === null) return null
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input.trim())
      return isDescriptionRoot(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return isDescriptionRoot(input) ? input : null
}

export function entityIndexFromDescription(
  input: string | Record<string, unknown> | null | undefined,
): ReadonlyMap<number, HomeConnectEntityDef> {
  const index = new Map<number, HomeConnectEntityDef>()
  const root = rootFromInput(input)
  if (root === null) return index
  const entities = root['entities']
  if (!isDescriptionRoot(entities)) return index
  for (const [key, val] of Object.entries(entities)) {
    if (!isDescriptionRoot(val)) continue
    const def = entityFromJson(key, val)
    if (def !== null) index.set(def.uid, def)
  }
  return index
}

/** The programs a stored description lists (empty for the pre-model shape). */
export function programsFromDescription(
  input: string | Record<string, unknown> | null | undefined,
): readonly HomeConnectProgramDef[] {
  const root = rootFromInput(input)
  const raw = root?.['program']
  if (!Array.isArray(raw)) return []
  const out: HomeConnectProgramDef[] = []
  for (const row of raw) {
    if (!isDescriptionRoot(row)) continue
    const uid = row['uid']
    const name = row['name']
    if (typeof uid !== 'string' || typeof name !== 'string') continue
    const optionsRaw = row['options']
    const options: HomeConnectProgramOption[] = []
    if (Array.isArray(optionsRaw)) {
      for (const o of optionsRaw) {
        if (!isDescriptionRoot(o) || typeof o['key'] !== 'string') continue
        const access = stringIn(o['access'], ACCESS_VALUES)
        options.push({
          key: o['key'],
          ...(access !== undefined ? { access } : {}),
          ...(typeof o['available'] === 'boolean' ? { available: o['available'] } : {}),
          ...(o['defaultValue'] !== undefined ? { defaultValue: o['defaultValue'] } : {}),
        })
      }
    }
    out.push({
      name,
      uid,
      available: row['available'] !== false,
      ...(options.length > 0 ? { options } : {}),
    })
  }
  return out
}

/** True when the stored description carries the model this addon reads (kinds + constraints). */
export function isCurrentDescription(
  input: string | Record<string, unknown> | null | undefined,
): boolean {
  const root = rootFromInput(input)
  return (
    root?.['version'] === HOME_CONNECT_DESCRIPTION_VERSION &&
    entityIndexFromDescription(root).size > 0
  )
}

export function decodeHomeConnectValue(
  uid: number,
  value: unknown,
  index: ReadonlyMap<number, HomeConnectEntityDef>,
): { readonly key: string; readonly value: unknown } | null {
  const entity = index.get(uid)
  if (!entity) return null
  if (
    entity.enumeration &&
    (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)))
  ) {
    const num = typeof value === 'number' ? value : Number.parseInt(value, 10)
    const label = entity.enumeration[num]
    return { key: entity.name, value: label ?? value }
  }
  return { key: entity.name, value }
}

export function encodeHomeConnectValue(
  featureName: string,
  value: unknown,
  index: ReadonlyMap<number, HomeConnectEntityDef>,
): { readonly uid: number; readonly value: unknown } | null {
  for (const entity of index.values()) {
    if (entity.name !== featureName) continue
    if (entity.enumeration && typeof value === 'string') {
      for (const [num, label] of Object.entries(entity.enumeration)) {
        if (label === value) return { uid: entity.uid, value: Number.parseInt(num, 10) }
      }
    }
    return { uid: entity.uid, value }
  }
  return null
}
