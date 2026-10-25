/**
 * The UI catalogue — what `@camstack/ui-library` exports, which component
 * answers which need, and the colour tokens — derived from the source so it
 * cannot drift from it.
 *
 * Read SYNTACTICALLY (the TypeScript parser, no type checker): the barrel
 * `packages/ui-library/src/index.ts` is walked through every `export *` and
 * `export { … } from`, and each exported declaration is classified and given
 * its JSDoc summary and, for a component, the members of its `<Name>Props`
 * interface. Sub-second, so the pre-commit hook can regenerate it.
 *
 * Consumed by `scripts/ui/cli.ts` (`ui:find`, `ui:show`, `ui:tokens`) and by
 * the `camstack-ui` skills, which tell an agent to search it before building.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'

export type CatalogueKind = 'component' | 'hook' | 'function' | 'constant'

export interface CatalogueProp {
  readonly name: string
  readonly type: string
  readonly optional: boolean
  readonly doc: string
}

export interface CatalogueEntry {
  readonly name: string
  readonly kind: CatalogueKind
  /** First directory under `src/` — `primitives`, `composites`, `hooks`, … */
  readonly area: string
  /** Repo-relative path of the declaring file. */
  readonly file: string
  readonly summary: string
  /** Heritage of the `<Name>Props` interface, e.g. `ButtonHTMLAttributes<…>`. */
  readonly propsExtends?: readonly string[]
  readonly props?: readonly CatalogueProp[]
}

export interface NeedRow {
  readonly need: string
  readonly admin: string
  readonly viewer: string
  readonly notes: string
}

export interface ColorToken {
  /** CSS name without the `--color-` prefix, e.g. `foreground-muted`. */
  readonly name: string
  /** The key the viewer's `ColorTokens` uses for the same colour. */
  readonly viewerKey: string
  readonly dark: string
  readonly light: string | null
}

export interface UiCatalogue {
  readonly generatedBy: string
  readonly entries: readonly CatalogueEntry[]
  /**
   * The viewer's React Native kit (`camstack/src/components/ui`, a submodule):
   * area `viewer`, never merged into `entries` — a viewer `Row` is not a
   * library `Row`. Empty only when the kit was never indexed.
   */
  readonly viewerEntries: readonly CatalogueEntry[]
  readonly needs: readonly NeedRow[]
  readonly colors: readonly ColorToken[]
  readonly radius: Readonly<Record<string, string>>
}

export const CATALOGUE_PATH = 'docs/reference/ui-components.json'
export const LIBRARY_BARREL = 'packages/ui-library/src/index.ts'
export const THEME_CSS = 'packages/ui-library/src/tailwind/camstack-theme.css'
export const VIEWER_KIT_DIR = 'camstack/src/components/ui'
export const NEED_TABLE = 'docs/ui/need-x-use-y.md'

/** Barrel subtrees that are not a building block an author picks by need. */
const SKIPPED_AREAS: readonly string[] = ['generated']

// ── Module resolution ──────────────────────────────────────────────────────

const EXTENSIONS: readonly string[] = ['.ts', '.tsx', '/index.ts', '/index.tsx']

export function resolveModule(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromFile), spec.replace(/\.js$/, ''))
  for (const ext of EXTENSIONS) {
    const candidate = `${base}${ext}`
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}

// ── Declaration reading ────────────────────────────────────────────────────

const parsed = new Map<string, ts.SourceFile>()

function parse(file: string): ts.SourceFile {
  const cached = parsed.get(file)
  if (cached) return cached
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  parsed.set(file, sf)
  return sf
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  )
}

/** First paragraph of a JSDoc block, whitespace-collapsed, at most 220 chars. */
export function summarize(doc: string): string {
  const first = doc.split(/\n\s*\n/)[0] ?? ''
  const flat = first.replace(/\s+/g, ' ').trim()
  return flat.length > 220 ? `${flat.slice(0, 217)}…` : flat
}

