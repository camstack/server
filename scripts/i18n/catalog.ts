/**
 * Nested i18n catalogs (`en.json` / `it.json`) addressed by a dotted key.
 * Existing key order is kept: a new key is appended to its parent, a replaced
 * key stays where it was. Bytes are `JSON.stringify(_, null, 2) + "\\n"`,
 * which is what the catalogs already round-trip to.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'

const SEGMENT = /^[A-Za-z0-9_-]+$/
const PLACEHOLDER = /\{(\w+)\}/g

export class CatalogCliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CatalogCliError'
  }
}

export interface CatalogObject {
  readonly [key: string]: CatalogNode
}

export type CatalogNode = string | CatalogObject

export interface CatalogPair {
  readonly en: CatalogObject
  readonly it: CatalogObject
}

const catalogNodeSchema: z.ZodType<CatalogNode> = z.lazy(() =>
  z.union([z.string(), z.record(z.string(), catalogNodeSchema)]),
)

type Lookup =
  | { readonly kind: 'missing' }
  | { readonly kind: 'string' }
  | { readonly kind: 'object' }
  | { readonly kind: 'cross' }

function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text)
  return value
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error'
}

export function formatCatalog(node: CatalogNode): string {
  return `${JSON.stringify(node, null, 2)}\n`
}

export function splitKey(key: string): readonly string[] {
  if (key.length === 0) throw new CatalogCliError('empty key')
  const parts = key.split('.')
  for (const part of parts) {
    if (!SEGMENT.test(part))
      throw new CatalogCliError(`invalid key segment: ${JSON.stringify(part)}`)
  }
  return parts
}

export function placeholderNames(text: string): readonly string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '').sort()
}

function lookup(node: CatalogNode, segments: readonly string[]): Lookup {
  let current: CatalogNode = node
  for (const segment of segments) {
    if (typeof current === 'string') return { kind: 'cross' }
    if (!Object.hasOwn(current, segment)) return { kind: 'missing' }
    const next = current[segment]
    if (next === undefined) return { kind: 'missing' }
    current = next
  }
  return typeof current === 'string' ? { kind: 'string' } : { kind: 'object' }
}

function assertWritable(
  node: CatalogNode,
  segments: readonly string[],
  key: string,
  force: boolean,
): void {
  const found = lookup(node, segments)
  if (found.kind === 'cross') throw new CatalogCliError(`path crosses a string value: ${key}`)
  if (found.kind === 'object') throw new CatalogCliError(`key is an object: ${key}`)
  if (found.kind === 'string' && !force) {
    throw new CatalogCliError(`key already exists: ${key} (pass --force to replace)`)
  }
}

function assertPlaceholders(enText: string, itText: string): void {
  const en = placeholderNames(enText).join(',')
  const it = placeholderNames(itText).join(',')
  if (en !== it) {
    throw new CatalogCliError(
      `placeholders differ between en (${en || 'none'}) and it (${it || 'none'})`,
    )
  }
}

function setAt(node: CatalogNode, segments: readonly string[], value: string): CatalogNode {
  const head = segments[0]
  if (head === undefined) throw new CatalogCliError('empty key')
  if (typeof node === 'string') throw new CatalogCliError('path crosses a string value')
  const rest = segments.slice(1)
  if (rest.length === 0) return { ...node, [head]: value }
  const current = node[head]
  if (typeof current === 'string') throw new CatalogCliError('path crosses a string value')
  const child: CatalogNode = current ?? {}
  return { ...node, [head]: setAt(child, rest, value) }
}

function asObject(node: CatalogNode, label: string): CatalogObject {
  if (typeof node === 'string') throw new CatalogCliError(`${label} catalog root must be an object`)
  return node
}

/** Insert or replace `key` in both catalogs. Does not mutate `pair`. */
export function setKey(
  pair: CatalogPair,
  key: string,
  enText: string,
  itText: string,
  force: boolean,
): CatalogPair {
  assertPlaceholders(enText, itText)
  const segments = splitKey(key)
  assertWritable(pair.en, segments, key, force)
  assertWritable(pair.it, segments, key, force)
  return {
    en: asObject(setAt(pair.en, segments, enText), 'en'),
    it: asObject(setAt(pair.it, segments, itText), 'it'),
  }
}

