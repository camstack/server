/**
 * The pure half of `check-migration-api-append-only`: flatten each method's Zod pair to a
 * path table, and compare two tables under the append-only rule of the migration API
 * (planning#447). No IO here; the script reads and writes the files.
 */
import { z } from 'zod'

export interface FlatField {
  /** Required by its parent object. */
  readonly required: boolean
  /** The values an enum or a literal admits, merged over a union's branches; sorted. */
  readonly enum?: readonly string[]
}

/** `path -> field`. Object members join with `.`, array items with `[]`, record values with `{}`. */
export type FlatShape = Readonly<Record<string, FlatField>>

export interface ContractMethod {
  readonly input: FlatShape
  readonly output: FlatShape
  readonly behaviours: readonly string[]
}

export interface MigrationApiContract {
  readonly version: number
  readonly methods: Readonly<Record<string, ContractMethod>>
}

export interface ContractSource {
  readonly input: z.ZodType
  readonly output: z.ZodType
  readonly behaviours: readonly string[]
}

type Json = Record<string, unknown>

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function merge(into: Record<string, FlatField>, path: string, field: FlatField): void {
  const known = into[path]
  if (known === undefined) {
    into[path] = field
    return
  }
  const values = [...(known.enum ?? []), ...(field.enum ?? [])]
  into[path] = {
    required: known.required && field.required,
    ...(values.length > 0 ? { enum: [...new Set(values)].toSorted() } : {}),
  }
}

function walk(
  node: unknown,
  path: string,
  required: boolean,
  out: Record<string, FlatField>,
): void {
  if (!isJson(node)) return
  const values: string[] = []
  if (Array.isArray(node.enum)) values.push(...node.enum.map(String))
  if ('const' in node) values.push(String(node.const))
  if (path !== '') {
    merge(out, path, { required, ...(values.length > 0 ? { enum: values.toSorted() } : {}) })
  }
  const members = node.properties
  if (isJson(members)) {
    const must = new Set(Array.isArray(node.required) ? node.required.map(String) : [])
    for (const [name, child] of Object.entries(members)) {
      walk(child, path === '' ? name : `${path}.${name}`, must.has(name), out)
    }
  }
  if (isJson(node.additionalProperties)) {
    walk(node.additionalProperties, `${path}{}`, false, out)
  }
  if (node.items !== undefined) walk(node.items, `${path}[]`, false, out)
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[key]
    if (Array.isArray(branches)) for (const branch of branches) walk(branch, path, required, out)
  }
}

export function flattenSchema(schema: z.ZodType, io: 'input' | 'output'): FlatShape {
  const out: Record<string, FlatField> = {}
  walk(z.toJSONSchema(schema, { io, unrepresentable: 'any' }), '', true, out)
  return Object.fromEntries(Object.entries(out).toSorted(([a], [b]) => a.localeCompare(b)))
}

export function contractOf(
  version: number,
  methods: Readonly<Record<string, ContractSource>>,
): MigrationApiContract {
  return {
    version,
    methods: Object.fromEntries(
      Object.entries(methods)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([name, m]) => [
          name,
          {
            input: flattenSchema(m.input, 'input'),
            output: flattenSchema(m.output, 'output'),
            behaviours: [...m.behaviours].toSorted(),
          },
        ]),
    ),
  }
}

/** Required all the way up: a new field there breaks a caller that never sends it. */
function effectivelyRequired(shape: FlatShape, path: string): boolean {
  const field = shape[path]
  if (field === undefined || !field.required) return false
  const cut = Math.max(path.lastIndexOf('.'), path.lastIndexOf('['), path.lastIndexOf('{'))
  return cut <= 0 ? true : effectivelyRequired(shape, path.slice(0, cut))
}

function compareShape(
  method: string,
  side: 'input' | 'output',
  pinned: FlatShape,
  now: FlatShape,
  problems: string[],
): void {
  for (const [path, was] of Object.entries(pinned)) {
    const is = now[path]
    if (is === undefined) {
      problems.push(`${method}: ${side} field "${path}" was removed`)
      continue
    }
    if (side === 'input' && is.required && !was.required) {
      problems.push(`${method}: input field "${path}" turned required`)
    }
    const lost = (was.enum ?? []).filter((v) => !(is.enum ?? []).includes(v))
    if (lost.length > 0) {
      problems.push(`${method}: ${side} field "${path}" no longer admits ${lost.join(', ')}`)
    }
  }
  if (side === 'input') {
    for (const path of Object.keys(now)) {
      if (pinned[path] === undefined && effectivelyRequired(now, path)) {
        problems.push(`${method}: new input field "${path}" is required`)
      }
    }
  }
}

/** Every way `current` breaks `pinned`: the compatibility half, the one `--update` also obeys. */
export function contractCompatProblems(
  pinned: MigrationApiContract,
  current: MigrationApiContract,
): string[] {
  const problems: string[] = []
  if (current.version < pinned.version) {
    problems.push(`the contract version went down: ${pinned.version} -> ${current.version}`)
  }
  for (const [name, was] of Object.entries(pinned.methods)) {
    const is = current.methods[name]
    if (is === undefined) {
      problems.push(`${name}: the method is missing`)
      continue
    }
    compareShape(name, 'input', was.input, is.input, problems)
    compareShape(name, 'output', was.output, is.output, problems)
    for (const id of was.behaviours) {
      if (!is.behaviours.includes(id)) problems.push(`${name}: behaviour "${id}" was removed`)
    }
  }
  return problems
}

/** Every behaviour of `current` that has no `it('<id>'` in `specSource`. */
export function contractCoverageProblems(
  current: MigrationApiContract,
  specSource: string,
): string[] {
  const problems: string[] = []
  for (const [name, is] of Object.entries(current.methods)) {
    for (const id of is.behaviours) {
      if (!specSource.includes(`it('${id}'`)) {
        problems.push(`${name}: behaviour "${id}" has no it('${id}' in the contract spec`)
      }
    }
  }
  return problems
}
