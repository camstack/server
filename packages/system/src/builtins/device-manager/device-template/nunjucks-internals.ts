/**
 * The only place that touches nunjucks (guard `check-device-template-grammar`).
 *
 * nunjucks' typings do not describe its parser, its node classes or its
 * runtime, and AGENTS.md forbids casts, so each untyped surface is read
 * through `Reflect.get` and a type guard here. Everything outside this file
 * sees `TemplateNode` and `createTemplateEnvironment`.
 */
import nunjucks from 'nunjucks'

/** One node of the parsed template, as the grammar walker sees it. */
export interface TemplateNode {
  readonly typename: string
  readonly lineno: number
  readonly colno: number
  /** The node's child nodes (field order), flattened; non-node fields excluded. */
  readonly children: readonly TemplateNode[]
  /** The node's own literal payload (`Symbol.value`, `Literal.value`, `Filter.name` is a child). */
  readonly value: unknown
  /** A named child node (`target`, `val`, `name`, `args`, `cond` …), when present and a node. */
  readonly field: (name: string) => TemplateNode | undefined
  /** Every child node of a named field (`Set.targets` holds several). */
  readonly all: (name: string) => readonly TemplateNode[]
  /** The node's declared fields (`fields` on the node class), in order. */
  readonly fieldNames: readonly string[]
  /**
   * Own properties that hold nodes but are NOT declared fields (`Set.body`).
   * The compiler visits them; a walker that follows `fieldNames` would not.
   */
  readonly unlisted: readonly string[]
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

function numberOf(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) if (typeof item === 'string') out.push(item)
  return out
}

function wrapNode(raw: object): TemplateNode | undefined {
  const typename = Reflect.get(raw, 'typename')
  if (typeof typename !== 'string') return undefined
  const fieldNames = stringArray(Reflect.get(raw, 'fields'))
  const named = new Map<string, TemplateNode[]>()
  const children: TemplateNode[] = []
  for (const name of fieldNames) {
    const entry: unknown = Reflect.get(raw, name)
    const items: readonly unknown[] = Array.isArray(entry) ? entry : [entry]
    for (const item of items) {
      if (!isObject(item)) continue
      const child = wrapNode(item)
      if (child === undefined) continue
      children.push(child)
      named.set(name, [...(named.get(name) ?? []), child])
    }
  }
  const unlisted: string[] = []
  for (const key of Object.keys(raw)) {
    if (fieldNames.includes(key) || key === 'lineno' || key === 'colno' || key === 'typename')
      continue
    const entry: unknown = Reflect.get(raw, key)
    const items: readonly unknown[] = Array.isArray(entry) ? entry : [entry]
    if (items.some((item) => isObject(item) && typeof Reflect.get(item, 'typename') === 'string'))
      unlisted.push(key)
  }
  return {
    typename,
    fieldNames,
    unlisted,
    lineno: numberOf(Reflect.get(raw, 'lineno')),
    colno: numberOf(Reflect.get(raw, 'colno')),
    children,
    value: Reflect.get(raw, 'value'),
    field: (name) => named.get(name)?.[0],
    all: (name) => named.get(name) ?? [],
  }
}

/** The declared fields of every nunjucks node class, by type name — what the grammar's field policy is checked against. */
export function nunjucksNodeFields(): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>()
  const nodes: unknown = Reflect.get(nunjucks, 'nodes')
  if (!isObject(nodes)) return out
  for (const name of Object.keys(nodes)) {
    const ctor: unknown = Reflect.get(nodes, name)
    const proto: unknown =
      isObject(ctor) || typeof ctor === 'function' ? Reflect.get(ctor, 'prototype') : undefined
    const fields: unknown = isObject(proto) ? Reflect.get(proto, 'fields') : undefined
    if (Array.isArray(fields)) out.set(name, stringArray(fields))
  }
  return out
}

export type ParseOutcome =
  | { readonly ok: true; readonly root: TemplateNode }
  | { readonly ok: false; readonly message: string }

