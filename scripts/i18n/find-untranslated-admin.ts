/**
 * Census of user-visible literals in the admin UI that bypass i18n.
 *
 * Scans `packages/addon-admin-ui/src/**\/*.tsx` (and the ui-library with
 * `--ui-library`) for text a person reads that is NOT an argument of `t(...)`:
 * JSX text, user-visible JSX props (`title`, `label`, `placeholder`, ...),
 * `{'literal'}` children, and user-visible object properties
 * (`header`, `title`, `message`, `confirmLabel`, `description`, ...).
 *
 *   npx tsx scripts/i18n/find-untranslated-admin.ts            # per-file counts + total
 *   npx tsx scripts/i18n/find-untranslated-admin.ts --verbose  # every finding
 *   npx tsx scripts/i18n/find-untranslated-admin.ts --json     # machine readable
 *   npx tsx scripts/i18n/find-untranslated-admin.ts --addons   # the pages/widgets addon packages ship, per package
 *
 * Exits 1 when anything is found and `--strict` is passed (the guard in
 * `npm run ui:check:i18n` and the Checks workflow).
 *
 * ## Allow-list: intentional non-text
 *
 * A literal that is NOT prose (a brand name, a field name shown verbatim, a
 * code sample) is exempted in the source with a marker comment, and the marker
 * carries the reason:
 *
 *   // i18n-ignore: <reason>              exempts the same line and the next one
 *   {/* i18n-ignore: <reason> *\/}         the JSX form of the same
 *   // i18n-ignore-start: <reason> ... // i18n-ignore-end   exempts a block
 *
 * Everything else must go through `t(...)` / `<Trans>`.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as ts from 'typescript'

export interface Finding {
  readonly file: string
  readonly line: number
  readonly kind: 'jsx-text' | 'jsx-prop' | 'jsx-expr' | 'object-prop'
  readonly name: string
  readonly text: string
}

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const ADMIN_SRC = path.join(ROOT, 'packages/addon-admin-ui/src')
const UI_LIB_SRC = path.join(ROOT, 'packages/ui-library/src')

/** JSX props whose string value is read by a person. */
const VISIBLE_PROPS: ReadonlySet<string> = new Set([
  'title',
  'label',
  'placeholder',
  'aria-label',
  'ariaLabel',
  'description',
  'confirmLabel',
  'cancelLabel',
  'emptyMessage',
  'emptyTitle',
  'emptyDescription',
  'helperText',
  'hint',
  'tooltip',
  'subtitle',
  'heading',
  'message',
  'header',
  'caption',
  'alt',
  'noResultsText',
  'searchPlaceholder',
  'actionLabel',
  'submitLabel',
  'saveLabel',
])

/** Object property names that carry display text (columns, confirms, toasts). */
const VISIBLE_OBJECT_PROPS: ReadonlySet<string> = new Set([
  'header',
  'title',
  'message',
  'confirmLabel',
  'cancelLabel',
  'description',
  'emptyMessage',
  'placeholder',
  'tooltip',
  'subtitle',
  'label',
  'hint',
  'reason',
  'text',
  'summary',
  'note',
  'body',
  'detail',
  'error',
  'warning',
  'emptyTitle',
  'emptyDescription',
  'heading',
  'caption',
])

const SKIP_FILE =
  /(Showroom\.tsx|\.spec\.|\.test\.|\.stories\.|[\\/]__tests__[\\/]|[\\/]__fixtures__[\\/]|\.d\.ts$)/

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      walk(full, out)
    } else if (/\.tsx?$/.test(entry.name) && !SKIP_FILE.test(full)) {
      out.push(full)
    }
  }
}

