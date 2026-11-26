#!/usr/bin/env tsx
/**
 * An editable settings surface writes only on an explicit Save (planning#675).
 *
 * What it checks: in every UI `.tsx` (every `.tsx` under `packages/<pkg>/src`,
 * which covers `ui-library`, `addon-admin-ui` and the addon pages; specs
 * excluded) an `onBlur` / `onChange` / `onInput` / `onCheckedChange` /
 * `onValueChange` JSX handler must not reach a mutation. A mutation is:
 *   - a `mutate(` / `mutateAsync(` call, bare or on any object (a bare name
 *     that is a parameter of an enclosing function is a local callback, not a
 *     mutation);
 *   - a destructured or aliased one, `const { mutate: save } = useFoo()`;
 *   - a call of the result of a save-shaped hook,
 *     `const save = useQuickDetailSave()` -> `save(v)`: any `use\w*(Save|Mutation)\w*`
 *     (today `useQuickDetailSave`, `useTemplateSave`, `useSaveBootstrapForm`,
 *     `usePtzSavePreset`, `useCameraGridLayoutSaveLayout`,
 *     `usePipelineAnalyticsSaveRetrainAnnotations`, `useSetTrackFlagsMutation`,
 *     `useDeleteTracksMutation`, `useSystemMutation`; not `useFormSaveController`,
 *     which is the draft controller).
 * The handler is the inline function, or the same-file function it names;
 * calls inside it to other same-file functions are followed.
 *
 * What it does NOT see: a row toggle wired through `onClick` or a prop
 * callback, a handler imported from another file, a write through
 * `useDeviceCommand` / a one-shot command hook. Those are covered by review.
 *
 * Why a script beside `ui:check`: its `commit-on-blur` rule (a per-file regex
 * in `scripts/ui/lib/ui-check.ts`, onBlur only, no way to record a reviewed
 * exception) stays as the fast per-file hint; this guard parses with the
 * TypeScript API and compares every hit with
 * `scripts/ui-save-discard-allowlist.json`.
 *
 * The allowlist: each entry is `file` + `anchor`
 * (`<enclosing function>/<attribute>/<handler|inline>#<n>`, line-free so it
 * survives edits) + `reason`, one of `live control`, `one-shot`,
 * `documented instant`, or `known violation — planning#675 sweep`. A hit with
 * no entry fails; an entry with no hit (fixed, renamed, moved) fails as stale
 * — delete it. A `live control` / `documented instant` entry also needs a
 * `// save-discard: <reason>` comment on the handler's line or up to 3 lines
 * above it. New code uses `FormSaveBar`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ALLOWLIST_PATH = path.join(ROOT, 'scripts', 'ui-save-discard-allowlist.json')

export const ALLOWED_REASONS = [
  'live control',
  'one-shot',
  'documented instant',
  'known violation — planning#675 sweep',
] as const

export interface AllowEntry {
  readonly file: string
  readonly anchor: string
  readonly reason: string
}

export interface SourceFile {
  readonly path: string
  readonly text: string
}

export interface Hit {
  readonly file: string
  readonly anchor: string
  readonly line: number
  /** A `// save-discard: <reason>` comment sits on the handler's line or just above it. */
  readonly marker: boolean
}

export interface Verdict {
  readonly unlisted: readonly Hit[]
  readonly stale: readonly AllowEntry[]
  readonly badReasons: readonly AllowEntry[]
  /** `live control` / `documented instant` entries whose handler has no `// save-discard:` comment. */
  readonly missingMarker: readonly AllowEntry[]
}

const HANDLER_ATTRS = new Set(['onBlur', 'onChange', 'onInput', 'onCheckedChange', 'onValueChange'])
const MUTATION_NAMES = new Set(['mutate', 'mutateAsync'])
/** A hook whose RESULT is a write: `useQuickDetailSave`, `useTemplateSave`, `useSaveBootstrapForm`, `useSetTrackFlagsMutation`, `useSystemMutation`, … (`useFormSaveController` is the draft controller, not a write). */
const SAVE_HOOK = /^use\w*(?:Save|Mutation)\w*$/
const NOT_A_WRITE_HOOK = new Set(['useFormSaveController'])
/** Reasons that claim the handler is allowed to act at once; the source must say so next to it. */
export const MARKER_REASONS: readonly string[] = ['live control', 'documented instant']
const MARKER = /(?:\/\/|\/\*)\s*save-discard:\s*\S/
const MARKER_LINES_ABOVE = 3
const SKIP_DIRS = new Set(['dist', 'node_modules', '.git', 'coverage', 'generated', '__tests__'])
const MAX_FOLLOW_DEPTH = 4

