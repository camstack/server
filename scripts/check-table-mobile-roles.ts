#!/usr/bin/env tsx
/**
 * A table fits a phone because every column says what it becomes there.
 *
 * On a 390 px screen a table that keeps all its columns either scrolls
 * sideways or wraps every cell until a row is 200 px tall. `DataTable` folds
 * instead: each `DataColumn` declares `mobile` — `primary` (the row's
 * identity, may wrap), `keep` (short status, a number, the row's actions),
 * `detail` (one muted line under the primary), `sheet` (not in the phone row;
 * a tap on the row opens a bottom sheet listing it as label + control — for
 * columns that hold an input) or `hidden`. The type makes the
 * field required; this guard checks what a type cannot:
 *
 *   1. RAW TABLE   no `<table>` in an admin or addon page. `DataTable`,
 *                  `DeviceList` and the other library tables are the only
 *                  ones, so the fold is implemented once. `packages/ui-library`
 *                  is out of scope by construction; there is no exception
 *                  marker and no baseline.
 *   2. ROLES       no column list has more than ONE `primary` or more than
 *                  THREE `keep`. A list bound to a `…columns` name and written
 *                  whole as a literal must also HAVE its one primary; a fragment
 *                  (`extraColumns` handed to another table, a conditional piece) or a
 *                  list assembled from spreads cannot be counted whole, so
 *                  only its upper bounds are checked. A list of column-shaped
 *                  literals (`key` + `render`) in which NOT ONE entry has
 *                  `mobile` is a table nobody migrated: it is reported too.
 *      A `hidden` column whose `render` returns an input control is also
 *      reported: an editable column that vanishes on a phone cannot be edited
 *      there — make it `keep` (the row's one main control) or `sheet`. The
 *      detection is a JSX-tag heuristic over the column literal's `render`: a
 *      tag that is `input`/`select`/`textarea` or a name ending in `Switch`,
 *      `Select`, `SelectField`, `Input`, `NumberField`, `Checkbox`, `Radio`,
 *      `RadioGroup`, `Slider`, `Textarea` or `Toggle`. It does NOT see a
 *      control produced by a helper component with another name, a render
 *      delegated to a function (`render: renderEnabledCell`), or a column list
 *      not written as literals.
 *   3. WRAPPING    (`packages/ui-library` only — a page cell is not scanned)
 *                  a cell (`<td>`/`<th>`) of a library table never carries
 *                  `flex-wrap` or an unconditional `whitespace-normal`: that
 *                  is what lets a row grow.
 *
 * What a static read cannot see (a list built by `map`, a cell whose content
 * is simply too wide) is measured on the rendered page: `npm run ui:shots`
 * reports the tallest table row and any sideways overflow at 390 px.
 *
 * Scope: `.ts`/`.tsx` under `packages/<pkg>/src`, specs and `__tests__` excluded.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const MAX_KEEP_COLUMNS = 3

const SOURCE = /^packages\/[^/]+\/src\/.*\.tsx?$/
const PAGE_SCOPE = /^packages\/addon-[^/]+\/src\/.*\.tsx$/
const LIBRARY_SCOPE = /^packages\/ui-library\/src\/.*\.tsx$/
const EXEMPT_PATH = /(?:^|\/)(?:__tests__|__mocks__)\/|\.(?:spec|test)\.tsx?$/
const RAW_TABLE = /<table(?=[\s/>]|$)/
const WRAPPING_CLASS = /(?<![\w:-])(?:flex-wrap|whitespace-normal)(?![\w-])/
/** A binding that names a table's WHOLE column list, not extra columns for another table. */
const WHOLE_LIST_NAME = /^(?!.*(?:extra|additional))\w*columns$/i
const MOBILE_ROLES: readonly string[] = ['primary', 'keep', 'detail', 'sheet', 'hidden']
const INPUT_TAG =
  /^(?:input|select|textarea|\w*(?:Switch|Select|SelectField|Input|NumberField|Checkbox|Radio|RadioGroup|Slider|Textarea|Toggle))$/

export type TableRule = 'raw-table' | 'roles' | 'wrapping'

export interface TableFinding {
  readonly rule: TableRule
  readonly line: number
  readonly message: string
}

/** True for a file any rule looks at. */
export function inScope(file: string): boolean {
  return SOURCE.test(file) && !EXEMPT_PATH.test(file)
}

function isCommentOnly(line: string): boolean {
  const t = line.trimStart()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/** Rule 1: every raw `<table>` in one source text. */
export function findRawTables(source: string): TableFinding[] {
  const found: TableFinding[] = []
  source.split('\n').forEach((text, index) => {
    if (isCommentOnly(text) || !RAW_TABLE.test(text)) return
    found.push({
      rule: 'raw-table',
      line: index + 1,
      message: 'raw <table> — use DataTable (or DeviceList mode="generic" for rows that expand)',
    })
  })
  return found
}

/** The literal role of one column object, or null when it is not a column / not a literal. */
function literalRole(element: ts.Expression): string | null {
  if (!ts.isObjectLiteralExpression(element)) return null
  for (const property of element.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const name = property.name
    if (!(ts.isIdentifier(name) || ts.isStringLiteral(name)) || name.text !== 'mobile') continue
    let value: ts.Expression = property.initializer
    while (ts.isAsExpression(value) || ts.isParenthesizedExpression(value)) value = value.expression
    if (ts.isStringLiteralLike(value) && MOBILE_ROLES.includes(value.text)) return value.text
  }
  return null
}

/** The input-control JSX tags inside one column literal's `render` property. */
function inputTagsInRender(element: ts.Expression): string[] {
  if (!ts.isObjectLiteralExpression(element)) return []
  const tags: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = node.tagName.getText()
      if (INPUT_TAG.test(name)) tags.push(name)
    }
    ts.forEachChild(node, visit)
  }
  for (const property of element.properties) {
    const named =
      (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) &&
      property.name.getText() === 'render'
    if (named) visit(property)
  }
  return tags
}

