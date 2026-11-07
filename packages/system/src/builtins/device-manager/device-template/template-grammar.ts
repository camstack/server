/**
 * What a device value template may contain, decided from the parsed tree.
 *
 * nunjucks does not sandbox: `{{ range.constructor("return process")() }}`
 * runs. So the template is refused unless EVERY node is on a whitelist — no
 * calls, no include/import/extends, no macros, no dynamic member lookups, no
 * `constructor`-style member names, no filter outside the allow-list. The
 * worker re-runs this over what it receives (defence in depth).
 *
 * Type-only imports from `@camstack/types`: this module is loaded by the
 * render worker, which must not load the types barrel (D453).
 */
import type { DeviceTemplateRefusal, DeviceTemplateRef } from '@camstack/types'
import { parseTemplateSource, type TemplateNode } from './nunjucks-internals.js'

/** Node kinds a template may contain. Anything else is `forbidden-syntax`. */
const ALLOWED_NODES: ReadonlySet<string> = new Set([
  'Root',
  'NodeList',
  'Output',
  'TemplateData',
  'Literal',
  'Symbol',
  'Group',
  'Array',
  'Dict',
  'Pair',
  'If',
  'InlineIf',
  'For',
  'Set',
  'LookupVal',
  'Add',
  'Concat',
  'Sub',
  'Mul',
  'Div',
  'FloorDiv',
  'Mod',
  'Pow',
  'Neg',
  'Pos',
  'And',
  'Or',
  'Not',
  'Compare',
  'CompareOperand',
  'In',
  'Is',
  'Filter',
  'KeywordArgs',
])

/** Member names that reach a constructor, a prototype or a stack frame. Refused wherever they appear. */
const FORBIDDEN_MEMBERS: ReadonlySet<string> = new Set([
  'constructor',
  '__proto__',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'caller',
  'callee',
  'arguments',
])

/** A `unit(…)` call: where its name token sits and the reference it converts, when it is a direct one. */
export interface UnitSite {
  readonly lineno: number
  readonly colno: number
  readonly ref: DeviceTemplateRef | undefined
}

export type TemplateAnalysis =
  | {
      readonly ok: true
      readonly refs: readonly DeviceTemplateRef[]
      readonly unitSites: readonly UnitSite[]
    }
  | { readonly ok: false; readonly refusal: DeviceTemplateRefusal }

class Refused extends Error {
  constructor(readonly refusal: DeviceTemplateRefusal) {
    super(refusal.message)
  }
}

function refuse(reason: DeviceTemplateRefusal['reason'], message: string): never {
  throw new Refused({ reason, message })
}

function at(node: TemplateNode): string {
  return `line ${node.lineno + 1}, column ${node.colno + 1}`
}

function memberName(key: TemplateNode, node: TemplateNode): string | number {
  if (key.typename !== 'Literal') {
    return refuse('forbidden-syntax', `dynamic member lookup is not allowed (${at(node)})`)
  }
  const value = key.value
  if (typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value)))
    return value
  return refuse('forbidden-syntax', `member lookup must be a name or an integer (${at(node)})`)
}

/** The `alias.a.b[0]` chain a LookupVal tops, as `[rootSymbol, path]`, or undefined when it is not rooted at a symbol. */
function chainOf(
  node: TemplateNode,
): { readonly root: string; readonly path: (string | number)[] } | undefined {
  const path: (string | number)[] = []
  let cursor: TemplateNode | undefined = node
  while (cursor !== undefined && cursor.typename === 'LookupVal') {
    const key = cursor.field('val')
    if (key === undefined) return undefined
    path.unshift(memberName(key, cursor))
    cursor = cursor.field('target')
  }
  if (cursor === undefined || cursor.typename !== 'Symbol' || typeof cursor.value !== 'string')
    return undefined
  return { root: cursor.value, path }
}

interface WalkState {
  readonly allowedFilters: ReadonlySet<string>
  readonly locals: Set<string>
  readonly refs: DeviceTemplateRef[]
  readonly unitSites: UnitSite[]
}

function collectLocals(node: TemplateNode, locals: Set<string>): void {
  if (node.typename === 'For') {
    locals.add('loop')
    for (const name of node.all('name')) addNames(name, locals)
  }
  if (node.typename === 'Set') {
    for (const target of node.all('targets')) addNames(target, locals)
  }
  for (const child of node.children) collectLocals(child, locals)
}

function addNames(node: TemplateNode, locals: Set<string>): void {
  if (node.typename === 'Symbol' && typeof node.value === 'string') locals.add(node.value)
  for (const child of node.children) addNames(child, locals)
}

