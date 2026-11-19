/**
 * The API explorer's typed input form, pure half (planning#595): which control
 * each top-level field of a method's input JSON Schema gets, and the values the
 * form starts from. The schema is `apiCatalog.inputSchema` (the method's own Zod
 * parser as JSON Schema), so no extra catalogue data is needed.
 */
import {
  isRecord,
  type JsonSchema,
  requiredOf,
  resolveRef,
  schemaList,
  skeletonFromSchema,
  typesOf,
} from './api-explorer'

export type InputControl =
  | { readonly type: 'device' }
  | { readonly type: 'deviceList' }
  | { readonly type: 'select'; readonly options: readonly (string | number)[] }
  | {
      readonly type: 'number'
      readonly integer: boolean
      readonly min?: number
      readonly max?: number
    }
  | { readonly type: 'switch' }
  | { readonly type: 'text' }
  | { readonly type: 'json' }

export interface InputField {
  readonly key: string
  readonly required: boolean
  readonly control: InputControl
  /** The schema's own default; `undefined` when it has none. */
  readonly defaultValue: unknown
}

const DEVICE_ID_KEY = /(^d|D)eviceId$/
const DEVICE_IDS_KEY = /(^d|D)eviceIds$/

/** A nullable union `X | null` as `X`; a union of constants as one enum; anything else as is. */
function unwrap(raw: JsonSchema, root: JsonSchema): JsonSchema {
  const schema = resolveRef(raw, root)
  const union = [...schemaList(schema['anyOf']), ...schemaList(schema['oneOf'])].map((s) =>
    resolveRef(s, root),
  )
  if (union.length === 0) return schema
  const live = union.filter((s) => !(typesOf(s).length === 1 && typesOf(s)[0] === 'null'))
  if (live.length === 1 && live[0] !== undefined) return unwrap(live[0], root)
  const constants = live.flatMap((s) => ('const' in s ? [s['const']] : []))
  if (constants.length === live.length && live.length > 0) return { enum: constants }
  return schema
}

function scalarOptions(values: readonly unknown[]): readonly (string | number)[] | null {
  const options = values.filter(
    (v): v is string | number => typeof v === 'string' || typeof v === 'number',
  )
  return options.length === values.length && options.length > 0 ? options : null
}

function numberControl(schema: JsonSchema, integer: boolean): InputControl {
  const min = schema['minimum']
  const max = schema['maximum']
  return {
    type: 'number',
    integer,
    ...(typeof min === 'number' ? { min } : {}),
    ...(typeof max === 'number' ? { max } : {}),
  }
}

function controlOf(key: string, raw: JsonSchema, root: JsonSchema): InputControl {
  const schema = unwrap(raw, root)
  const types = typesOf(schema).filter((t) => t !== 'null')
  const type = types.length === 1 ? types[0] : undefined
  const options = Array.isArray(schema['enum']) ? scalarOptions(schema['enum']) : null
  if (options !== null) return { type: 'select', options }
  if ('const' in schema) {
    const single = scalarOptions([schema['const']])
    if (single !== null) return { type: 'select', options: single }
  }
  if ((type === 'integer' || type === 'number') && DEVICE_ID_KEY.test(key))
    return { type: 'device' }
  if (type === 'array' && DEVICE_IDS_KEY.test(key)) {
    const items = isRecord(schema['items']) ? unwrap(schema['items'], root) : null
    const itemType = items === null ? undefined : typesOf(items)[0]
    if (itemType === 'integer' || itemType === 'number') return { type: 'deviceList' }
  }
  if (type === 'integer' || type === 'number') return numberControl(schema, type === 'integer')
  if (type === 'boolean') return { type: 'switch' }
  if (type === 'string') return { type: 'text' }
  return { type: 'json' }
}

/**
 * The form fields of an input schema, or `null` when it is not an object with
 * named properties (then only the JSON editor applies).
 */
export function inputFieldsOf(schema: JsonSchema | null): readonly InputField[] | null {
  if (schema === null) return null
  const root = schema
  const top = unwrap(schema, root)
  const properties = top['properties']
  if (!isRecord(properties)) return null
  const required = requiredOf(top)
  const fields = Object.entries(properties).flatMap(([key, prop]): readonly InputField[] => {
    if (!isRecord(prop)) return []
    const resolved = resolveRef(prop, root)
    return [
      {
        key,
        required: required.includes(key),
        control: controlOf(key, prop, root),
        defaultValue: 'default' in resolved ? resolved['default'] : undefined,
      },
    ]
  })
  return fields.length > 0 ? fields : null
}

/**
 * What the form starts from: the skeleton of the required fields, plus the
 * schema's default of every optional field that has one.
 */
export function formSeed(schema: JsonSchema | null): unknown {
  const skeleton = skeletonFromSchema(schema)
  const fields = inputFieldsOf(schema)
  if (fields === null || !isRecord(skeleton)) return skeleton
  const defaults = Object.fromEntries(
    fields.flatMap((f) => (f.defaultValue === undefined ? [] : [[f.key, f.defaultValue]])),
  )
  return { ...defaults, ...skeleton }
}

/** `value` with `key` set to `next`, or without the key when `next` is `undefined`. */
export function withField(
  value: Readonly<Record<string, unknown>>,
  key: string,
  next: unknown,
): Record<string, unknown> {
  const { [key]: _removed, ...rest } = value
  return next === undefined ? rest : { ...rest, [key]: next }
}
