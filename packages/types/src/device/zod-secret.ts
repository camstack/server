/**
 * Secret declaration on a Zod config schema (D783).
 *
 * A field is a secret because its schema SAYS so — `.meta({ secret: true })`,
 * spelled {@link SECRET_META} — never because its key looks like a credential.
 * It is the Zod twin of `secret: true` / `type: 'password'` on a config-UI
 * field (`isSecretConfigField`), and every consumer that treats secrets
 * specially reads it: the settings form (`zodEntriesToConfigUI`), the paths a
 * device advertises at `registerDevice` (`secretConfigPaths`, which the
 * non-admin redaction withholds at any depth), and the keychain later.
 *
 * Zod keeps `.meta()` in `z.globalRegistry`, which lives on `globalThis`, so a
 * declaration made by an addon's own copy of zod is visible here.
 */
import { z } from 'zod'

/**
 * `{ secret: true }` — the one spelling of "this field holds a credential".
 *
 * Addons write the LITERAL `.meta({ secret: true })` rather than importing
 * this constant: an addon running against an older `@camstack/types` would
 * otherwise call `.meta(undefined)`, which in zod v4 is the metadata GETTER
 * and returns no schema at all.
 */
export const SECRET_META = { secret: true } as const

interface ZodInternalDef {
  readonly type?: string
  readonly innerType?: z.ZodType
  readonly in?: z.ZodType
  readonly out?: z.ZodType
  readonly shape?: Record<string, z.ZodType>
  readonly element?: z.ZodType
  readonly options?: readonly z.ZodType[]
  readonly left?: z.ZodType
  readonly right?: z.ZodType
}

function defOf(schema: z.ZodType): ZodInternalDef {
  const zodBag: unknown = Reflect.get(schema, '_zod')
  if (typeof zodBag !== 'object' || zodBag === null) return {}
  const def: unknown = Reflect.get(zodBag, 'def')
  if (typeof def !== 'object' || def === null) return {}
  return def as ZodInternalDef
}

function declaredHere(schema: z.ZodType): boolean {
  const meta = z.globalRegistry.get(schema) as { secret?: unknown } | undefined
  return meta?.secret === true
}

/** Wrapper kinds whose `innerType` is the field itself. */
const WRAPPERS: ReadonlySet<string> = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'catch',
  'readonly',
  'nonoptional',
])

/**
 * The schema layers that make up ONE field: the schema itself and every
 * wrapper below it (optional / default / nullable / readonly / catch), plus
 * both sides of a pipe (`z.preprocess` puts the real schema on `out`,
 * `.transform` on `in`).
 */
function layersOf(schema: z.ZodType): readonly z.ZodType[] {
  const out: z.ZodType[] = []
  const queue: z.ZodType[] = [schema]
  while (queue.length > 0) {
    const s = queue.shift()
    if (!s || out.includes(s)) continue
    out.push(s)
    const def = defOf(s)
    if (def.type !== undefined && WRAPPERS.has(def.type) && def.innerType) queue.push(def.innerType)
    if (def.type === 'pipe') {
      if (def.in) queue.push(def.in)
      if (def.out) queue.push(def.out)
    }
  }
  return out
}

/** True when any layer of this field declares `.meta({ secret: true })`. */
export function isZodSecret(schema: z.ZodType): boolean {
  return layersOf(schema).some(declaredHere)
}

/**
 * Every declared secret path in a config schema: dotted keys, `[]` for "each
 * element of this array" (`connection.password`, `rows[].token`). A declared
 * object or array is reported as one path and not descended into — everything
 * under it is secret.
 */
export function collectZodSecretPaths(schema: z.ZodType, prefix = ''): readonly string[] {
  if (isZodSecret(schema)) return prefix.length > 0 ? [prefix] : []
  const paths: string[] = []
  for (const layer of layersOf(schema)) {
    const def = defOf(layer)
    if (def.type === 'object' && def.shape) {
      for (const [key, child] of Object.entries(def.shape)) {
        paths.push(...collectZodSecretPaths(child, prefix ? `${prefix}.${key}` : key))
      }
    } else if (def.type === 'array' && def.element) {
      paths.push(...collectZodSecretPaths(def.element, `${prefix}[]`))
    } else if (def.type === 'union' && def.options) {
      // A (discriminated) union's variants share the path: a secret in ANY
      // variant is a secret at that path (ecowitt's local vs listener transport).
      for (const option of def.options) paths.push(...collectZodSecretPaths(option, prefix))
    } else if (def.type === 'intersection') {
      if (def.left) paths.push(...collectZodSecretPaths(def.left, prefix))
      if (def.right) paths.push(...collectZodSecretPaths(def.right, prefix))
    }
  }
  return [...new Set(paths)]
}