/** Does the literal read like prose a person sees (not an id, url, class, unit)? */
export function looksUserVisible(raw: string): boolean {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (text.length < 2) return false
  if (!/[A-Za-z]{2}/.test(text)) return false
  if (/^(https?:|\/|\.|#|@|\$\{)/.test(text)) return false
  if (/^<[^<>\s]+>([:/-]<[^<>\s]+>)*$/.test(text)) return false // <type>:<slug> format hints
  if (/^[a-z0-9_.:/-]+$/.test(text) && !/^[a-z]{3,}$/.test(text)) return false // ids, css, paths, keys (a bare lowercase WORD is prose)
  if (/^[a-z]+([A-Z][a-z0-9]*)+$/.test(text)) return false // camelCase identifier
  if (/^[A-Z0-9_]+$/.test(text) && !text.includes(' ')) return false // CONSTANT / acronym ids
  if (/^[a-z-]+(\s[a-z-]+)*:\s*[^ ]/.test(text) && /[;{]/.test(text)) return false
  // Tailwind-ish class lists: all tokens lowercase with dashes/colons/brackets.
  if (/^([a-z0-9[\]:/.%!-]+)( [a-z0-9[\]:/.%!-]+)+$/.test(text) && /[-:[]/.test(text)) return false
  return true
}

function isInsideT(node: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isCallExpression(cur)) {
      const callee = cur.expression
      if (ts.isIdentifier(callee) && (callee.text === 't' || callee.text === 'tr')) return true
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 't') return true
    }
    if (ts.isJsxElement(cur) || ts.isJsxSelfClosingElement(cur) || ts.isSourceFile(cur))
      return false
  }
  return false
}

/** String literals reachable through ternaries / && / ?? / parens. */
function literalsOf(expr: ts.Expression): ts.Expression[] {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr]
  if (ts.isTemplateExpression(expr)) return [expr]
  if (ts.isParenthesizedExpression(expr)) return literalsOf(expr.expression)
  if (ts.isConditionalExpression(expr))
    return [...literalsOf(expr.whenTrue), ...literalsOf(expr.whenFalse)]
  if (ts.isBinaryExpression(expr)) {
    const k = expr.operatorToken.kind
    if (k === ts.SyntaxKind.AmpersandAmpersandToken) return literalsOf(expr.right)
    if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken) {
      return [...literalsOf(expr.left), ...literalsOf(expr.right)]
    }
  }
  return []
}

function literalText(node: ts.Expression): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => '{}' + s.literal.text).join('')
  }
  return ''
}

export interface Candidate {
  readonly node: ts.Node
  /** The literal expression (jsx-prop expr / jsx-expr / object-prop) when there is one. */
  readonly literal: ts.Expression | null
  readonly kind: Finding['kind']
  readonly name: string
  readonly text: string
}

export function collectCandidates(sf: ts.SourceFile): Candidate[] {
  const out: Candidate[] = []
  const addLiterals = (expr: ts.Expression, kind: Finding['kind'], name: string): void => {
    for (const lit of literalsOf(expr)) {
      const text = literalText(lit)
      if (looksUserVisible(text) && !isInsideT(lit))
        out.push({ node: lit, literal: lit, kind, name, text })
    }
  }
  /** A returned / arrow-bodied literal reads as prose only when it has a space or starts uppercase. */
  const addProse = (expr: ts.Expression, name: string): void => {
    for (const lit of literalsOf(expr)) {
      const text = literalText(lit)
      if (looksUserVisible(text) && /(\s|^[A-Z])/.test(text.trim()) && !isInsideT(lit))
        out.push({ node: lit, literal: lit, kind: 'object-prop', name, text })
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const text = node.text
      if (/[A-Za-z]{2}/.test(text) && looksUserVisible(text) && !isUnderCodeLikeTag(node)) {
        out.push({ node, literal: null, kind: 'jsx-text', name: 'text', text })
      }
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf)
      if (VISIBLE_PROPS.has(name) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) {
          if (looksUserVisible(node.initializer.text)) {
            out.push({
              node,
              literal: node.initializer,
              kind: 'jsx-prop',
              name,
              text: node.initializer.text,
            })
          }
        } else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          addLiterals(node.initializer.expression, 'jsx-prop', name)
        }
      }
    } else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      addLiterals(node.expression, 'jsx-expr', 'child')
    } else if (ts.isReturnStatement(node) && node.expression) {
      addProse(node.expression, 'return')
    } else if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      addProse(node.body, 'return')
    } else if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
    ) {
      const name = node.name.text
      if (VISIBLE_OBJECT_PROPS.has(name)) addLiterals(node.initializer, 'object-prop', name)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** 1-based lines exempted by `i18n-ignore` markers (see the header). */
export function ignoredLines(source: string): ReadonlySet<number> {
  const out = new Set<number>()
  const lines = source.split('\n')
  let blockOpen = false
  lines.forEach((text, i) => {
    const line = i + 1
    if (text.includes('i18n-ignore-start')) blockOpen = true
    if (blockOpen) out.add(line)
    if (text.includes('i18n-ignore-end')) blockOpen = false
    else if (text.includes('i18n-ignore') && !text.includes('i18n-ignore-start')) {
      out.add(line)
      out.add(line + 1)
    }
  })
  return out
}

export function scanSource(file: string, source: string): Finding[] {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.TSX,
  )
  const ignored = ignoredLines(source)
  return collectCandidates(sf)
    .filter((c) => {
      const start = sf.getLineAndCharacterOfPosition(c.node.getStart(sf)).line + 1
      const end = sf.getLineAndCharacterOfPosition(c.node.getEnd()).line + 1
      for (let l = start; l <= end; l++) if (ignored.has(l)) return false
      return true
    })
    .map((c) => ({
      file,
      line: sf.getLineAndCharacterOfPosition(c.node.getStart(sf)).line + 1,
      kind: c.kind,
      name: c.name,
      text: c.text.replace(/\s+/g, ' ').trim(),
    }))
}

