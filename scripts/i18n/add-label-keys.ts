/**
 * Codemod for the bulk label migration (D863): adds `labelKey` / `descriptionKey`
 * / `titleKey` next to the English `label` / `description` / `title` of every
 * settings-schema literal in the given files, and merges the English texts into
 * `<packageDir>/i18n/en.json`.
 *
 *   npx tsx scripts/i18n/add-label-keys.ts --ns reolink --pkg packages/addon-provider-reolink \
 *       src/creation-schema.ts src/email-push-schema.ts
 *
 * Paths after the flags are relative to `--pkg`. Then:
 *   1. translate the NEW keys it prints into `<pkg>/i18n/it.json` (same key set);
 *   2. run `npx vitest run scripts/i18n` (key-parity spec) and format the touched files.
 *
 * What it recognises (string literals, `'a' + 'b'` and no-substitution templates only):
 *   - section   `{ id, title, description? }`          -> titleKey, descriptionKey
 *   - field     `{ key, label, description? }`         -> labelKey, descriptionKey
 *   - option    `{ value, label }` inside a field      -> labelKey
 * Objects carrying an `icon` (tab declarations) are skipped. Re-running is
 * idempotent: an object that already has the key is left alone. A dynamic label
 * (template with `${}`, a variable) is reported and left English.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as ts from 'typescript'
import { z } from 'zod'

const CATALOG = z.record(z.string(), z.string())

const ROOT = path.resolve(import.meta.dirname, '..', '..')

export interface KeyInsertion {
  readonly pos: number
  readonly text: string
}

export interface CodemodResult {
  readonly source: string
  readonly added: Readonly<Record<string, string>>
  readonly dynamic: readonly string[]
}

function literalText(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isParenthesizedExpression(node)) return literalText(node.expression)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalText(node.left)
    const right = literalText(node.right)
    return left !== null && right !== null ? left + right : null
  }
  return null
}

function propName(p: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(p)) return null
  return ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null
}

function getProp(obj: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | null {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && propName(p) === name) return p
  }
  return null
}

function stringProp(obj: ts.ObjectLiteralExpression, name: string): string | null {
  const p = getProp(obj, name)
  return p === null ? null : literalText(p.initializer)
}

function enclosingTag(node: ts.Node, fallback: string): string {
  for (let cur: ts.Node | undefined = node; cur !== undefined; cur = cur.parent) {
    let name: string | undefined
    if (ts.isFunctionDeclaration(cur) && cur.name !== undefined) name = cur.name.text
    else if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) name = cur.name.text
    else if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) name = cur.name.text
    if (name !== undefined) {
      if (/^[A-Z0-9_]+$/.test(name)) {
        const lowered = name.replace(/_?(CONFIG_)?SCHEMA$/, '').toLowerCase()
        return lowered.length > 0 ? lowered : fallback
      }
      const stripped = name
        .replace(/^(build|get|make|create)/, '')
        .replace(/(FormSchema|Schema)$/, '')
      return stripped.length > 0 ? stripped.charAt(0).toLowerCase() + stripped.slice(1) : fallback
    }
  }
  return fallback
}

const SEGMENT = /[^A-Za-z0-9_-]+/g
const seg = (s: string): string => s.replace(SEGMENT, '_')

/**
 * `keyPrefix` replaces the enclosing-declaration segment of every key (`--prefix`
 * on the CLI). Two files of one package that reuse a section id (`connection`)
 * would otherwise write one key with two English texts.
 */
