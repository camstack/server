#!/usr/bin/env tsx
/**
 * Settings-store collection guard — fail the build if any package accesses a
 * KV collection through the `settings-store` cap WITHOUT declaring it first.
 *
 * ── The bug class this prevents ────────────────────────────────────────────
 * `SqliteSettingsBackend` fail-fasts on any collection that was not
 * `declareCollection()`'d up front (legacy auto-create was removed; the only
 * implicitly-available collections are the `CANONICAL_KV_COLLECTIONS`
 * allowlist). An addon that calls `settingsStore.{query,insert,update,delete,
 * remove,list,count}` on a collection it never declared compiles fine, passes
 * unit tests (the in-memory test doubles auto-create buckets), then crashes at
 * runtime the first time it touches the real SQLite backend. Three addons
 * shipped exactly this bug (addon-ai, addon-notifiers,
 * addon-provider-homeassistant) before it was caught in production.
 *
 * ── What this guard does ───────────────────────────────────────────────────
 * For every package (each `packages/<name>` plus `server/backend`) it parses
 * the TypeScript sources and, PER PACKAGE, collects:
 *
 *   USED      — every collection name passed to a settings-store access method
 *               (`.query` / `.insert` / `.update` / `.delete` / `.remove` /
 *               `.list` / `.count`) on a store-like receiver. Both call
 *               conventions are understood:
 *                 positional  store.query(COLLECTION)
 *                 object-form  store.query({ collection: COLLECTION })
 *   DECLARED  — every collection name passed to a `.declareCollection(...)`
 *               call (same two conventions).
 *
 * A USED collection is a VIOLATION when it is neither DECLARED anywhere in the
 * same package NOR a member of `CANONICAL_KV_COLLECTIONS`.
 *
 * ── Conservative by construction ───────────────────────────────────────────
 * A call is only considered a settings-store access when BOTH:
 *   (a) the method name is one of the store-access verbs above, AND
 *   (b) the receiver is "store-like" (its trailing identifier contains `store`
 *       — e.g. `this.store`, `ctx.api.settingsStore`). The low-level
 *       `ISettingsBackend` impl + `StorageManager` shim (`...backend`
 *       receivers) own the declaration mechanism itself and are out of scope,
 *       AND
 *   (c) the first argument resolves to a concrete collection-name string.
 * The collection argument is resolved through: string literal → package-scoped
 * `const NAME = '...'` → `this.<field>` (via a field initializer, a constructor
 * parameter-property default, or a `this.field = <param|const>` assignment) →
 * an object literal's `collection:` property. Anything that does not resolve to
 * a literal is IGNORED. We prefer missing an exotic edge case over emitting a
 * false alarm — but the three historical shapes (a `const X = '...'` collection
 * used through `.query` with no matching `declareCollection`) are caught.
 *
 * Usage: npx tsx scripts/check-collection-declarations.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')

/** Settings-store access verbs whose first argument names a collection. */
const STORE_METHODS = new Set(['query', 'insert', 'update', 'delete', 'remove', 'list', 'count'])

const DECLARE_METHOD = 'declareCollection'

const SKIP_DIRS = new Set(['dist', 'node_modules', '__tests__', '.git', 'generated'])

interface Violation {
  readonly pkg: string
  readonly collection: string
  readonly file: string
  readonly line: number
}

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------
function walkTs(dir: string, results: string[] = []): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walkTs(path.join(dir, entry.name), results)
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.spec.tsx') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx')
    ) {
      results.push(path.join(dir, entry.name))
    }
  }
  return results
}

function parse(file: string): ts.SourceFile {
  const src = fs.readFileSync(file, 'utf-8')
  return ts.createSourceFile(file, src, ts.ScriptTarget.Latest, /* setParentNodes */ true)
}