export function isUiSource(rel: string): boolean {
  return (
    /^packages\/[^/]+\/src\//.test(rel) &&
    rel.endsWith('.tsx') &&
    !/\.(?:spec|test)\.tsx$/.test(rel)
  )
}

type FnNode = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration

function isFn(node: ts.Node): node is FnNode {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)
}

function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return e.name.text
  return undefined
}

function unwrapCallback(init: ts.Expression): FnNode | undefined {
  if (isFn(init)) return init
  if (ts.isCallExpression(init) && calleeName(init) === 'useCallback') {
    const first = init.arguments[0]
    if (first !== undefined && isFn(first)) return first
  }
  return undefined
}

interface FileIndex {
  readonly functions: Map<string, FnNode>
  readonly mutationVars: Set<string>
}

function indexFile(sf: ts.SourceFile): FileIndex {
  const functions = new Map<string, FnNode>()
  const mutationVars = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
      functions.set(node.name.text, node)
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isObjectBindingPattern(node.name) &&
      ts.isCallExpression(node.initializer)
    ) {
      const callee = calleeName(node.initializer)
      if (callee !== undefined && callee.startsWith('use')) {
        for (const el of node.name.elements) {
          const source = el.propertyName ?? el.name
          if (
            ts.isIdentifier(source) &&
            ts.isIdentifier(el.name) &&
            MUTATION_NAMES.has(source.text)
          ) {
            mutationVars.add(el.name.text)
          }
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isIdentifier(node.name)
    ) {
      const fn = unwrapCallback(node.initializer)
      if (fn !== undefined) functions.set(node.name.text, fn)
      if (ts.isCallExpression(node.initializer)) {
        const callee = calleeName(node.initializer)
        if (callee !== undefined && SAVE_HOOK.test(callee) && !NOT_A_WRITE_HOOK.has(callee)) {
          mutationVars.add(node.name.text)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { functions, mutationVars }
}

/** Is `name` a parameter of a function enclosing `node`? Then a bare call of it is a local callback. */
function isShadowedByParameter(node: ts.Node, name: string): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur !== undefined; cur = cur.parent) {
    if (isFn(cur) && cur.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name)) {
      return true
    }
  }
  return false
}

function reachesMutation(
  root: ts.Node,
  index: FileIndex,
  visited: Set<ts.Node>,
  depth: number,
): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(node)) {
      const name = calleeName(node)
      if (name !== undefined) {
        if (
          MUTATION_NAMES.has(name) &&
          !(ts.isIdentifier(node.expression) && isShadowedByParameter(node, name))
        ) {
          found = true
          return
        }
        if (ts.isIdentifier(node.expression)) {
          if (index.mutationVars.has(name) && !isShadowedByParameter(node, name)) {
            found = true
            return
          }
          const target = index.functions.get(name)
          if (target !== undefined && depth < MAX_FOLLOW_DEPTH && !visited.has(target)) {
            visited.add(target)
            if (reachesMutation(target, index, visited, depth + 1)) {
              found = true
              return
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

function enclosingName(node: ts.Node): string {
  for (let cur: ts.Node | undefined = node.parent; cur !== undefined; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) && cur.name !== undefined) return cur.name.text
    if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text
    if (
      ts.isVariableDeclaration(cur) &&
      ts.isIdentifier(cur.name) &&
      cur.initializer !== undefined
    ) {
      return cur.name.text
    }
  }
  return '<module>'
}

export function findHits(files: readonly SourceFile[]): Hit[] {
  const hits: Hit[] = []
  for (const { path: rel, text } of files) {
    if (!isUiSource(rel)) continue
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const index = indexFile(sf)
    const ordinals = new Map<string, number>()
    const visit = (node: ts.Node): void => {
      if (
        ts.isJsxAttribute(node) &&
        ts.isIdentifier(node.name) &&
        HANDLER_ATTRS.has(node.name.text) &&
        node.initializer !== undefined &&
        ts.isJsxExpression(node.initializer) &&
        node.initializer.expression !== undefined
      ) {
        const attr = node.name.text
        const expr = node.initializer.expression
        let label = 'inline'
        let hit = false
        if (isFn(expr)) {
          hit = reachesMutation(expr, index, new Set<ts.Node>([expr]), 0)
        } else if (ts.isIdentifier(expr)) {
          label = expr.text
          const target = index.functions.get(expr.text)
          hit =
            target !== undefined && reachesMutation(target, index, new Set<ts.Node>([target]), 0)
        } else {
          hit = reachesMutation(expr, index, new Set<ts.Node>(), 0)
        }
        if (hit) {
          const key = `${enclosingName(node)}/${attr}/${label}`
          const n = (ordinals.get(key) ?? 0) + 1
          ordinals.set(key, n)
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
          const lines = text.split('\n')
          const window = lines.slice(Math.max(0, line - 1 - MARKER_LINES_ABOVE), line).join('\n')
          hits.push({ file: rel, anchor: `${key}#${n}`, line, marker: MARKER.test(window) })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return hits
}

export function judge(hits: readonly Hit[], allowlist: readonly AllowEntry[]): Verdict {
  const keyOf = (file: string, anchor: string): string => `${file}\u0000${anchor}`
  const allowed = new Set(allowlist.map((e) => keyOf(e.file, e.anchor)))
  const seen = new Set(hits.map((h) => keyOf(h.file, h.anchor)))
  const reasons: readonly string[] = ALLOWED_REASONS
  return {
    unlisted: hits.filter((h) => !allowed.has(keyOf(h.file, h.anchor))),
    stale: allowlist.filter((e) => !seen.has(keyOf(e.file, e.anchor))),
    badReasons: allowlist.filter((e) => !reasons.includes(e.reason)),
    missingMarker: allowlist.filter(
      (e) =>
        MARKER_REASONS.includes(e.reason) &&
        hits.some((h) => keyOf(h.file, h.anchor) === keyOf(e.file, e.anchor) && !h.marker),
    ),
  }
}

function walk(dir: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith('.tsx')) out.push(full)
  }
}

export function loadFiles(): SourceFile[] {
  const paths: string[] = []
  for (const pkg of readdirSync(path.join(ROOT, 'packages'))) {
    walk(path.join(ROOT, 'packages', pkg, 'src'), paths)
  }
  return paths
    .map((p) => path.relative(ROOT, p).split(path.sep).join('/'))
    .filter(isUiSource)
    .map((rel) => ({ path: rel, text: readFileSync(path.join(ROOT, rel), 'utf-8') }))
}

function parseAllowlist(raw: string): AllowEntry[] {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('ui-save-discard-allowlist.json must be an array')
  return parsed.map((e: unknown): AllowEntry => {
    if (typeof e !== 'object' || e === null) throw new Error('allowlist entry must be an object')
    const { file, anchor, reason } = e as Record<string, unknown>
    if (typeof file !== 'string' || typeof anchor !== 'string' || typeof reason !== 'string') {
      throw new Error('allowlist entry needs string file, anchor, reason')
    }
    return { file, anchor, reason }
  })
}

function main(): void {
  const files = loadFiles()
  const hits = findHits(files)
  if (process.argv.includes('--print')) {
    console.log(JSON.stringify(hits, null, 2))
    return
  }
  const allowlist = parseAllowlist(readFileSync(ALLOWLIST_PATH, 'utf-8'))
  const v = judge(hits, allowlist)
  if (v.unlisted.length + v.stale.length + v.badReasons.length + v.missingMarker.length === 0) {
    console.log(
      `check-ui-save-discard: ${files.length} UI files, ${hits.length} mutation-on-edit handlers, all in the allowlist`,
    )
    return
  }
  if (v.unlisted.length > 0) {
    console.error(
      'check-ui-save-discard: an edit handler (onBlur / onChange / onCheckedChange / onValueChange) ' +
        'fires a mutation. An editable surface keeps a draft and writes on Save (FormSaveBar, planning#675); ' +
        'a live device control or one-shot action is added to scripts/ui-save-discard-allowlist.json with its reason:',
    )
    for (const h of v.unlisted) console.error(`  ${h.file}:${h.line}  ${h.anchor}`)
  }
  if (v.stale.length > 0) {
    console.error(
      'check-ui-save-discard: stale allowlist entries (no such handler any more) — delete them:',
    )
    for (const e of v.stale) console.error(`  ${e.file}  ${e.anchor}`)
  }
  if (v.badReasons.length > 0) {
    console.error(`check-ui-save-discard: reason must be one of: ${ALLOWED_REASONS.join(' | ')}`)
    for (const e of v.badReasons) console.error(`  ${e.file}  ${e.anchor}  "${e.reason}"`)
  }
  if (v.missingMarker.length > 0) {
    console.error(
      'check-ui-save-discard: a "live control" / "documented instant" entry needs a `// save-discard: <reason>` comment on or just above the handler:',
    )
    for (const e of v.missingMarker) console.error(`  ${e.file}  ${e.anchor}`)
  }
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
