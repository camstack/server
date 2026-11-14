#!/usr/bin/env tsx
/**
 * The device type `hub` is gone. A stored row with that type is unknown; it is
 * not aliased to Gateway. This guard refuses the enum member, a device-type
 * set that still lists it beside another device type (`nvr`, `camera`, …), and
 * a comparison of a device's type to `'hub'`.
 *
 * It does not flag the node id `'hub'`, `DeclarationPlacement`, `HUB_NODE_ID`,
 * `migrations/hub/`, `isHubIntegration`, `migratedFromHubDeviceId`, or icon
 * catalog synonyms.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Split so this file does not contain the token it refuses. */
const DEVICE_TYPE_HUB = new RegExp('\\bDevice' + 'Type\\.Hub\\b')
const ENUM_MEMBER = /\bHub\s*=\s*['"]hub['"]/
const DEVICE_TYPE_CMP =
  /\b(?:device|row|parent|saved)\.type\s*[!=]==\s*['"]hub['"]|\bparentType\s*[!=]==\s*['"]hub['"]/
const SET_OPEN = new RegExp('new Se' + 't(?:<[^>\\n]*>)?\\(')

/** Other stored device types. A set that lists `'hub'` next to one of these is the device type. */
const DEVICE_TYPE_SIBLINGS: ReadonlySet<string> = new Set([
  'camera',
  'light',
  'siren',
  'switch',
  'sensor',
  'climate',
  'nvr',
  'gateway',
  'container',
  'fan',
  'lock',
  'cover',
  'button',
  'generic',
])

const SKIP_DIRS = new Set(['dist', 'node_modules', '.git', 'coverage', '__tests__', '__mocks__'])
const SOURCE_RE = /\.(?:ts|tsx)$/
const NON_RUNTIME_RE = /\.(?:spec|test)\.(?:ts|tsx)$/

export interface HubDeviceTypeFinding {
  readonly file: string
  readonly line: number
  readonly text: string
}

export interface HubDeviceTypeSource {
  readonly rel: string
  readonly content: string
}

function isCommentLine(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

function excluded(rel: string): boolean {
  return rel.includes('/migrations/hub/') || rel.endsWith('/icon-catalog.generated.ts')
}

function quotedTokens(text: string): readonly string[] {
  const found: string[] = []
  const pattern = /['"]([a-z0-9-]+)['"]/g
  for (const match of text.matchAll(pattern)) {
    const token = match[1]
    if (token !== undefined) found.push(token)
  }
  return found
}

function setListsHubDeviceType(text: string): boolean {
  const tokens = quotedTokens(text)
  const others = tokens.filter((token) => token !== 'hub')
  if (!tokens.includes('hub') || others.length === 0) return false
  return others.every((token) => DEVICE_TYPE_SIBLINGS.has(token))
}

function scanSets(lines: readonly string[], rel: string, findings: HubDeviceTypeFinding[]): void {
  let buf = ''
  let start = 0
  let depth = 0
  let open = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    const text = isCommentLine(raw) ? '' : raw
    if (!open) {
      const at = SET_OPEN.exec(text)
      if (at === null || at.index === undefined) continue
      open = true
      start = i
      buf = ''
      depth = 0
      const from = at.index + at[0].length - 1
      buf += text.slice(from) + '\n'
      for (const ch of text.slice(from)) {
        if (ch === '(') depth += 1
        else if (ch === ')') depth -= 1
      }
    } else {
      buf += text + '\n'
      for (const ch of text) {
        if (ch === '(') depth += 1
        else if (ch === ')') depth -= 1
      }
    }
    if (open && depth <= 0) {
      if (setListsHubDeviceType(buf)) {
        findings.push({ file: rel, line: start + 1, text: (lines[start] ?? '').trim() })
      }
      open = false
      buf = ''
      depth = 0
    }
  }
}

export function findHubDeviceTypeUses(
  files: readonly HubDeviceTypeSource[],
): HubDeviceTypeFinding[] {
  const findings: HubDeviceTypeFinding[] = []
  for (const { rel, content } of files) {
    if (excluded(rel)) continue
    const lines = content.split('\n')
    for (const [i, text] of lines.entries()) {
      if (isCommentLine(text)) continue
      if (DEVICE_TYPE_HUB.test(text) || ENUM_MEMBER.test(text) || DEVICE_TYPE_CMP.test(text)) {
        findings.push({ file: rel, line: i + 1, text: text.trim() })
      }
    }
    scanSets(lines, rel, findings)
  }
  return findings
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
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (dir.endsWith(`${path.sep}migrations`) && name === 'hub') continue
      walk(full, out)
    } else if (SOURCE_RE.test(name) && !NON_RUNTIME_RE.test(name)) out.push(full)
  }
}

function runtimeRoots(): string[] {
  const roots = [path.join(ROOT, 'server/backend/src'), path.join(ROOT, 'scripts')]
  for (const pkg of readdirSync(path.join(ROOT, 'packages'))) {
    roots.push(path.join(ROOT, 'packages', pkg, 'src'))
  }
  return roots
}

function main(): void {
  const paths: string[] = []
  for (const root of runtimeRoots()) walk(root, paths)
  const files = paths.map((p) => ({
    rel: path.relative(ROOT, p).split(path.sep).join('/'),
    content: readFileSync(p, 'utf-8'),
  }))
  const findings = findHubDeviceTypeUses(files)
  if (findings.length === 0) {
    console.log(`check-no-hub-device-type: ${files.length} runtime files, no hub device type`)
    return
  }
  console.error(
    'check-no-hub-device-type: the hub device type is gone. Do not restore the enum member, ' +
      "a device-type set that lists 'hub', or a comparison of a device type to 'hub':",
  )
  for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.text}`)
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