function recordRef(
  chain: { root: string; path: (string | number)[] },
  state: WalkState,
): DeviceTemplateRef | undefined {
  if (state.locals.has(chain.root)) return undefined
  const ref: DeviceTemplateRef = { alias: chain.root, path: chain.path }
  state.refs.push(ref)
  return ref
}

function walk(node: TemplateNode, state: WalkState): void {
  if (!ALLOWED_NODES.has(node.typename)) {
    refuse('forbidden-syntax', `${node.typename} is not allowed in a device template (${at(node)})`)
  }
  if (
    node.typename === 'Literal' &&
    typeof node.value === 'string' &&
    FORBIDDEN_MEMBERS.has(node.value)
  ) {
    refuse('forbidden-member', `"${node.value}" is not allowed in a device template (${at(node)})`)
  }
  if (
    node.typename === 'Symbol' &&
    typeof node.value === 'string' &&
    FORBIDDEN_MEMBERS.has(node.value)
  ) {
    refuse('forbidden-member', `"${node.value}" is not allowed in a device template (${at(node)})`)
  }
  if (node.typename === 'LookupVal') {
    const chain = chainOf(node)
    if (chain === undefined) {
      refuse('forbidden-syntax', `a member lookup must start at a device alias (${at(node)})`)
    }
    for (const part of chain.path) {
      if (typeof part === 'string' && FORBIDDEN_MEMBERS.has(part)) {
        refuse('forbidden-member', `"${part}" is not allowed in a device template (${at(node)})`)
      }
    }
    recordRef(chain, state)
    return
  }
  if (node.typename === 'Symbol' && typeof node.value === 'string') {
    if (!state.locals.has(node.value)) state.refs.push({ alias: node.value, path: [] })
    return
  }
  if (node.typename === 'Filter') {
    walkFilter(node, state)
    return
  }
  if (node.typename === 'Is') {
    // The right side names a test (`defined`), it is not a reference.
    const left = node.field('left')
    if (left !== undefined) walk(left, state)
    return
  }
  if (node.typename === 'Pair') {
    // A keyword-argument name is not a reference either.
    const [key, value] = node.children
    if (key !== undefined && key.typename !== 'Symbol') walk(key, state)
    if (value !== undefined) walk(value, state)
    return
  }
  for (const child of node.children) walk(child, state)
}

function walkFilter(node: TemplateNode, state: WalkState): void {
  const name = node.field('name')
  const filterName = name !== undefined && typeof name.value === 'string' ? name.value : undefined
  if (filterName === undefined || !state.allowedFilters.has(filterName)) {
    refuse(
      'unknown-filter',
      `filter "${filterName ?? '?'}" is not available in a device template (${at(node)})`,
    )
  }
  const args = node.field('args')
  const params = args?.children ?? []
  if (filterName === 'unit') {
    if (params.length < 2)
      refuse('syntax', `unit() needs the target unit, e.g. unit('°F') (${at(node)})`)
    const input = params[0]
    const chain = input !== undefined && input.typename === 'LookupVal' ? chainOf(input) : undefined
    const ref =
      chain !== undefined && !state.locals.has(chain.root)
        ? { alias: chain.root, path: chain.path }
        : undefined
    state.unitSites.push({ lineno: node.lineno, colno: node.colno, ref })
  }
  for (const param of params) walk(param, state)
}

/** Parse and vet a template. A template that passes may be handed to the worker. */
export function analyzeTemplate(
  source: string,
  allowedFilters: readonly string[],
  maxLength: number,
): TemplateAnalysis {
  if (source.length > maxLength) {
    return {
      ok: false,
      refusal: { reason: 'too-long', message: `template is longer than ${maxLength} characters` },
    }
  }
  const parsed = parseTemplateSource(source)
  if (!parsed.ok) return { ok: false, refusal: { reason: 'syntax', message: parsed.message } }
  const locals = new Set<string>()
  collectLocals(parsed.root, locals)
  const state: WalkState = {
    allowedFilters: new Set(allowedFilters),
    locals,
    refs: [],
    unitSites: [],
  }
  try {
    walk(parsed.root, state)
  } catch (err) {
    if (err instanceof Refused) return { ok: false, refusal: err.refusal }
    throw err
  }
  return { ok: true, refs: dedupeRefs(state.refs), unitSites: state.unitSites }
}

function dedupeRefs(refs: readonly DeviceTemplateRef[]): readonly DeviceTemplateRef[] {
  const seen = new Set<string>()
  const out: DeviceTemplateRef[] = []
  for (const ref of refs) {
    const key = JSON.stringify([ref.alias, ref.path])
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}