/** `<code>`, `<pre>`, `<kbd>` hold literal data, not prose. */
function isUnderCodeLikeTag(node: ts.Node): boolean {
  const parent = node.parent
  if (!parent || !ts.isJsxElement(parent)) return false
  const tag = parent.openingElement.tagName.getText()
  return tag === 'code' || tag === 'pre' || tag === 'kbd' || tag === 'style' || tag === 'script'
}

const PACKAGES_DIR = path.join(ROOT, 'packages')

/** `src` of every `packages/addon-*` that ships admin pages/widgets, the admin app itself excluded. */
export function addonPackageSrcDirs(): string[] {
  return fs
    .readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('addon-') && e.name !== 'addon-admin-ui')
    .map((e) => path.join(PACKAGES_DIR, e.name, 'src'))
    .filter((dir) => fs.existsSync(dir))
}

export function scanAddons(): Finding[] {
  const files: string[] = []
  for (const dir of addonPackageSrcDirs()) walk(dir, files)
  files.sort()
  return files.flatMap((f) => scanSource(path.relative(ROOT, f), fs.readFileSync(f, 'utf8')))
}

export function scanAll(includeUiLibrary: boolean): Finding[] {
  const files: string[] = []
  walk(ADMIN_SRC, files)
  if (includeUiLibrary) walk(UI_LIB_SRC, files)
  files.sort()
  return files.flatMap((f) => scanSource(path.relative(ROOT, f), fs.readFileSync(f, 'utf8')))
}

function main(): void {
  const args = new Set(process.argv.slice(2))
  const findings = args.has('--addons')
    ? scanAddons()
    : scanAll(args.has('--ui-library') || args.has('--strict'))
  if (args.has('--addons') && !args.has('--json')) {
    const perPackage = new Map<string, number>()
    for (const f of findings) {
      const pkg = f.file.split(path.sep)[1] ?? f.file
      perPackage.set(pkg, (perPackage.get(pkg) ?? 0) + 1)
    }
    for (const [pkg, n] of [...perPackage.entries()].sort())
      process.stdout.write(`${String(n).padStart(5)}  ${pkg}\n`)
  }
  if (args.has('--json')) {
    process.stdout.write(JSON.stringify(findings, null, 2) + '\n')
  } else {
    const perFile = new Map<string, Finding[]>()
    for (const f of findings) perFile.set(f.file, [...(perFile.get(f.file) ?? []), f])
    const rows = [...perFile.entries()].sort((a, b) => b[1].length - a[1].length)
    for (const [file, list] of rows) {
      process.stdout.write(`${String(list.length).padStart(4)}  ${file}\n`)
      if (args.has('--verbose')) {
        for (const f of list)
          process.stdout.write(`        ${f.line}  [${f.kind}:${f.name}] ${f.text}\n`)
      }
    }
    process.stdout.write(
      `\nTOTAL ${findings.length} untranslated literal(s) in ${perFile.size} file(s)\n`,
    )
  }
  if (args.has('--strict') && findings.length > 0) process.exit(1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) main()