function jsDocText(node: ts.Node): string {
  for (const doc of ts.getJSDocCommentsAndTags(node)) {
    if (ts.isJSDoc(doc) && doc.comment !== undefined) {
      return typeof doc.comment === 'string'
        ? doc.comment
        : doc.comment.map((part) => part.text).join('')
    }
  }
  return ''
}

/** The file's leading doc block — most components document themselves there. */
function fileSummary(file: string): string {
  const text = parse(file).getFullText()
  const m = /^\s*(?:\/\/[^\n]*\n\s*)*\/\*\*([\s\S]*?)\*\//.exec(text)
  if (!m) return ''
  const body = m[1]
    .split('\n')
    .map((l) => l.replace(/^\s*\* ?/, ''))
    .join('\n')
  return summarize(body)
}

interface LocalDecl {
  readonly name: string
  readonly node: ts.Node
  readonly isType: boolean
  readonly initializer?: ts.Expression
}

function declarationsOf(stmt: ts.Statement): LocalDecl[] {
  if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name) {
    return [{ name: stmt.name.text, node: stmt, isType: false }]
  }
  if (ts.isVariableStatement(stmt)) {
    return stmt.declarationList.declarations.flatMap((d) =>
      ts.isIdentifier(d.name)
        ? [{ name: d.name.text, node: stmt, isType: false, initializer: d.initializer }]
        : [],
    )
  }
  if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) {
    return [{ name: stmt.name.text, node: stmt, isType: true }]
  }
  if (ts.isEnumDeclaration(stmt)) return [{ name: stmt.name.text, node: stmt, isType: false }]
  return []
}

function localDeclarations(sf: ts.SourceFile): Map<string, LocalDecl> {
  const out = new Map<string, LocalDecl>()
  for (const stmt of sf.statements) for (const d of declarationsOf(stmt)) out.set(d.name, d)
  return out
}

interface ResolvedExport {
  readonly name: string
  readonly file: string
  readonly decl: LocalDecl
}

/** Every value export reachable from `file`, following re-exports. */
export function collectExports(file: string, seen = new Set<string>()): ResolvedExport[] {
  if (seen.has(file)) return []
  seen.add(file)
  const sf = parse(file)
  const locals = localDeclarations(sf)
  const out: ResolvedExport[] = []
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly) continue
      const spec =
        stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
          ? stmt.moduleSpecifier.text
          : null
      const target = spec === null ? null : resolveModule(file, spec)
      if (!stmt.exportClause) {
        if (target) out.push(...collectExports(target, seen))
        continue
      }
      if (!ts.isNamedExports(stmt.exportClause)) continue
      for (const el of stmt.exportClause.elements) {
        if (el.isTypeOnly) continue
        const exported = el.name.text
        const original = el.propertyName?.text ?? exported
        if (target) {
          const found = findExport(target, original)
          if (found) out.push({ ...found, name: exported })
        } else {
          const local = locals.get(original)
          if (local && !local.isType) out.push({ name: exported, file, decl: local })
        }
      }
      continue
    }
    if (hasExportModifier(stmt)) {
      for (const decl of declarationsOf(stmt)) {
        if (!decl.isType) out.push({ name: decl.name, file, decl })
      }
    }
  }
  return out
}

function findExport(file: string, name: string): ResolvedExport | null {
  return collectExports(file, new Set()).find((e) => e.name === name) ?? null
}

// ── Classification ─────────────────────────────────────────────────────────

const COMPONENT_WRAPPERS = /^(forwardRef|memo|lazy|React\.forwardRef|React\.memo)\b/

