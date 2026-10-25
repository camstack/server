#!/usr/bin/env tsx
/**
 * User-facing decision-id guard — no `D550` / `ADR-0550` in text an operator reads.
 *
 * ## The failure this catches
 *
 * Decision ids are an internal index into `docs/decisions/`. They leaked into the product:
 * the Data → Storage help text cited two of them and the Addons page a third. An operator
 * cannot open those records and should not need to — user-facing text says what a thing
 * does and what to do, nothing else. Code comments, ADRs and `docs/` keep their ids; this
 * guard looks ONLY at strings that reach a screen.
 *
 * ## What counts as user-facing (AST, not grep)
 *
 * Every non-test `.ts` / `.tsx` under `packages/<pkg>/src` and `server/<pkg>/src` is parsed
 * with the TypeScript compiler, so comments and identifiers are never seen:
 *
 * - JSX text (`<p>See D550</p>`) and string literals inside a JSX child expression.
 * - The value of a JSX attribute named in `UI_KEYS` (`label=`, `title=`, `placeholder=`, …).
 * - The value of an object property named in `UI_KEYS` (`description: '…'`, `help: '…'`,
 *   `message: '…'`) — settings schemas, `getSchema` contributions, notification texts,
 *   `TRPCError({ message })`.
 * - The argument of a zod `.describe('…')`.
 * - The first argument of `new <Anything>Error('…')` — an error message can reach a toast.
 *
 * A "value" is followed through string literals, templates, `+`, `?:`, `??`, `||`,
 * parentheses, `as const` and array literals — never into a function body, so a log line
 * inside an arrow function stored under `label` is not judged.
 *
 * Plus every `*.json` under a `src/**\/i18n` or `src/**\/locales` directory (all values).
 *
 * ## Allowlist
 *
 * `ALLOWLIST` below: `{ file, text, why }`. A match whose file ends with `file` and whose
 * string contains `text` is skipped. An entry that matches nothing FAILS the guard.
 *
 * Run: npx tsx scripts/check-user-facing-decision-ids.ts [file...]   (no args = whole scope)
 * With file args (the pre-commit hook passes the staged ones), out-of-scope files are ignored.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** `D2`, `D550`, `ADR-0550`, `adr-12`, `ADR 12`. */
const DECISION_ID = /\bD\d{1,4}\b|\badr[- ]?\d+\b/i

const UI_KEYS: ReadonlySet<string> = new Set([
  'label',
  'description',
  'title',
  'placeholder',
  'help',
  'helpText',
  'hint',
  'tooltip',
  'message',
  'caption',
  'subtitle',
  'summary',
  'heading',
  'emptyText',
  'emptyMessage',
  'errorMessage',
  'confirmText',
  'confirmLabel',
  'aria-label',
  'alt',
  'body',
  'text',
  'detail',
  'note',
  'warning',
  'explanation',
  'remedy',
  'problem',
  'displayName',
])

/**
 * Packages whose `src` is ALL interface: every string literal in them is judged, as is every
 * string literal in any `.tsx` anywhere — a helper that returns a label is still a label.
 * Exempt in that mode: module specifiers, literal TYPES, and the arguments of a logger call.
 */
const UI_PACKAGES: ReadonlySet<string> = new Set(['addon-admin-ui', 'ui-library', 'addon-agent-ui'])
const LOGGER_CALL = /(^|\.)(log|logger|console)\??\.(trace|debug|info|warn|error|log)$/

interface AllowEntry {
  readonly file: string
  readonly text: string
  readonly why: string
}

const ALLOWLIST: readonly AllowEntry[] = []

interface Finding {
  readonly file: string
  readonly line: number
  readonly where: string
  readonly text: string
}

const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  '__tests__',
  '__mocks__',
  'generated',
])
const TEST_FILE = /\.(spec|test|stories)\.tsx?$|\.d\.ts$/

function inScope(rel: string): boolean {
  const parts = rel.split(path.sep)
  if (parts.length === 3 && parts[2] === 'package.json')
    return parts[0] === 'packages' || parts[0] === 'server'
  if (parts.length < 4) return false
  if (!((parts[0] === 'packages' || parts[0] === 'server') && parts[2] === 'src')) return false
  if (parts.some((p) => SKIP_DIRS.has(p))) return false
  if (rel.endsWith('.json')) return parts.includes('i18n') || parts.includes('locales')
  return /\.tsx?$/.test(rel) && !TEST_FILE.test(rel)
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else out.push(path.relative(ROOT, full))
  }
}

function allFiles(): string[] {
  const out: string[] = []
  for (const top of ['packages', 'server']) {
    const base = path.join(ROOT, top)
    for (const pkg of fs.existsSync(base) ? fs.readdirSync(base) : []) {
      walk(path.join(base, pkg, 'src'), out)
      if (fs.existsSync(path.join(base, pkg, 'package.json')))
        out.push(path.join(top, pkg, 'package.json'))
    }
  }
  return out.filter(inScope)
}

/** The literal text a value expression can render, without entering function bodies. */
function stringsOf(node: ts.Node, out: ts.Node[]): void {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    out.push(node)
  } else if (ts.isTemplateExpression(node)) {
    out.push(node.head)
    for (const span of node.templateSpans) {
      out.push(span.literal)
      stringsOf(span.expression, out)
    }
  } else if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    stringsOf(node.expression, out)
  } else if (ts.isConditionalExpression(node)) {
    stringsOf(node.whenTrue, out)
    stringsOf(node.whenFalse, out)
  } else if (ts.isBinaryExpression(node)) {
    stringsOf(node.left, out)
    stringsOf(node.right, out)
  } else if (ts.isArrayLiteralExpression(node)) {
    for (const el of node.elements) stringsOf(el, out)
  } else if (ts.isJsxExpression(node) && node.expression !== undefined) {
    stringsOf(node.expression, out)
  }
}

