/**
 * Types-reachability guard on the BUILT addon dists (D1074, amends D28).
 *
 * An addon bundle inlines `@dominevo/types` (D15). The bundler keeps a top-level
 * initializer (`const X = z.object(...)`) it cannot prove pure, so a types
 * statement nobody references stays in the dist and is evaluated when the addon
 * loads: ~68 % of the types statements in a provider's dist were dead weight, +35
 * to +60 MB of heap per runner. The footprint budget catches that only after the
 * damage is large; this guard names the cause.
 *
 * What it measures, per built addon closure file: parse the file, split it into
 * top-level statements, attribute each to the `//#region` it sits in, and build the
 * reference graph between statements. A statement inside a `packages/types`
 * region that no addon code reaches is dead code the bundler kept. The sum of their sizes over the
 * closure must stay under {@link MAX_UNREACHABLE_TYPES_KB}.
 *
 * Library only: `check-addon-dist-footprint.ts` runs it for the addons it measures
 * (`npx tsx scripts/check-addon-dist-footprint.ts [--addons a,b]`), so verify:push and
 * CI call it through the footprint stage they already run.
 */

import * as fs from 'node:fs'
import { parseAst } from 'vite'

/** Dead types code one addon closure may carry. Measured 3 to 32 KB in the addons that use the types package; before D1074 it was 1,500+ KB. */
export const MAX_UNREACHABLE_TYPES_KB = 40

interface AstNode {
  readonly type: string
  readonly start: number
  readonly end: number
}

function isAstNode(v: unknown): v is AstNode {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { type?: unknown }).type === 'string' &&
    typeof (v as { start?: unknown }).start === 'number'
  )
}

type Visit = (node: AstNode, parent: AstNode | null) => void

function walk(node: AstNode, parent: AstNode | null, visit: Visit): void {
  visit(node, parent)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const v of value) if (isAstNode(v)) walk(v, node, visit)
    } else if (isAstNode(value)) {
      walk(value, node, visit)
    }
  }
}

/** A `//#region` banner path that belongs to the `@dominevo/types` package. */
export function isTypesRegion(region: string): boolean {
  return /(^|\/)packages\/types\/(dist|src)\//.test(region) || region.startsWith('../types/')
}

interface Stmt {
  readonly head: string
  readonly names: readonly string[]
  readonly refs: ReadonlySet<string>
  readonly size: number
  readonly inTypes: boolean
  /** An export list (`export { a, b }`, or `exports.a = a` in CommonJS): another file or the host uses what it names. */
  readonly exports: boolean
}

function declaredNames(node: AstNode): string[] {
  const out: string[] = []
  const bind = (pattern: unknown): void => {
    if (!isAstNode(pattern)) return
    walk(pattern, null, (n, parent) => {
      if (n.type !== 'Identifier') return
      const isKey =
        parent !== null &&
        parent.type === 'Property' &&
        (parent as { key?: unknown }).key === n &&
        (parent as { shorthand?: unknown }).shorthand !== true
      if (!isKey) out.push((n as unknown as { name: string }).name)
    })
  }
  const decl =
    node.type === 'ExportNamedDeclaration' ? (node as { declaration?: unknown }).declaration : node
  if (!isAstNode(decl)) return out
  if (decl.type === 'VariableDeclaration') {
    for (const d of (decl as { declarations: { id: unknown }[] }).declarations) bind(d.id)
  } else if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
    bind((decl as { id?: unknown }).id)
  }
  return out
}

/**
 * Bytes of `@dominevo/types` statements in `code` that no addon code reaches.
 *
 * The roots are the statements outside a types region plus export lists. A bare
 * types statement (`Object.freeze({...})`, `macro(...)`) is NOT a root: when the
 * bundler cannot prove an initializer pure it drops the binding of an unused
 * `const X = Object.freeze(...)` and keeps the call as a bare statement, which is
 * exactly the dead weight to find. The few bare statements that must run (the
 * event taxonomy) keep their own dependencies, a small residue the threshold covers.
 */
export function unreachableTypesBytes(code: string): {
  typesBytes: number
  deadBytes: number
  dead: readonly { head: string; size: number }[]
} {
  const regions: { at: number; types: boolean }[] = []
  for (const m of code.matchAll(/^\/\/#region (.*)$/gm)) {
    regions.push({ at: m.index ?? 0, types: isTypesRegion(m[1] ?? '') })
  }
  const inTypesAt = (pos: number): boolean => {
    let lo = 0
    let hi = regions.length - 1
    let found = false
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const r = regions[mid]
      if (r !== undefined && r.at <= pos) {
        found = r.types
        lo = mid + 1
      } else hi = mid - 1
    }
    return found
  }

  const stmts: Stmt[] = []
  for (const raw of parseAst(code).body) {
    if (!isAstNode(raw) || raw.type === 'EmptyStatement') continue
    const names = declaredNames(raw)
    const refs = new Set<string>()
    walk(raw, null, (n, parent) => {
      if (n.type !== 'Identifier') return
      const isMember =
        parent !== null &&
        parent.type === 'MemberExpression' &&
        (parent as { property?: unknown }).property === n &&
        (parent as { computed?: unknown }).computed !== true
      if (!isMember) refs.add((n as unknown as { name: string }).name)
    })
    stmts.push({
      head: code.slice(raw.start, raw.start + 80).replace(/\s+/g, ' '),
      names,
      refs,
      size: raw.end - raw.start,
      inTypes: inTypesAt(raw.start),
      exports:
        (raw.type === 'ExportNamedDeclaration' && names.length === 0) ||
        /^(module\.)?exports\b|^Object\.defineProperty\(exports\b/.test(
          code.slice(raw.start, raw.start + 60),
        ),
    })
  }

  const byName = new Map<string, Stmt>()
  for (const s of stmts) for (const n of s.names) byName.set(n, s)
  const live = new Set<Stmt>()
  const stack: Stmt[] = stmts.filter((s) => !s.inTypes || s.exports)
  while (stack.length > 0) {
    const s = stack.pop()
    if (s === undefined || live.has(s)) continue
    live.add(s)
    for (const r of s.refs) {
      const next = byName.get(r)
      if (next !== undefined && !live.has(next)) stack.push(next)
    }
  }
  let typesBytes = 0
  let deadBytes = 0
  const dead: { head: string; size: number }[] = []
  for (const s of stmts) {
    if (!s.inTypes) continue
    typesBytes += s.size
    if (!live.has(s)) {
      deadBytes += s.size
      dead.push({ head: s.head, size: s.size })
    }
  }
  return { typesBytes, deadBytes, dead: dead.toSorted((a, b) => b.size - a.size).slice(0, 5) }
}

export interface ReachabilityReport {
  readonly typesKb: number
  readonly deadKb: number
}

/** Sum {@link unreachableTypesBytes} over every file of an addon's dist closure. */
export function closureReachability(files: readonly string[]): ReachabilityReport {
  let typesBytes = 0
  let deadBytes = 0
  for (const f of files) {
    const r = unreachableTypesBytes(fs.readFileSync(f, 'utf-8'))
    typesBytes += r.typesBytes
    deadBytes += r.deadBytes
  }
  return { typesKb: typesBytes / 1024, deadKb: deadBytes / 1024 }
}