export function classify(name: string, file: string, initializer?: ts.Expression): CatalogueKind {
  if (/^use[A-Z]/.test(name)) return 'hook'
  if (/^[A-Z][A-Z0-9_]+$/.test(name)) return 'constant'
  if (/^[A-Z]/.test(name)) {
    if (initializer && COMPONENT_WRAPPERS.test(initializer.getText())) return 'component'
    if (file.endsWith('.tsx')) {
      if (!initializer) return 'component'
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        return 'component'
      return 'constant'
    }
    return initializer ? 'constant' : 'function'
  }
  if (initializer && !(ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
    return 'constant'
  }
  return 'function'
}

/** The name of the type a component's props are declared with, if it names one. */
export function propsTypeName(decl: LocalDecl): string | null {
  const refName = (t: ts.TypeNode | undefined): string | null =>
    t && ts.isTypeReferenceNode(t) ? t.typeName.getText() : null
  const node = decl.node
  if (ts.isFunctionDeclaration(node)) return refName(node.parameters[0]?.type)
  const init = decl.initializer
  if (!init) return null
  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
    return refName(init.parameters[0]?.type)
  }
  // forwardRef<Element, Props>(…) / memo(function X(props: Props) …)
  if (ts.isCallExpression(init)) {
    const fromGeneric = refName(init.typeArguments?.[1])
    if (fromGeneric) return fromGeneric
    const inner = init.arguments[0]
    if (inner && (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner))) {
      return refName(inner.parameters[0]?.type)
    }
  }
  return null
}

function propsOf(
  file: string,
  name: string,
  decl: LocalDecl,
): { readonly props: CatalogueProp[]; readonly heritage: string[] } | null {
  const locals = localDeclarations(parse(file))
  const typeName = propsTypeName(decl) ?? `${name}Props`
  const found = locals.get(typeName) ?? locals.get(`${name}Props`)
  if (!found) return null
  if (ts.isTypeAliasDeclaration(found.node) && ts.isTypeLiteralNode(found.node.type)) {
    return { props: membersOf(found.node.type.members), heritage: [] }
  }
  return interfaceProps(found)
}

function membersOf(members: ts.NodeArray<ts.TypeElement>): CatalogueProp[] {
  const props: CatalogueProp[] = []
  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.name) continue
    const raw = member.type?.getText() ?? 'unknown'
    props.push({
      name: member.name.getText(),
      type: raw.replace(/\s+/g, ' ').slice(0, 90),
      optional: member.questionToken !== undefined,
      doc: summarize(jsDocText(member)).slice(0, 140),
    })
  }
  return props
}

function interfaceProps(
  decl: LocalDecl,
): { readonly props: CatalogueProp[]; readonly heritage: string[] } | null {
  if (!ts.isInterfaceDeclaration(decl.node)) return null
  const iface = decl.node
  const heritage = (iface.heritageClauses ?? []).flatMap((h) => h.types.map((t) => t.getText()))
  const props = membersOf(iface.members)
  return { props, heritage }
}

export function buildEntries(root: string): CatalogueEntry[] {
  parsed.clear()
  const barrel = path.join(root, LIBRARY_BARREL)
  const srcDir = path.dirname(barrel)
  const byName = new Map<string, CatalogueEntry>()
  for (const exp of collectExports(barrel)) {
    const relToSrc = path.relative(srcDir, exp.file)
    const area = relToSrc.includes(path.sep) ? relToSrc.split(path.sep)[0] : 'root'
    if (SKIPPED_AREAS.includes(area)) continue
    const kind = classify(exp.name, exp.file, exp.decl.initializer)
    const props = kind === 'component' ? propsOf(exp.file, exp.name, exp.decl) : null
    const entry: CatalogueEntry = {
      name: exp.name,
      kind,
      area,
      file: path.relative(root, exp.file).split(path.sep).join('/'),
      summary: summarize(jsDocText(exp.decl.node)) || fileSummary(exp.file),
      ...(props && props.heritage.length > 0 ? { propsExtends: props.heritage } : {}),
      ...(props ? { props: props.props } : {}),
    }
    if (!byName.has(exp.name)) byName.set(exp.name, entry)
  }
  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name))
}

/**
 * The viewer kit's components and hooks: every `.tsx` directly under
 * `camstack/src/components/ui` (no barrel there; helper `.ts` modules and
 * `__tests__` are not building blocks). Null when the submodule is not checked
 * out, so the caller can say so rather than silently list nothing.
 */
