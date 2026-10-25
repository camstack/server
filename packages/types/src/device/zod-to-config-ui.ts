import { z } from 'zod'
import type {
  ConfigUISchema,
  ConfigField,
  ConfigTextField,
  ConfigNumberField,
  ConfigBooleanField,
  ConfigSelectField,
  ConfigPasswordField,
  ConfigTextAreaField,
} from '../interfaces/config-ui.js'
import { collectZodSecretPaths, isZodSecret } from './zod-secret.js'

// --- Entry type matching DeviceConfig.entries() output ---

export interface DeviceConfigEntry {
  key: string
  schema: z.ZodType
  value: unknown
  description?: string
}

// --- Internal Zod v4 _def shapes (accessed at runtime, not exposed in typings) ---

interface ZodV4CheckDef {
  check: string
  value?: number
  inclusive?: boolean
}

interface ZodV4Check {
  _zod: { def: ZodV4CheckDef }
}

interface ZodV4NumberDef {
  type: string
  checks?: ZodV4Check[]
}

interface ZodV4DefaultDef {
  type: string
  defaultValue: unknown
  innerType: z.ZodType
}

/** Access Zod v4 internal .def — not in public typings but stable at runtime */
function zodDef<T>(schema: z.ZodType): T {
  return Reflect.get(schema, 'def') as T
}

/** Access internal properties on a Zod schema instance */
function zodInternals<T>(schema: z.ZodType): T {
  return schema as T
}

// --- Public API ---

/**
 * Convert DeviceConfig.entries() output to ConfigUISchema for the admin UI FormBuilder.
 *
 * Each entry's Zod type is inspected to determine the correct ConfigField type:
 * - ZodString → 'text' (or 'password' when key contains "password"/"secret"/"token"/"apikey")
 * - ZodNumber → 'number' (extracts min/max/step from Zod v4 checks)
 * - ZodBoolean → 'boolean'
 * - ZodEnum → 'select' (options built from enum values)
 * - Anything else → 'text' fallback
 *
 * Wrapper types ZodDefault, ZodOptional, and ZodNullable are unwrapped transparently.
 * Default values are extracted from ZodDefault wrappers.
 */
export function zodEntriesToConfigUI(
  entries: readonly DeviceConfigEntry[],
  sectionTitle = 'Configuration',
  sectionId = 'main',
): ConfigUISchema {
  const fields: ConfigField[] = entries.map((entry) =>
    zodToConfigField(entry.key, entry.schema, entry.description),
  )

  return {
    sections: [
      {
        id: sectionId,
        title: sectionTitle,
        fields,
      },
    ],
  }
}

// --- Internal helpers ---

function zodToConfigField(key: string, schema: z.ZodType, description?: string): ConfigField {
  const inner = unwrapZod(schema)
  const defaultValue = getZodDefault(schema)
  const label = description ?? humanizeKey(key)

  const base = {
    key,
    label,
    description,
    default: defaultValue,
  } as const

  // D783 — a field DECLARED secret (`.meta({ secret: true })`) is a password
  // field whatever it is called. The key-name rule in `buildStringField` is
  // the legacy backstop for drivers that have not declared yet.
  if (inner instanceof z.ZodString && isZodSecret(schema)) {
    const field: ConfigPasswordField = { ...base, type: 'password', showToggle: true }
    return field
  }

  if (inner instanceof z.ZodString) {
    return buildStringField(key, base)
  }

  if (inner instanceof z.ZodNumber) {
    return buildNumberField(inner, base)
  }

  if (inner instanceof z.ZodBoolean) {
    const field: ConfigBooleanField = { ...base, type: 'boolean' }
    return field
  }

  if (inner instanceof z.ZodEnum) {
    return buildEnumField(inner, base)
  }

  // Arrays + objects don't fit any primitive field — render as a JSON
  // textarea so the operator at least sees the shape and can copy/edit
  // it, instead of `[object Object],…` produced by the text fallback.
  // `isJson: true` tells the UI + hydrator to round-trip via JSON.
  if (inner instanceof z.ZodArray || inner instanceof z.ZodObject) {
    // A JSON blob holding a declared secret anywhere inside is secret as a
    // whole — the form cannot withhold one key of a textarea (D783).
    const holdsSecret = isZodSecret(schema) || collectZodSecretPaths(schema).length > 0
    const field: ConfigTextAreaField = {
      ...base,
      type: 'textarea',
      rows: 6,
      isJson: true,
      ...(holdsSecret ? { secret: true } : {}),
    }
    return field
  }

  // Fallback — render as plain text
  const fallback: ConfigTextField = { ...base, type: 'text' }
  return fallback
}