/** Parse a template into an AST without compiling or loading anything. */
export function parseTemplateSource(source: string): ParseOutcome {
  const parser: unknown = Reflect.get(nunjucks, 'parser')
  const parse: unknown = isObject(parser) ? Reflect.get(parser, 'parse') : undefined
  if (typeof parse !== 'function') return { ok: false, message: 'template parser unavailable' }
  try {
    const raw: unknown = Reflect.apply(parse, parser, [source, [], {}])
    const root = isObject(raw) ? wrapNode(raw) : undefined
    if (root === undefined) return { ok: false, message: 'template parser returned no tree' }
    return { ok: true, root }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export interface TemplateEnvironmentOptions {
  /** Prints a value the way `{{ … }}` does (replaces nunjucks' `suppressValue`). */
  readonly print: (value: unknown) => string
  /** nunjucks' own filters to keep (the pure string/number ones); every other built-in is removed. */
  readonly keepBuiltinFilters: readonly string[]
  /** Globals a template may read or call (`range`); `range`/`cycler`/`joiner` are otherwise neutralised. */
  readonly globals: Readonly<Record<string, unknown>>
  /** `a + b` and `a ~ b` compile to calls of these (installed on the runtime) so an unavailable operand is decided in one place. */
  readonly add: (left: unknown, right: unknown) => unknown
  readonly concat: (left: unknown, right: unknown) => unknown
  readonly filters: Readonly<Record<string, (this: unknown, ...args: never[]) => unknown>>
}

export interface TemplateEnvironment {
  render(source: string, context: object): string
}

/**
 * A fresh environment: no loader (so include/import/extends cannot resolve),
 * autoescape off, `range`/`cycler`/`joiner` neutralised, only the filters
 * handed in. Printing goes through `print` so an unknown value reads `—`.
 */
export function createTemplateEnvironment(
  options: TemplateEnvironmentOptions,
): TemplateEnvironment {
  const runtime: unknown = Reflect.get(nunjucks, 'runtime')
  if (isObject(runtime)) {
    Reflect.set(runtime, 'suppressValue', (value: unknown) => options.print(value))
  }
  if (isObject(runtime)) {
    Reflect.set(runtime, 'addChecked', options.add)
    Reflect.set(runtime, 'concatChecked', options.concat)
  }
  patchCompiler()
  const env = new nunjucks.Environment(null, { autoescape: false, throwOnUndefined: false })
  for (const name of ['range', 'cycler', 'joiner'] as const) env.addGlobal(name, undefined)
  for (const [name, value] of Object.entries(options.globals)) env.addGlobal(name, value)
  const registered: unknown = Reflect.get(env, 'filters')
  if (isObject(registered)) {
    for (const name of Object.keys(registered)) {
      if (!options.keepBuiltinFilters.includes(name)) Reflect.deleteProperty(registered, name)
    }
  }
  for (const [name, fn] of Object.entries(options.filters)) env.addFilter(name, fn)
  return { render: (source, context) => env.renderString(source, context) }
}

/**
 * Make the compiler emit `runtime.addChecked(l, r)` / `runtime.concatChecked(l, r)`
 * for `+` / `~` instead of the bare JS operator, which prints `x undefined`.
 * The compiler's methods are called by name (`compile<Type>`), so replacing them
 * on the prototype takes effect for every template compiled in this thread.
 */
function patchCompiler(): void {
  const compilerModule: unknown = Reflect.get(nunjucks, 'compiler')
  const ctor: unknown = isObject(compilerModule)
    ? Reflect.get(compilerModule, 'Compiler')
    : undefined
  const proto: unknown = typeof ctor === 'function' ? Reflect.get(ctor, 'prototype') : undefined
  if (!isObject(proto)) throw new Error('nunjucks compiler unavailable')
  const emitCall = (runtimeFn: string) =>
    function (this: object, node: object, frame: unknown): void {
      const emit: unknown = Reflect.get(this, '_emit')
      const compile: unknown = Reflect.get(this, 'compile')
      if (typeof emit !== 'function' || typeof compile !== 'function')
        throw new Error('nunjucks compiler changed')
      Reflect.apply(emit, this, [`runtime.${runtimeFn}(`])
      Reflect.apply(compile, this, [Reflect.get(node, 'left'), frame])
      Reflect.apply(emit, this, [','])
      Reflect.apply(compile, this, [Reflect.get(node, 'right'), frame])
      Reflect.apply(emit, this, [')'])
    }
  Reflect.set(proto, 'compileAdd', emitCall('addChecked'))
  Reflect.set(proto, 'compileConcat', emitCall('concatChecked'))
}