function propName(name: ts.PropertyName | ts.JsxAttributeName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  if (ts.isJsxNamespacedName(name)) return `${name.namespace.text}:${name.name.text}`
  return undefined
}

function textOf(node: ts.Node, sf: ts.SourceFile): string {
  if (ts.isJsxText(node)) return node.text
  if (
    ts.isStringLiteralLike(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  )
    return node.text
  return node.getText(sf)
}

export function scanSource(rel: string, src: string): Finding[] {
  const kind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, kind)
  const findings: Finding[] = []
  const seen = new Set<number>()
  const wholeFile = rel.endsWith('.tsx') || UI_PACKAGES.has(rel.split(path.sep)[1] ?? '')
  const judge = (node: ts.Node, where: string): void => {
    if (seen.has(node.getStart(sf))) return
    seen.add(node.getStart(sf))
    const text = textOf(node, sf)
    if (!DECISION_ID.test(text)) return
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
    findings.push({ file: rel, line, where, text: text.trim().replace(/\s+/g, ' ') })
  }
  const judgeValue = (value: ts.Node, where: string): void => {
    const strings: ts.Node[] = []
    stringsOf(value, strings)
    for (const s of strings) judge(s, where)
  }
  const visit = (node: ts.Node): void => {
    if (wholeFile) {
      if (
        ts.isImportDeclaration(node) ||
        ts.isExportDeclaration(node) ||
        ts.isLiteralTypeNode(node)
      )
        return
      if (ts.isCallExpression(node) && LOGGER_CALL.test(node.expression.getText(sf))) return
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        judge(node, 'UI string')
      }
    }
    if (ts.isJsxText(node)) {
      judge(node, 'JSX text')
    } else if (
      ts.isJsxExpression(node) &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      judgeValue(node, 'JSX child')
    } else if (ts.isJsxAttribute(node) && node.initializer !== undefined) {
      const name = propName(node.name)
      if (name !== undefined && UI_KEYS.has(name)) judgeValue(node.initializer, `${name}=`)
    } else if (ts.isPropertyAssignment(node)) {
      const name = propName(node.name)
      if (name !== undefined && UI_KEYS.has(name)) judgeValue(node.initializer, `${name}:`)
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'describe' &&
      node.arguments[0] !== undefined
    ) {
      judgeValue(node.arguments[0], '.describe()')
    } else if (
      ts.isNewExpression(node) &&
      node.expression.getText(sf).endsWith('Error') &&
      node.arguments?.[0] !== undefined
    ) {
      judgeValue(node.arguments[0], `new ${node.expression.getText(sf)}()`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return findings
}

export function scanJson(rel: string, src: string): Finding[] {
  const findings: Finding[] = []
  src.split('\n').forEach((line, i) => {
    if (DECISION_ID.test(line))
      findings.push({ file: rel, line: i + 1, where: 'locale', text: line.trim() })
  })
  return findings
}

/** A package manifest: the `description` / `label` / … strings the admin UI renders from it. */
export function scanManifest(rel: string, src: string): Finding[] {
  const findings: Finding[] = []
  const lines = src.split('\n')
  const walkJson = (value: unknown, key: string): void => {
    if (typeof value === 'string') {
      if (UI_KEYS.has(key) && DECISION_ID.test(value)) {
        const probe = JSON.stringify(value).slice(1, 41)
        const idx = lines.findIndex((l) => l.includes(probe))
        findings.push({ file: rel, line: idx + 1, where: `manifest ${key}`, text: value })
      }
    } else if (Array.isArray(value)) {
      for (const v of value) walkJson(v, key)
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walkJson(v, k)
    }
  }
  walkJson(JSON.parse(src), '')
  return findings
}

function main(): void {
  const args = process.argv.slice(2).map((a) => path.relative(ROOT, path.resolve(a)))
  const files =
    args.length > 0
      ? args.filter((f) => inScope(f) && fs.existsSync(path.join(ROOT, f)))
      : allFiles()
  const used = new Set<AllowEntry>()
  const findings: Finding[] = []
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    if (!DECISION_ID.test(src)) continue
    const raw = rel.endsWith('package.json')
      ? scanManifest(rel, src)
      : rel.endsWith('.json')
        ? scanJson(rel, src)
        : scanSource(rel, src)
    for (const f of raw) {
      const allow = ALLOWLIST.find((a) => f.file.endsWith(a.file) && f.text.includes(a.text))
      if (allow !== undefined) used.add(allow)
      else findings.push(f)
    }
  }
  const stale = args.length > 0 ? [] : ALLOWLIST.filter((a) => !used.has(a))
  if (findings.length === 0 && stale.length === 0) {
    console.log(`check-user-facing-decision-ids: OK (${files.length} files)`)
    return
  }
  for (const f of findings) {
    const at = Math.max(0, (DECISION_ID.exec(f.text)?.index ?? 0) - 80)
    const excerpt = `${at > 0 ? '…' : ''}${f.text.slice(at, at + 160)}`
    console.error(`${f.file}:${f.line}  [${f.where}]  ${excerpt}`)
  }
  for (const a of stale)
    console.error(`stale ALLOWLIST entry (matches nothing): ${a.file} — ${a.text}`)
  console.error(
    `\n${findings.length} user-facing string(s) cite an internal decision id. Say what the thing does and\n` +
      'what the operator should do; keep the id in a code comment if the link matters to developers.',
  )
  process.exit(1)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
