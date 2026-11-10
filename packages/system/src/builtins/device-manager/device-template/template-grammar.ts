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
import type { DeviceTemplateRef, DeviceTemplateRefusal } from '@camstack/types'
import { parseTemplateSource, type TemplateNode } from './nunjucks-internals.js'

/**
 * Per node kind: the declared fields the walker FOLLOWS (`walk`) and the ones
 * that carry plain data (`data`) or are checked by the kind's own rule
 * (`special`). A kind not listed here is refused; a node carrying a field this
 * table does not name is refused (a child the walker never visits is a child
 * that executes unvetted). `template-grammar.spec.ts` compares this table with
 * nunjucks' own node classes, so a field added upstream fails the spec.
 */
export interface NodePolicy {
  readonly walk: readonly string[]
  readonly data: readonly string[]
  readonly special: readonly string[]
}

const LIST: NodePolicy = { walk: ['children'], data: [], special: [] }
const BINARY: NodePolicy = { walk: ['left', 'right'], data: [], special: [] }
const UNARY: NodePolicy = { walk: ['target'], data: [], special: [] }
const LEAF: NodePolicy = { walk: [], data: ['value'], special: [] }
const CONDITIONAL: NodePolicy = { walk: ['cond', 'body', 'else_'], data: [], special: [] }

export const NODE_POLICY: Readonly<Record<string, NodePolicy>> = {
  Root: LIST,
  NodeList: LIST,
  Output: LIST,
  Group: LIST,
  Array: LIST,
  Dict: LIST,
  KeywordArgs: LIST,
  TemplateData: LEAF,
  Literal: LEAF,
  Symbol: LEAF,
  Pair: { walk: ['key', 'value'], data: [], special: [] },
  If: CONDITIONAL,
  InlineIf: CONDITIONAL,
  For: { walk: ['arr', 'name', 'body', 'else_'], data: [], special: [] },
  Set: { walk: ['targets', 'value'], data: [], special: [] },
  LookupVal: { walk: [], data: [], special: ['target', 'val'] },
  Add: BINARY,
  Concat: BINARY,
  Sub: BINARY,
  Mul: BINARY,
  Div: BINARY,
  FloorDiv: BINARY,
  Mod: BINARY,
  Pow: BINARY,
  And: BINARY,
  Or: BINARY,
  In: BINARY,
  Neg: UNARY,
  Pos: UNARY,
  Not: UNARY,
  Compare: { walk: ['expr', 'ops'], data: [], special: [] },
  CompareOperand: { walk: ['expr'], data: ['type'], special: [] },
  Is: { walk: ['left'], data: [], special: ['right'] },
  Filter: { walk: [], data: [], special: ['name', 'args'] },
  FunCall: { walk: [], data: [], special: ['name', 'args'] },
}

/** Tests an `is` may name. Pure predicates; none takes a callable. */
const ALLOWED_TESTS: ReadonlySet<string> = new Set([
  'defined',
  'undefined',
  'null',
  'none',
  'number',
  'string',
  'odd',
  'even',
  'truthy',
  'falsy',
  'divisibleby',
  'equalto',
  'eq',
  'ne',
  'lt',
  'le',
  'gt',
  'ge',
  'sameas',
  'lower',
  'upper',
  'iterable',
  'mapping',
])

/** The one global a template may call. */
const CALLABLE_GLOBAL = 'range'

/**
 * Most parameters a filter takes after its input. The attribute-taking forms
 * (`join(',', attr)`, `sort(false, false, attr)`, `sum(attr)`) sit past these
 * limits, and a keyword named `attribute` is refused wherever it appears.
 */
const FILTER_MAX_PARAMS: Readonly<Record<string, number>> = {
  unit: 2,
  round: 1,
  trunc: 1,
  onoff: 0,
  default: 2,
  d: 2,
  since: 0,
  ago: 0,
  format: 1,
  upper: 0,
  lower: 0,
  title: 0,
  capitalize: 0,
  trim: 0,
  abs: 0,
  int: 1,
  float: 1,
  length: 0,
  join: 1,
  replace: 3,
  first: 0,
  last: 0,
  sort: 2,
  reverse: 0,
  sum: 0,
  string: 0,
  list: 0,
  truncate: 3,
  time: 1,
}

const FORBIDDEN_KEYWORDS: ReadonlySet<string> = new Set(['attribute', 'attr'])

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

function forbiddenName(name: string, node: TemplateNode): never {
  return refuse('forbidden-member', `"${name}" is not allowed in a device template (${at(node)})`)
}

function checkPolicy(node: TemplateNode): NodePolicy {
  const policy = NODE_POLICY[node.typename]
  if (policy === undefined) {
    return refuse(
      'forbidden-syntax',
      `${node.typename} is not allowed in a device template (${at(node)})`,
    )
  }
  if (node.unlisted.length > 0) {
    return refuse(
      'forbidden-syntax',
      `${node.typename} carries ${node.unlisted.join(', ')}, which a device template may not use (${at(node)})`,
    )
  }
  const known = new Set([...policy.walk, ...policy.data, ...policy.special])
  for (const field of node.fieldNames) {
    if (!known.has(field)) {
      refuse(
        'forbidden-syntax',
        `${node.typename}.${field} is not allowed in a device template (${at(node)})`,
      )
    }
  }
  return policy
}

