#!/usr/bin/env tsx
/**
 * The browser entry of `@dominevo/types` reaches no Node built-in.
 *
 * `packages/types/src/index.ts` is what a browser bundle (the docs Storybook,
 * a widget build) loads from the PUBLISHED package. One `import { createHash }
 * from 'node:crypto'` anywhere in its relative import graph makes vite/rollup
 * fail with `"createHash" is not exported by "__vite-browser-external"`; the
 * admin-ui hides it by compiling the package from source through an alias.
 * Node-only helpers belong to the node entry (`src/node.ts`, exported as
 * `@dominevo/types/node`).
 *
 * The guard walks the relative imports and re-exports from `index.ts` and fails,
 * naming the chain, when a reached file imports a Node built-in (`node:*` or a
 * bare core module such as `fs`, `path`, `crypto`). Type-only imports are
 * erased by the compiler and do not count.
 */
import { existsSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'packages/types/src')
const ENTRY = path.join(SRC, 'index.ts')

const CORE = new Set(builtinModules)

interface QueueItem {
  readonly file: string
  readonly chain: readonly string[]
}

/** Every module specifier a file loads at runtime (type-only forms excluded). */
export function runtimeSpecifiers(source: string): readonly string[] {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      const bindings = clause?.namedBindings
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            bindings !== undefined &&
            ts.isNamedImports(bindings) &&
            bindings.elements.every((e) => e.isTypeOnly)))
      if (!typeOnly) found.push(node.moduleSpecifier.text)
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const named = node.exportClause
      const typeOnly =
        node.isTypeOnly ||
        (named !== undefined &&
          ts.isNamedExports(named) &&
          named.elements.every((e) => e.isTypeOnly))
      if (!typeOnly) found.push(node.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

export function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true
  return !specifier.startsWith('.') && CORE.has(specifier.split('/')[0] ?? specifier)
}

function resolveRelative(from: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(from), specifier)
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    `${base}.ts`,
    path.join(base, 'index.ts'),
  ]
  return candidates.find((c) => existsSync(c)) ?? null
}

/** Chains (entry -> ... -> file) for every Node built-in the entry reaches. */
export function findNodeImports(entry: string): readonly string[] {
  const violations: string[] = []
  const seen = new Set<string>([entry])
  const queue: QueueItem[] = [{ file: entry, chain: [path.relative(SRC, entry)] }]
  for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
    for (const spec of runtimeSpecifiers(readFileSync(item.file, 'utf8'))) {
      if (isNodeBuiltin(spec)) {
        violations.push(`${item.chain.join(' -> ')} imports '${spec}'`)
      } else if (spec.startsWith('.')) {
        const next = resolveRelative(item.file, spec)
        if (next !== null && !seen.has(next)) {
          seen.add(next)
          queue.push({ file: next, chain: [...item.chain, path.relative(SRC, next)] })
        }
      }
    }
  }
  return violations
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = findNodeImports(ENTRY)
  if (violations.length > 0) {
    console.error(
      'check-types-browser-entry-node-free: the @dominevo/types browser entry reaches Node built-ins:',
    )
    for (const v of violations) console.error(`  ${v}`)
    console.error('Move the Node-only helper to packages/types/src/node.ts (@dominevo/types/node).')
    process.exit(1)
  }
  console.log('check-types-browser-entry-node-free: ok')
}