function buildStringField(
  key: string,
  base: { key: string; label: string; description?: string; default?: unknown },
): ConfigTextField | ConfigPasswordField {
  const lowerKey = key.toLowerCase()
  const isSecret =
    lowerKey.includes('password') ||
    lowerKey.includes('secret') ||
    lowerKey.includes('token') ||
    lowerKey.includes('apikey') ||
    lowerKey.includes('api_key')

  if (isSecret) {
    const field: ConfigPasswordField = { ...base, type: 'password', showToggle: true }
    return field
  }

  const field: ConfigTextField = { ...base, type: 'text' }
  return field
}

function buildNumberField(
  inner: z.ZodNumber,
  base: { key: string; label: string; description?: string; default?: unknown },
): ConfigNumberField {
  // Zod v4 exposes min/max via public getters minValue/maxValue.
  // When unconstrained, these return -Infinity / Infinity — treat those as absent.
  const anyInner = zodInternals<{ minValue?: number | null; maxValue?: number | null }>(inner)
  const rawMin = anyInner.minValue
  const rawMax = anyInner.maxValue
  const min = rawMin != null && isFinite(rawMin) ? rawMin : undefined
  const max = rawMax != null && isFinite(rawMax) ? rawMax : undefined

  // Step is stored in checks with check name 'multiple_of'
  const step = getMultipleOfStep(inner)

  const field: ConfigNumberField = {
    ...base,
    type: 'number',
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(step !== undefined ? { step } : {}),
  }
  return field
}

function getMultipleOfStep(inner: z.ZodNumber): number | undefined {
  const def = zodDef<ZodV4NumberDef>(inner)
  const checks = def.checks ?? []
  for (const check of checks) {
    if (check._zod?.def?.check === 'multiple_of' && check._zod.def.value !== undefined) {
      return check._zod.def.value
    }
  }
  return undefined
}

// Zod v4: ZodEnum<T> where T extends Readonly<Record<string, string | number>>
// options returns Array<T[keyof T]> which is (string | number)[]
function buildEnumField(
  inner: z.ZodEnum,
  base: { key: string; label: string; description?: string; default?: unknown },
): ConfigSelectField {
  const values = (inner.options as (string | number)[]).map((v) => String(v))

  const field: ConfigSelectField = {
    ...base,
    type: 'select',
    options: values.map((v) => ({ label: humanizeKey(v), value: v })),
  }
  return field
}

function unwrapZod(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodDefault) return unwrapZod(zodDef<ZodV4DefaultDef>(schema).innerType)
  if (schema instanceof z.ZodOptional)
    return unwrapZod(zodDef<{ innerType: z.ZodType }>(schema).innerType)
  if (schema instanceof z.ZodNullable)
    return unwrapZod(zodDef<{ innerType: z.ZodType }>(schema).innerType)
  return schema
}

function getZodDefault(schema: z.ZodType): unknown {
  if (schema instanceof z.ZodDefault) {
    // Zod v4: def.defaultValue is the literal value (not a function at runtime)
    return zodDef<ZodV4DefaultDef>(schema).defaultValue
  }
  return undefined
}

function humanizeKey(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim()
}