function walk(node: TemplateNode, state: WalkState): void {
  const policy = checkPolicy(node)
  if (
    node.typename === 'Literal' &&
    typeof node.value === 'string' &&
    FORBIDDEN_MEMBERS.has(node.value)
  ) {
    forbiddenName(node.value, node)
  }
  if (node.typename === 'Symbol' && typeof node.value === 'string') {
    if (FORBIDDEN_MEMBERS.has(node.value)) forbiddenName(node.value, node)
    if (!state.locals.has(node.value)) state.refs.push({ alias: node.value, path: [] })
    return
  }
  switch (node.typename) {
    case 'LookupVal':
      walkLookup(node, state)
      return
    case 'Filter':
      walkFilter(node, state)
      return
    case 'FunCall':
      walkCall(node, state)
      return
    case 'Is':
      walkIs(node, state)
      return
    case 'Pair':
      walkPair(node, state)
      return
    default:
  }
  for (const field of policy.walk) for (const child of node.all(field)) walk(child, state)
}

function walkLookup(node: TemplateNode, state: WalkState): void {
  const chain = chainOf(node)
  if (chain === undefined) {
    refuse('forbidden-syntax', `a member lookup must start at a device alias (${at(node)})`)
  }
  for (const part of chain.path) {
    if (typeof part === 'string' && FORBIDDEN_MEMBERS.has(part)) forbiddenName(part, node)
  }
  if (FORBIDDEN_MEMBERS.has(chain.root)) forbiddenName(chain.root, node)
  recordRef(chain, state)
}

/** A keyword-argument name is not a reference; a dict key written as a bare word is one. */
function walkPair(node: TemplateNode, state: WalkState): void {
  const key = node.field('key')
  const value = node.field('value')
  const isKeyword = key?.typename === 'Symbol' && keywordPairs.has(node)
  if (isKeyword && typeof key?.value === 'string' && FORBIDDEN_KEYWORDS.has(key.value)) {
    refuse(
      'forbidden-syntax',
      `the keyword "${key.value}" is not allowed in a device template (${at(node)})`,
    )
  }
  if (key !== undefined && !isKeyword) walk(key, state)
  if (value !== undefined) walk(value, state)
}

const keywordPairs = new WeakSet<TemplateNode>()

function markKeywordPairs(args: TemplateNode | undefined): void {
  if (args === undefined) return
  for (const child of args.children) {
    if (child.typename === 'KeywordArgs') for (const pair of child.children) keywordPairs.add(pair)
  }
}

/** `x is test` / `x is test(arg)`: the test must be on the list, its arguments are vetted expressions. */
function walkIs(node: TemplateNode, state: WalkState): void {
  const left = node.field('left')
  if (left !== undefined) walk(left, state)
  const right = node.field('right')
  if (right === undefined) return
  if (right.typename === 'Literal' && (right.value === null || typeof right.value === 'boolean'))
    return
  if (right.typename === 'Symbol') {
    testName(right, node)
    return
  }
  if (right.typename === 'FunCall') {
    const name = right.field('name')
    if (name === undefined || name.typename !== 'Symbol')
      refuse('forbidden-syntax', `a test must be named (${at(node)})`)
    testName(name, node)
    markKeywordPairs(right.field('args'))
    for (const arg of right.field('args')?.children ?? []) walk(arg, state)
    return
  }
  refuse('forbidden-syntax', `a test must be a name (${at(node)})`)
}

function testName(symbol: TemplateNode, node: TemplateNode): void {
  const name = typeof symbol.value === 'string' ? symbol.value : ''
  if (!ALLOWED_TESTS.has(name))
    refuse(
      'forbidden-syntax',
      `the test "${name}" is not available in a device template (${at(node)})`,
    )
}

/** The only call a template may make is the capped `range(n)`. */
function walkCall(node: TemplateNode, state: WalkState): void {
  const name = node.field('name')
  const callee =
    name !== undefined && name.typename === 'Symbol' && typeof name.value === 'string'
      ? name.value
      : undefined
  if (callee !== CALLABLE_GLOBAL || state.locals.has(callee)) {
    refuse(
      'forbidden-syntax',
      `calling ${callee ?? 'an expression'} is not allowed in a device template (${at(node)})`,
    )
  }
  const args = node.field('args')?.children ?? []
  if (args.length < 1 || args.length > 3 || args.some((arg) => arg.typename === 'KeywordArgs')) {
    refuse('syntax', `range() takes one to three numbers (${at(node)})`)
  }
  for (const arg of args) walk(arg, state)
}

function walkFilter(node: TemplateNode, state: WalkState): void {
  const name = node.field('name')
  const filterName = name !== undefined && typeof name.value === 'string' ? name.value : undefined
  if (
    filterName === undefined ||
    !state.allowedFilters.has(filterName) ||
    FILTER_MAX_PARAMS[filterName] === undefined
  ) {
    refuse(
      'unknown-filter',
      `filter "${filterName ?? '?'}" is not available in a device template (${at(node)})`,
    )
  }
  const args = node.field('args')
  markKeywordPairs(args)
  const params = args?.children ?? []
  const positional = params.filter((param) => param.typename !== 'KeywordArgs')
  const keywords = params
    .filter((param) => param.typename === 'KeywordArgs')
    .flatMap((k) => k.children)
  const max = FILTER_MAX_PARAMS[filterName] ?? 0
  if (positional.length - 1 + keywords.length > max) {
    refuse('syntax', `filter "${filterName}" takes at most ${max} argument(s) (${at(node)})`)
  }
  if (filterName === 'unit') {
    if (positional.length < 2)
      refuse('syntax', `unit() needs the target unit, e.g. unit('°F') (${at(node)})`)
    const input = positional[0]
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