// ---------------------------------------------------------------------------
// CANONICAL_KV_COLLECTIONS allowlist — parsed from the sqlite backend so the
// guard tracks the single source of truth automatically.
// ---------------------------------------------------------------------------
function loadCanonicalCollections(): Set<string> {
  const backendPath = path.join(
    ROOT,
    'packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts',
  )
  const canonical = new Set<string>()
  let sf: ts.SourceFile
  try {
    sf = parse(backendPath)
  } catch {
    return canonical
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'CANONICAL_KV_COLLECTIONS' &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const el of node.initializer.elements) {
        if (ts.isStringLiteralLike(el)) canonical.add(el.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return canonical
}

// ---------------------------------------------------------------------------
// Per-package string-constant map: `const NAME = '...'` (module scope + inside
// functions/classes — a flat name→value map is deliberately coarse but safe:
// worst case a shadowed name resolves to the wrong-but-still-a-real literal,
// which only ever changes WHICH string we compare, never whether we falsely
// invent one).
// ---------------------------------------------------------------------------
function collectStringConsts(sources: readonly ts.SourceFile[]): Map<string, string> {
  const consts = new Map<string, string>()
  for (const sf of sources) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isStringLiteralLike(node.initializer)
      ) {
        if (!consts.has(node.name.text)) consts.set(node.name.text, node.initializer.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return consts
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------
function trailingName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return 'this'
  return undefined
}

function isStoreLikeReceiver(receiver: ts.Expression): boolean {
  const name = trailingName(receiver)
  if (!name) return false
  // Target the settings-store CAP/PORT consumers — addon code names the
  // handle `...store` / `settingsStore` (e.g. `this.store`,
  // `ctx.api.settingsStore`). The low-level `ISettingsBackend` implementation
  // + `StorageManager` shim (receivers named `...backend`) are a DIFFERENT
  // layer — they own the declaration mechanism itself and are intentionally
  // out of scope, so a `backend`-named receiver is deliberately NOT matched.
  return name.toLowerCase().includes('store')
}

/** Resolve a `this.<field>` reference to a string literal, tracing the field's
 *  initializer, a constructor parameter-property default, or a
 *  `this.field = <param-default | const>` assignment. */
function resolveThisField(
  fieldName: string,
  cls: ts.ClassLikeDeclaration | undefined,
  consts: Map<string, string>,
): string | undefined {
  if (!cls) return undefined

  // 1. Property declaration with a direct initializer.
  for (const member of cls.members) {
    if (
      ts.isPropertyDeclaration(member) &&
      ts.isIdentifier(member.name) &&
      member.name.text === fieldName &&
      member.initializer
    ) {
      const r = resolveExprToString(member.initializer, cls, consts, /* depth */ 0)
      if (r !== undefined) return r
    }
  }

  const ctor = cls.members.find((m): m is ts.ConstructorDeclaration =>
    ts.isConstructorDeclaration(m),
  )
  if (!ctor) return undefined

  // 2. Constructor parameter-property (`private readonly field = DEFAULT`).
  for (const param of ctor.parameters) {
    if (
      ts.isIdentifier(param.name) &&
      param.name.text === fieldName &&
      param.modifiers &&
      param.modifiers.length > 0 &&
      param.initializer
    ) {
      const r = resolveExprToString(param.initializer, cls, consts, 0)
      if (r !== undefined) return r
    }
  }

  // 3. `this.field = <expr>` assignment in the constructor body, where <expr>
  //    is a constructor parameter (→ its default) or a const/literal.
  if (ctor.body) {
    let found: string | undefined
    const visit = (node: ts.Node): void => {
      if (found !== undefined) return
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
        node.left.name.text === fieldName
      ) {
        const rhs = node.right
        if (ts.isIdentifier(rhs)) {
          // Assigned from a constructor parameter? use its default.
          const param = ctor.parameters.find(
            (p) => ts.isIdentifier(p.name) && p.name.text === rhs.text,
          )
          if (param?.initializer) {
            const r = resolveExprToString(param.initializer, cls, consts, 0)
            if (r !== undefined) {
              found = r
              return
            }
          }
          const c = consts.get(rhs.text)
          if (c !== undefined) {
            found = c
            return
          }
        }
        const direct = resolveExprToString(rhs, cls, consts, 0)
        if (direct !== undefined) found = direct
      }
      ts.forEachChild(node, visit)
    }
    visit(ctor.body)
    if (found !== undefined) return found
  }

  return undefined
}

/** Resolve an expression to a concrete string, or undefined when it cannot be
 *  confidently reduced to a literal. */
function resolveExprToString(
  expr: ts.Expression,
  cls: ts.ClassLikeDeclaration | undefined,
  consts: Map<string, string>,
  depth: number,
): string | undefined {
  if (depth > 6) return undefined
  if (ts.isStringLiteralLike(expr)) return expr.text
  if (ts.isIdentifier(expr)) return consts.get(expr.text)
  if (ts.isPropertyAccessExpression(expr) && expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
    return resolveThisField(expr.name.text, cls, consts)
  }
  if (ts.isParenthesizedExpression(expr)) {
    return resolveExprToString(expr.expression, cls, consts, depth + 1)
  }
  return undefined
}

/** Resolve the collection named by a store call's first argument. Handles the
 *  positional convention (arg is a collection string) and the object
 *  convention (arg is `{ collection: <coll>, ... }`). */
function resolveCollectionArg(
  arg: ts.Expression | undefined,
  cls: ts.ClassLikeDeclaration | undefined,
  consts: Map<string, string>,
): string | undefined {
  if (!arg) return undefined
  if (ts.isObjectLiteralExpression(arg)) {
    for (const prop of arg.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        ((ts.isIdentifier(prop.name) && prop.name.text === 'collection') ||
          (ts.isStringLiteralLike(prop.name) && prop.name.text === 'collection'))
      ) {
        return resolveExprToString(prop.initializer, cls, consts, 0)
      }
    }
    return undefined
  }
  return resolveExprToString(arg, cls, consts, 0)
}

// ---------------------------------------------------------------------------
// Package scan
// ---------------------------------------------------------------------------
interface Usage {
  readonly collection: string
  readonly file: string
  readonly line: number
}

function scanPackage(pkgName: string, srcDir: string, canonical: ReadonlySet<string>): Violation[] {
  const files = walkTs(srcDir)
  if (files.length === 0) return []
  const sources = files.map(parse)
  const consts = collectStringConsts(sources)

  const declared = new Set<string>()
  const used: Usage[] = []

  for (const sf of sources) {
    const visit = (node: ts.Node, cls: ts.ClassLikeDeclaration | undefined): void => {
      const nextCls = ts.isClassLike(node) ? node : cls

      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text
        const receiver = node.expression.expression
        const firstArg = node.arguments[0]

        if (method === DECLARE_METHOD) {
          const coll = resolveCollectionArg(firstArg, nextCls, consts)
          if (coll !== undefined) declared.add(coll)
        } else if (STORE_METHODS.has(method) && isStoreLikeReceiver(receiver)) {
          const coll = resolveCollectionArg(firstArg, nextCls, consts)
          if (coll !== undefined) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
            used.push({ collection: coll, file: sf.fileName, line: line + 1 })
          }
        }
      }

      ts.forEachChild(node, (child) => visit(child, nextCls))
    }
    visit(sf, undefined)
  }

  const violations: Violation[] = []
  const seen = new Set<string>()
  for (const u of used) {
    if (declared.has(u.collection) || canonical.has(u.collection)) continue
    if (seen.has(u.collection)) continue
    seen.add(u.collection)
    violations.push({
      pkg: pkgName,
      collection: u.collection,
      file: path.relative(ROOT, u.file),
      line: u.line,
    })
  }
  return violations
}

