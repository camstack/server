#!/usr/bin/env tsx
/**
 * An addon that SERVES a global form with a secret field DECLARES that form
 * through `globalSettingsSchema()` (D787).
 *
 * ## The failure this catches
 *
 * The keychain save path derives an addon's secret tree from
 * `globalSettingsSchema()`. An addon that serves its form from a
 * `getGlobalSettings()` override and leaves `globalSettingsSchema()` at the
 * base `null` has an EMPTY tree. Its `type: 'password'` fields look secret to
 * every reader of the form (the UI, the keychain migration) but are written
 * to the store as plaintext. provider-wyze (`password`, `apiKey`) and
 * provider-onvif (`defaultPassword`) shipped this way. The keychain migration
 * "moved" Wyze's secrets twice and they came straight back as plaintext.
 *
 * ## What it checks
 *
 * In every non-test `.ts` under `packages/addon-*\/src` and
 * `packages/system/src/builtins`, a class that defines `getGlobalSettings`
 * but not `globalSettingsSchema` is a finding when the override can reach a
 * secret config-UI field (`{ key, type: 'password' }` or `{ key, secret: true }`):
 *
 *   - written inline in the override,
 *   - in a method of the same class the override calls (`this.buildSchema()`),
 *   - in a relatively-imported module whose import the override uses.
 *
 * Exceptions are pinned in {@link ALLOWLIST} with a reason; a stale entry
 * fails too.
 *
 * Usage: npx tsx scripts/check-global-schema-declared.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

export interface Finding {
  readonly file: string
  readonly className: string
}

export function findingId(f: Finding): string {
  return `${f.file}#${f.className}`
}

export const ALLOWLIST: ReadonlyMap<string, string> = new Map<string, string>([])

/** Reads a module by absolute path; `null` when it does not exist. */
export type ModuleReader = (absPath: string) => string | null

function propText(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue
    const n = p.name
    if ((ts.isIdentifier(n) || ts.isStringLiteral(n)) && n.text === name) return p.initializer
  }
  return null
}

function isSecretFieldLiteral(node: ts.ObjectLiteralExpression): boolean {
  if (propText(node, 'key') === null) return false
  const type = propText(node, 'type')
  if (type && ts.isStringLiteralLike(type) && type.text === 'password') return true
  const secret = propText(node, 'secret')
  return secret !== null && secret.kind === ts.SyntaxKind.TrueKeyword
}

/** Does any object literal under `node` declare a secret config-UI field? */
export function containsSecretField(node: ts.Node): boolean {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (ts.isObjectLiteralExpression(n) && isSecretFieldLiteral(n)) {
      found = true
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

function memberName(m: ts.ClassElement): string | null {
  const n = m.name
  if (n && (ts.isIdentifier(n) || ts.isStringLiteral(n))) return n.text
  return null
}

/** `import { a as b } from './x.js'` → local name → absolute module path (relative imports only). */
function relativeImports(sf: ts.SourceFile, absFile: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue
    const spec = st.moduleSpecifier.text
    if (!spec.startsWith('.')) continue
    const target = resolve(dirname(absFile), spec.replace(/\.(m?js)$/, '.ts'))
    const bindings = st.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) out.set(el.name.text, target)
    }
    if (st.importClause?.name) out.set(st.importClause.name.text, target)
  }
  return out
}

function overrideReachesSecret(
  method: ts.MethodDeclaration,
  cls: ts.ClassDeclaration,
  imports: Map<string, string>,
  read: ModuleReader,
): boolean {
  if (!method.body) return false
  if (containsSecretField(method.body)) return true
  const classMethods = new Map<string, ts.ClassElement>()
  for (const m of cls.members) {
    const name = memberName(m)
    if (name) classMethods.set(name, m)
  }
  let reached = false
  const visit = (n: ts.Node): void => {
    if (reached) return
    if (
      ts.isPropertyAccessExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ThisKeyword &&
      n.name.text !== 'getGlobalSettings'
    ) {
      const target = classMethods.get(n.name.text)
      if (target && containsSecretField(target)) reached = true
    } else if (ts.isIdentifier(n) && imports.has(n.text)) {
      const text = read(imports.get(n.text)!)
      if (text !== null) {
        const mod = ts.createSourceFile('m.ts', text, ts.ScriptTarget.Latest, true)
        if (containsSecretField(mod)) reached = true
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(method.body)
  return reached
}

export function findUndeclaredGlobalSchemas(
  file: string,
  absFile: string,
  text: string,
  read: ModuleReader,
): readonly Finding[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const imports = relativeImports(sf, absFile)
  const out: Finding[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isClassDeclaration(n) && n.name) {
      const getter = n.members.find(
        (m): m is ts.MethodDeclaration =>
          ts.isMethodDeclaration(m) && memberName(m) === 'getGlobalSettings',
      )
      const declares = n.members.some((m) => memberName(m) === 'globalSettingsSchema')
      if (getter && !declares && overrideReachesSecret(getter, n, imports, read)) {
        out.push({ file, className: n.name.text })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) walk(abs, out)
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !/\.(spec|test)\.ts$/.test(name)) {
      out.push(abs)
    }
  }
}

function sourceRoots(root: string): string[] {
  const pkgs = join(root, 'packages')
  const roots: string[] = []
  for (const name of readdirSync(pkgs)) {
    if (!name.startsWith('addon-')) continue
    const src = join(pkgs, name, 'src')
    if (existsSync(src)) roots.push(src)
  }
  const builtins = join(pkgs, 'system', 'src', 'builtins')
  if (existsSync(builtins)) roots.push(builtins)
  return roots
}

const fsReader: ModuleReader = (abs) => (existsSync(abs) ? readFileSync(abs, 'utf8') : null)

export function scanRepo(root: string): readonly Finding[] {
  const files: string[] = []
  for (const dir of sourceRoots(root)) walk(dir, files)
  const out: Finding[] = []
  for (const abs of files) {
    const text = readFileSync(abs, 'utf8')
    if (!text.includes('getGlobalSettings')) continue
    out.push(...findUndeclaredGlobalSchemas(relative(root, abs), abs, text, fsReader))
  }
  return out
}

export interface GuardResult {
  readonly undeclared: readonly Finding[]
  readonly stale: readonly string[]
}

export function evaluate(
  findings: readonly Finding[],
  allowlist: ReadonlyMap<string, string> = ALLOWLIST,
): GuardResult {
  const ids = new Set(findings.map(findingId))
  return {
    undeclared: findings.filter((f) => !allowlist.has(findingId(f))),
    stale: [...allowlist.keys()].filter((id) => !ids.has(id)),
  }
}

function main(): void {
  const { undeclared, stale } = evaluate(scanRepo(process.cwd()))
  if (undeclared.length === 0 && stale.length === 0) {
    console.log(
      '✔ every getGlobalSettings override serving a secret field declares globalSettingsSchema()',
    )
    return
  }
  for (const f of undeclared) {
    console.error(
      `✘ ${f.file}: ${f.className} serves a secret field from getGlobalSettings() but does not declare globalSettingsSchema() — its secrets are stored as plaintext`,
    )
  }
  for (const id of stale) console.error(`✘ stale allowlist entry (fixed — remove it): ${id}`)
  console.error(
    '\nDeclare the form: `protected override globalSettingsSchema()` returning it. The keychain save path builds the secret tree from that declaration (D787).',
  )
  process.exit(1)
}

if (process.argv[1]?.endsWith('check-global-schema-declared.ts')) main()