export function buildViewerEntries(root: string): CatalogueEntry[] | null {
  const dir = path.join(root, VIEWER_KIT_DIR)
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null
  parsed.clear()
  const byName = new Map<string, CatalogueEntry>()
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.tsx'))
    .toSorted()
  for (const f of files) {
    const file = path.join(dir, f)
    for (const exp of collectExports(file)) {
      const kind = classify(exp.name, exp.file, exp.decl.initializer)
      if (kind !== 'component' && kind !== 'hook') continue
      const props = kind === 'component' ? propsOf(exp.file, exp.name, exp.decl) : null
      const entry: CatalogueEntry = {
        name: exp.name,
        kind,
        area: 'viewer',
        file: path.relative(root, exp.file).split(path.sep).join('/'),
        summary: summarize(jsDocText(exp.decl.node)) || fileSummary(exp.file),
        ...(props && props.heritage.length > 0 ? { propsExtends: props.heritage } : {}),
        ...(props ? { props: props.props } : {}),
      }
      if (!byName.has(exp.name)) byName.set(exp.name, entry)
    }
  }
  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name))
}

// ── Need table ─────────────────────────────────────────────────────────────

/**
 * Rows of the FIRST markdown table in `need-x-use-y.md` whose header starts
 * with `| Need`. Cells are kept verbatim (backticks included) so a search
 * prints them as written.
 */
export function parseNeedTable(markdown: string): NeedRow[] {
  const lines = markdown.split('\n')
  const rows: NeedRow[] = []
  let inTable = false
  for (const line of lines) {
    if (/^\|\s*Need\s*\|/i.test(line)) {
      inTable = true
      continue
    }
    if (!inTable) continue
    if (/^\|\s*-/.test(line)) continue
    if (!line.startsWith('|')) {
      if (rows.length > 0) inTable = false
      continue
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim())
    rows.push({
      need: cells[0] ?? '',
      admin: cells[1] ?? '',
      viewer: cells[2] ?? '',
      notes: cells[3] ?? '',
    })
  }
  return rows
}

// ── Tokens ─────────────────────────────────────────────────────────────────

export function camelKey(cssName: string): string {
  return cssName.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

function declarationsIn(block: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim())
  return out
}

function blockAfter(css: string, selector: RegExp): string {
  const m = selector.exec(css)
  if (!m) return ''
  const start = css.indexOf('{', m.index)
  let depth = 0
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(start + 1, i)
    }
  }
  return ''
}