// ---------------------------------------------------------------------------
// Discover packages: every `packages/<name>` with a `src` dir, plus
// `server/backend`.
// ---------------------------------------------------------------------------
function discoverPackages(): { name: string; srcDir: string }[] {
  const out: { name: string; srcDir: string }[] = []
  const packagesDir = path.join(ROOT, 'packages')
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(packagesDir, { withFileTypes: true })
  } catch {
    // ignore
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const srcDir = path.join(packagesDir, entry.name, 'src')
    if (fs.existsSync(srcDir)) out.push({ name: `packages/${entry.name}`, srcDir })
  }
  const backendSrc = path.join(ROOT, 'server/backend/src')
  if (fs.existsSync(backendSrc)) out.push({ name: 'server/backend', srcDir: backendSrc })
  return out
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(): void {
  const canonical = loadCanonicalCollections()
  if (canonical.size === 0) {
    // eslint-disable-next-line no-console
    console.error(
      '\x1b[31m✘ collection guard: could not parse CANONICAL_KV_COLLECTIONS from the sqlite backend.\x1b[0m',
    )
    process.exit(1)
  }

  const packages = discoverPackages()
  const allViolations: Violation[] = []
  for (const pkg of packages) {
    allViolations.push(...scanPackage(pkg.name, pkg.srcDir, canonical))
  }

  if (allViolations.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      `  \x1b[32m✔\x1b[0m settings-store collection guard passed — every used collection is declared (or canonical) across ${packages.length} packages`,
    )
    process.exit(0)
  }

  // eslint-disable-next-line no-console
  console.error('\n\x1b[31m✘ undeclared settings-store collection(s) detected:\x1b[0m')
  // eslint-disable-next-line no-console
  console.error(
    '  A collection accessed via the settings-store cap MUST be declareCollection()\n' +
      '  first (in a *.init()), or be a member of CANONICAL_KV_COLLECTIONS. The SQLite\n' +
      '  backend fail-fasts on undeclared collections at runtime.\n',
  )
  for (const v of allViolations) {
    // eslint-disable-next-line no-console
    console.error(`    ${v.pkg} → '${v.collection}' → ${v.file}:${v.line}  (used, never declared)`)
  }
  // eslint-disable-next-line no-console
  console.error('')
  process.exit(1)
}

main()