/** An object literal shaped like a `DataColumn`: a `key` and a `render`. */
function looksLikeColumn(element: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(element)) return false
  const names = new Set(
    element.properties.flatMap((property) =>
      ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)
        ? [property.name.getText()]
        : [],
    ),
  )
  return names.has('key') && names.has('render')
}

function parse(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

function lineOf(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
}

/** The name a column list is bound to: `const columns = [...]`, `columns={[...]}`, `function buildColumns()`. */
function boundName(node: ts.Node): string | null {
  let current: ts.Node = node
  for (;;) {
    const parent: ts.Node | undefined = current.parent
    if (parent === undefined) return null
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isJsxExpression(parent) ||
      // `useMemo(() => [...], [])`: the list is what the call returns.
      (ts.isArrowFunction(parent) && parent.body === current) ||
      (ts.isCallExpression(parent) && parent.arguments[0] === current)
    ) {
      current = parent
      continue
    }
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
    // `function buildColumns() { return [...] }`: the list is what the function returns.
    if (ts.isReturnStatement(parent)) {
      const owner = ts.findAncestor(parent, ts.isFunctionLike)
      if (owner === undefined) return null
      if (ts.isFunctionDeclaration(owner)) return owner.name?.text ?? null
      current = owner
      continue
    }
    if (ts.isJsxAttribute(parent)) return parent.name.getText()
    if (ts.isPropertyAssignment(parent)) return parent.name.getText()
    return null
  }
}

/** Rule 2: the role budget of every literal column list in one source text. */
export function findRoleViolations(source: string, fileName = 'file.tsx'): TableFinding[] {
  const file = parse(source, fileName)
  const found: TableFinding[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node)) {
      const roles = node.elements.map(literalRole)
      node.elements.forEach((element, index) => {
        if (roles[index] !== 'hidden') return
        const tags = inputTagsInRender(element)
        if (tags.length > 0) {
          found.push({
            rule: 'roles',
            line: lineOf(file, element),
            message: `a \`hidden\` column renders <${tags[0]}> — an input must stay reachable on a phone: make it \`keep\` or \`sheet\``,
          })
        }
      })
      const known = roles.filter((role): role is string => role !== null)
      if (known.length === 0 && node.elements.some(looksLikeColumn)) {
        found.push({
          rule: 'roles',
          line: lineOf(file, node),
          message:
            'a column list with no `mobile` role on any entry — every column states what it becomes on a phone',
        })
      }
      if (known.length > 0) {
        const whole = known.length === roles.length && WHOLE_LIST_NAME.test(boundName(node) ?? '')
        const primary = known.filter((role) => role === 'primary').length
        const keep = known.filter((role) => role === 'keep').length
        if (primary > 1 || (whole && primary === 0)) {
          found.push({
            rule: 'roles',
            line: lineOf(file, node),
            message: `${primary} \`primary\` column(s) — a table has exactly one (the row's identity)`,
          })
        }
        if (keep > MAX_KEEP_COLUMNS) {
          found.push({
            rule: 'roles',
            line: lineOf(file, node),
            message: `${keep} \`keep\` columns — at most ${MAX_KEEP_COLUMNS} fit beside the primary on a phone; make the rest \`detail\` or \`hidden\``,
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** Rule 3: a library table cell that lets its row grow. */
export function findWrappingCells(source: string, fileName = 'file.tsx'): TableFinding[] {
  const file = parse(source, fileName)
  const found: TableFinding[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(file)
      if ((tag === 'td' || tag === 'th') && WRAPPING_CLASS.test(node.attributes.getText(file))) {
        found.push({
          rule: 'wrapping',
          line: lineOf(file, node),
          message: `<${tag}> carries flex-wrap / whitespace-normal — a wrapping cell lets the row grow on a phone`,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** Every finding of one file, given its repo-relative path. */
export function checkFile(file: string, source: string): TableFinding[] {
  if (!inScope(file)) return []
  return [
    ...(PAGE_SCOPE.test(file) ? findRawTables(source) : []),
    ...findRoleViolations(source, file),
    ...(LIBRARY_SCOPE.test(file) ? findWrappingCells(source, file) : []),
  ]
}

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', 'packages/*.tsx', 'packages/*.ts'], {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out.split('\n').filter((f) => f.length > 0 && inScope(f))
}

function main(): void {
  const failures: string[] = []
  let scanned = 0
  for (const file of trackedFiles()) {
    const source = readFileSync(path.join(ROOT, file), 'utf-8')
    // The cheap question first: most files hold neither a table nor a column.
    if (!source.includes('mobile') && !source.includes('<t')) continue
    scanned++
    for (const finding of checkFile(file, source)) {
      failures.push(`  ${file}:${finding.line}  ${finding.rule}  ${finding.message}`)
    }
  }
  if (failures.length > 0) {
    console.error(
      'FAIL: a table would not fit a phone (docs/ui/admin-patterns.md, "Tables on a phone"):',
    )
    console.error(failures.join('\n'))
    process.exit(1)
  }
  console.log(`ok table mobile roles: ${scanned} file(s) with tables or columns, none off`)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
