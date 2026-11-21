/**
 * `/* @__PURE__ *\/` on every top-level INITIALIZER call of a module (D1074).
 *
 * `@camstack/types` is inlined into each addon bundle (D15). Its modules are full of
 * `const X = z.object(...)`, `const M = method(...)`, `const T = Object.freeze({...})`
 * and `.extend(...)` chains. A bundler cannot prove a call pure, so it keeps every
 * initializer whose binding nobody reads and the addon evaluates thousands of schemas
 * it never uses (+35 to +60 MB of heap per runner). Marking the call lets the consumer
 * drop an initializer whose binding is unused.
 *
 * What is marked: a call or `new` at the top level of a `const/let/var` initializer
 * (`const X = call(...)`, `export const X = call(...)`), including calls nested in its
 * arguments, the outermost call of a member chain (`a.b().c()`), never inside a function.
 *
 * What is NEVER marked: a bare expression statement. `macro(...)` / `sub(...)` at the top
 * level populate the event taxonomy; marking one makes it removable and the types package
 * stops loading (`EVENT_KIND_BY_CAP … unknown taxonomy kind`). Neither is an IIFE
 * (`(() => { … })()`): its body is arbitrary code.
 */

import { parseAst } from 'vite'
import type { Plugin } from 'vite'

const PURE = '/* @__PURE__ */ '

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

const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassBody',
])

/** Offsets at which {@link PURE} goes, in ascending order. */
function pureOffsets(code: string): number[] {
  const offsets = new Set<number>()
  const visit = (node: AstNode, parent: AstNode | null): void => {
    if (FUNCTION_TYPES.has(node.type)) return
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const callee = (node as { callee?: unknown }).callee
      const innerOfChain =
        parent !== null &&
        parent.type === 'MemberExpression' &&
        (parent as { object?: unknown }).object === node
      const calleeType = isAstNode(callee) ? callee.type : ''
      const iife = calleeType === 'FunctionExpression' || calleeType === 'ArrowFunctionExpression'
      if (!innerOfChain && !iife && calleeType !== 'Super' && calleeType !== 'Import') {
        offsets.add(node.start)
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const v of value) if (isAstNode(v)) visit(v, node)
      } else if (isAstNode(value)) {
        visit(value, node)
      }
    }
  }
  for (const statement of parseAst(code).body) {
    if (!isAstNode(statement)) continue
    const declaration =
      statement.type === 'ExportNamedDeclaration'
        ? (statement as { declaration?: unknown }).declaration
        : statement
    if (!isAstNode(declaration) || declaration.type !== 'VariableDeclaration') continue
    for (const d of (declaration as { declarations: { init?: unknown }[] }).declarations) {
      if (isAstNode(d.init)) visit(d.init, null)
    }
  }
  return [...offsets].toSorted((a, b) => a - b)
}

/** `code` with {@link PURE} before every top-level initializer call. */
export function markPureInitializers(code: string): { code: string; count: number } {
  const offsets = pureOffsets(code)
  let out = ''
  let last = 0
  for (const at of offsets) {
    out += code.slice(last, at) + PURE
    last = at
  }
  return { code: out + code.slice(last), count: offsets.length }
}

/** Vite plugin: annotate the transformed (TypeScript already stripped) modules under `srcDir`. */
export function pureInitializers(srcDir: string): Plugin {
  return {
    name: 'camstack:pure-initializers',
    enforce: 'post',
    transform(code, id) {
      if (!id.startsWith(srcDir) || !(id.split('?')[0] ?? id).endsWith('.ts')) return null
      if (id.includes('/__tests__/')) return null
      const marked = markPureInitializers(code)
      return marked.count === 0 ? null : { code: marked.code, map: null }
    },
  }
}