export function addLabelKeys(
  fileName: string,
  source: string,
  ns: string,
  keyPrefix?: string,
): CodemodResult {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const fallback = path
    .basename(fileName)
    .replace(/\.tsx?$/, '')
    .replace(/-schema$/, '')
  const insertions: KeyInsertion[] = []
  const added: Record<string, string> = {}
  const dynamic: string[] = []

  const indentOf = (node: ts.Node): string => {
    const start = node.getStart(sf)
    const lineStart = source.lastIndexOf('\n', start - 1) + 1
    return /^\s*/.exec(source.slice(lineStart, start))?.[0] ?? ''
  }

  const emit = (
    obj: ts.ObjectLiteralExpression,
    textProp: string,
    keyProp: string,
    id: string,
  ): void => {
    const target = getProp(obj, textProp)
    if (target === null || getProp(obj, keyProp) !== null) return
    const text = literalText(target.initializer)
    if (text === null) {
      dynamic.push(
        `${fileName}:${sf.getLineAndCharacterOfPosition(target.getStart(sf)).line + 1} ${textProp}`,
      )
      return
    }
    const multiline =
      source.slice(target.getStart(sf), target.end).includes('\n') ||
      /\n/.test(source.slice(obj.getStart(sf), obj.end))
    const ref = `${ns}:${id}`
    const sep = multiline ? `,\n${indentOf(target)}` : ', '
    const lastPropEnd = target.end
    insertions.push({ pos: lastPropEnd, text: `${sep}${keyProp}: '${ref.replace(/'/g, "\\'")}'` })
    added[id] = text
  }

  const visit = (node: ts.Node, trail: readonly string[]): void => {
    let next = trail
    // `mapOption: { value: 'id', label: 'name' }` names the FIELDS of an action's
    // result rows; its `label` is a key, not a text, so it is never translated.
    const isMapOption =
      ts.isObjectLiteralExpression(node) &&
      node.parent !== undefined &&
      ts.isPropertyAssignment(node.parent) &&
      propName(node.parent) === 'mapOption'
    if (ts.isObjectLiteralExpression(node) && getProp(node, 'icon') === null && !isMapOption) {
      const tag = trail.length === 0 ? (keyPrefix ?? enclosingTag(node, fallback)) : null
      const base = trail.length === 0 && tag !== null ? [tag] : trail
      const id = stringProp(node, 'id')
      const key = stringProp(node, 'key')
      const value = stringProp(node, 'value')
      if (id !== null && getProp(node, 'title') !== null) {
        next = [...base, `s_${seg(id)}`]
        emit(node, 'title', 'titleKey', `${next.join('.')}.title`)
        emit(node, 'description', 'descriptionKey', `${next.join('.')}.description`)
      } else if (key !== null && getProp(node, 'label') !== null) {
        next = [...base, seg(key)]
        emit(node, 'label', 'labelKey', `${next.join('.')}.label`)
        emit(node, 'description', 'descriptionKey', `${next.join('.')}.description`)
      } else if (value !== null && getProp(node, 'label') !== null && trail.length > 0) {
        next = [...trail, `o_${seg(value)}`]
        emit(node, 'label', 'labelKey', `${next.join('.')}.label`)
      } else {
        next = base
      }
    }
    ts.forEachChild(node, (child) => visit(child, next))
  }
  visit(sf, [])

  let out = source
  for (const ins of [...insertions].sort((a, b) => b.pos - a.pos)) {
    out = out.slice(0, ins.pos) + ins.text + out.slice(ins.pos)
  }
  return { source: out, added, dynamic }
}

function readJson(file: string): Record<string, string> {
  try {
    return CATALOG.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return {}
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const flag = (name: string): string => {
    const i = args.indexOf(name)
    const v = i >= 0 ? args[i + 1] : undefined
    if (v === undefined) throw new Error(`missing ${name}`)
    return v
  }
  const ns = flag('--ns')
  const prefix = args.includes('--prefix') ? flag('--prefix') : undefined
  const pkg = path.resolve(ROOT, flag('--pkg'))
  const files = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
  // `--catalog-dir` lands the keys in another catalog directory (the `server`
  // namespace lives in packages/system/src/i18n, not in an `i18n/` folder).
  const catalogDir = args.includes('--catalog-dir')
    ? path.resolve(ROOT, flag('--catalog-dir'))
    : path.join(pkg, 'i18n')
  const enFile = path.join(catalogDir, 'en.json')
  const itFile = path.join(catalogDir, 'it.json')
  const en = readJson(enFile)
  const it = readJson(itFile)
  const fresh: string[] = []
  for (const rel of files) {
    const file = path.join(pkg, rel)
    const result = addLabelKeys(file, fs.readFileSync(file, 'utf8'), ns, prefix)
    if (result.source !== fs.readFileSync(file, 'utf8')) fs.writeFileSync(file, result.source)
    for (const [id, text] of Object.entries(result.added)) {
      if (en[id] !== undefined && en[id] !== text) throw new Error(`key collision: ${id}`)
      if (en[id] === undefined) fresh.push(id)
      en[id] = text
    }
    for (const d of result.dynamic) console.log(`DYNAMIC (left English): ${d}`)
  }
  fs.mkdirSync(path.dirname(enFile), { recursive: true })
  fs.writeFileSync(enFile, JSON.stringify(en, null, 2) + '\n')
  if (!fs.existsSync(itFile)) fs.writeFileSync(itFile, '{}\n')
  const missing = Object.keys(en).filter((k) => it[k] === undefined)
  console.log(`new keys: ${fresh.length}; untranslated in it.json: ${missing.length}`)
  for (const k of missing) console.log(`  ${k} = ${JSON.stringify(en[k])}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