export function getString(node: CatalogNode, key: string): string | undefined {
  const found = lookup(node, splitKey(key))
  if (found.kind === 'cross') throw new CatalogCliError(`path crosses a string value: ${key}`)
  if (found.kind === 'object') throw new CatalogCliError(`key is an object: ${key}`)
  if (found.kind === 'missing') return undefined
  return readString(node, splitKey(key))
}

function readString(node: CatalogNode, segments: readonly string[]): string {
  let current: CatalogNode = node
  for (const segment of segments) {
    if (typeof current === 'string') throw new CatalogCliError('path crosses a string value')
    const next = current[segment]
    if (next === undefined) throw new CatalogCliError('missing key')
    current = next
  }
  if (typeof current !== 'string') throw new CatalogCliError('key is an object')
  return current
}

export function listKeys(node: CatalogNode, prefix: string): readonly string[] {
  const segments = prefix.length === 0 ? [] : splitKey(prefix)
  const start = descend(node, segments)
  if (start === undefined) return []
  const out: string[] = []
  collect(start, prefix, out)
  return out
}

function descend(node: CatalogNode, segments: readonly string[]): CatalogNode | undefined {
  let current: CatalogNode = node
  for (const segment of segments) {
    if (typeof current === 'string') return undefined
    const next = current[segment]
    if (next === undefined) return undefined
    current = next
  }
  return current
}

function collect(node: CatalogNode, path: string, out: string[]): void {
  if (typeof node === 'string') {
    if (path.length > 0) out.push(path)
    return
  }
  for (const [key, value] of Object.entries(node)) {
    const next = path.length === 0 ? key : `${path}.${key}`
    collect(value, next, out)
  }
}

export function readCatalog(file: string): CatalogNode {
  let parsed: unknown
  try {
    parsed = parseJson(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new CatalogCliError(`invalid JSON in ${file}: ${messageOf(err)}`)
  }
  const result = catalogNodeSchema.safeParse(parsed)
  if (!result.success) throw new CatalogCliError(`catalog ${file} is not a string tree`)
  return result.data
}

function catalogCandidates(dir: string): readonly string[] {
  return [dir, path.join(dir, 'i18n'), path.join(dir, 'src', 'i18n')]
}

function packageRoots(root: string, pkg: string): readonly string[] {
  if (pkg.includes('/') || path.isAbsolute(pkg)) {
    return [path.isAbsolute(pkg) ? pkg : path.join(root, pkg)]
  }
  const names = pkg.startsWith('addon-') ? [pkg] : [pkg, `addon-${pkg}`]
  return names.map((name) => path.join(root, 'packages', name))
}

/** The directory that holds `en.json` and `it.json`. Default package: admin-ui. */
export function resolveCatalogDir(root: string, pkg: string | undefined): string {
  const name = pkg ?? 'admin-ui'
  const found: string[] = []
  for (const packageRoot of packageRoots(root, name)) {
    for (const dir of catalogCandidates(packageRoot)) {
      if (fs.existsSync(path.join(dir, 'en.json'))) found.push(dir)
    }
  }
  const unique = [...new Set(found)]
  if (unique.length === 0) throw new CatalogCliError(`no i18n catalog for ${name}`)
  if (unique.length > 1) {
    const listed = unique.map((dir) => path.relative(root, dir)).join(', ')
    throw new CatalogCliError(
      `more than one i18n catalog for ${name}: ${listed} — pass the catalog directory as --pkg`,
    )
  }
  const dir = unique[0]
  if (dir === undefined) throw new CatalogCliError(`no i18n catalog for ${name}`)
  if (!fs.existsSync(path.join(dir, 'it.json')))
    throw new CatalogCliError(`missing it.json in ${dir}`)
  return dir
}

export function readPair(dir: string): CatalogPair {
  return {
    en: asObject(readCatalog(path.join(dir, 'en.json')), 'en'),
    it: asObject(readCatalog(path.join(dir, 'it.json')), 'it'),
  }
}

function writeText(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text)
  try {
    fs.renameSync(tmp, file)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

/** Write both catalogs. If `it.json` fails, restore the previous `en.json` bytes. */
export function writePair(dir: string, next: CatalogPair, previousEn: string): void {
  const enFile = path.join(dir, 'en.json')
  const itFile = path.join(dir, 'it.json')
  writeText(enFile, formatCatalog(next.en))
  try {
    writeText(itFile, formatCatalog(next.it))
  } catch (err) {
    writeText(enFile, previousEn)
    throw new CatalogCliError(`failed to write ${itFile}: ${messageOf(err)}`)
  }
}