export function parseThemeCss(css: string): {
  readonly colors: ColorToken[]
  readonly radius: Record<string, string>
} {
  const theme = declarationsIn(blockAfter(css, /@theme\s*\{/))
  const light = declarationsIn(blockAfter(css, /^\.light\s*\{/m))
  const colors: ColorToken[] = []
  const radius: Record<string, string> = {}
  for (const [key, value] of theme) {
    if (key.startsWith('color-')) {
      const name = key.slice('color-'.length)
      colors.push({
        name,
        viewerKey: camelKey(name),
        dark: value,
        light: light.get(key) ?? null,
      })
    } else if (key.startsWith('radius-')) {
      radius[key.slice('radius-'.length)] = value
    }
  }
  return { colors, radius }
}

// ── Whole catalogue ────────────────────────────────────────────────────────

/**
 * `carriedViewer` is the viewer section already committed: used verbatim when
 * the submodule is absent, so a checkout without it regenerates the same bytes
 * (and the caller reports that the section was carried, not re-read).
 */
export function buildCatalogue(
  root: string,
  carriedViewer: readonly CatalogueEntry[] = [],
): UiCatalogue {
  const css = fs.readFileSync(path.join(root, THEME_CSS), 'utf8')
  const needPath = path.join(root, NEED_TABLE)
  const needs = fs.existsSync(needPath) ? parseNeedTable(fs.readFileSync(needPath, 'utf8')) : []
  const { colors, radius } = parseThemeCss(css)
  return {
    generatedBy: 'scripts/ui/gen-ui-catalogue.ts — do not edit; run `npm run ui:catalogue`',
    entries: buildEntries(root),
    viewerEntries: buildViewerEntries(root) ?? carriedViewer,
    needs,
    colors,
    radius,
  }
}

export type ViewerSource = 'indexed' | 'carried'

export interface RegeneratedCatalogue {
  readonly text: string
  readonly catalogue: UiCatalogue
  /** `carried`: the viewer submodule is absent, the committed section was kept as is. */
  readonly viewerSource: ViewerSource
  readonly current: string | null
}

/** Rebuild the catalogue for `root` against what is committed there. */
export function regenerateCatalogue(root: string): RegeneratedCatalogue {
  const file = path.join(root, CATALOGUE_PATH)
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  let carried: readonly CatalogueEntry[] = []
  if (current !== null) {
    try {
      carried = loadCatalogue(root).viewerEntries
    } catch {
      carried = []
    }
  }
  const catalogue = buildCatalogue(root, carried)
  const viewerSource: ViewerSource = buildViewerEntries(root) === null ? 'carried' : 'indexed'
  return { text: formatAsCommitted(renderCatalogue(catalogue)), catalogue, viewerSource, current }
}

/** The repository whose formatter config (`biome.json`) the committed file follows. */
const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

/**
 * The catalogue through the repo's own formatter, so what is generated is
 * byte-for-byte what `biome format` leaves — never a format finding, and never
 * a guess at biome's array-collapsing rules.
 */
function formatAsCommitted(text: string): string {
  return execFileSync(
    path.join(REPO_ROOT, 'node_modules/.bin/biome'),
    ['format', `--stdin-file-path=${CATALOGUE_PATH}`],
    { cwd: REPO_ROOT, input: text, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
}

export interface CatalogueDrift {
  readonly stale: boolean
  readonly viewerSource: ViewerSource
  readonly message: string
}

/** Is the committed catalogue what the sources produce? The one drift test. */
export function catalogueDrift(root: string): CatalogueDrift {
  const next = regenerateCatalogue(root)
  const stale = next.current !== next.text
  const count = next.catalogue.viewerEntries.length
  const viewerNote =
    next.viewerSource === 'carried'
      ? `viewer kit NOT re-read (camstack/ submodule absent; ${count} committed entries carried)`
      : `viewer kit indexed (${count} entries)`
  return {
    stale,
    viewerSource: next.viewerSource,
    message: stale
      ? `${CATALOGUE_PATH} is stale — run \`npm run ui:catalogue\` and commit it; ${viewerNote}`
      : `${CATALOGUE_PATH} is current; ${viewerNote}`,
  }
}

/**
 * Indented JSON in `UiCatalogue`'s field order; `regenerateCatalogue` then
 * passes it through the repo formatter, so a diff names the exports, needs or
 * tokens that changed and the committed file is never a format finding.
 */
export function renderCatalogue(catalogue: UiCatalogue): string {
  const ordered = {
    generatedBy: catalogue.generatedBy,
    radius: catalogue.radius,
    colors: catalogue.colors,
    needs: catalogue.needs,
    entries: catalogue.entries,
    viewerEntries: catalogue.viewerEntries,
  }
  return `${JSON.stringify(ordered, null, 2)}\n`
}

export function loadCatalogue(root: string): UiCatalogue {
  const file = path.join(root, CATALOGUE_PATH)
  const parsedJson: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (
    typeof parsedJson !== 'object' ||
    parsedJson === null ||
    !Array.isArray((parsedJson as { entries?: unknown }).entries)
  ) {
    throw new Error(`${CATALOGUE_PATH} is not a UI catalogue — run \`npm run ui:catalogue\``)
  }
  // JSON boundary: the file predates `viewerEntries`, so default it.
  const viewerEntries = (parsedJson as { viewerEntries?: unknown }).viewerEntries
  return {
    ...(parsedJson as UiCatalogue),
    viewerEntries: Array.isArray(viewerEntries) ? viewerEntries : [],
  }
}
