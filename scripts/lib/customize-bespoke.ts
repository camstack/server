/**
 * A declared customize target is rendered by the generic cards
 * (`customize/scalar`, `customize/keyed`, `customize/event`) and compiled under
 * `composition/customize`. A component or builder named after that cap anywhere
 * else is a second card (D936).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const GENERIC_MARKERS = [
  'components/device/customize/scalar/',
  'components/device/customize/keyed/',
  'components/device/customize/event/',
  'packages/types/src/composition/customize/',
] as const

const SCAN_ROOTS = [
  'packages/addon-admin-ui/src/components/device/customize',
  'packages/types/src/composition',
  'packages/types/src/running-state',
] as const

const ROLE = 'Assignment|Preset|Card|Builder|CompositionFeature'

export interface BespokeHit {
  readonly path: string
  readonly cap: string
  readonly message: string
}

export interface SourceFile {
  readonly path: string
  readonly text: string
}

export function isGenericCustomizePath(filePath: string): boolean {
  const normalized = filePath.split(path.sep).join('/')
  return GENERIC_MARKERS.some((marker) => normalized.includes(marker))
}

function pascal(cap: string): string {
  return cap
    .split('-')
    .map((part) => (part.length === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('')
}

function nameTokens(cap: string): readonly string[] {
  const full = pascal(cap)
  const camel = full.length === 0 ? full : full.charAt(0).toLowerCase() + full.slice(1)
  const first = cap.split('-')[0] ?? cap
  return [...new Set([cap, full, camel, first, pascal(first)])]
}

function tokenPattern(caps: readonly string[]): string {
  return caps
    .flatMap((cap) => nameTokens(cap))
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
}

export function bespokeCustomizeHits(
  files: readonly SourceFile[],
  caps: readonly string[],
): readonly BespokeHit[] {
  if (caps.length === 0) return []
  const tokens = tokenPattern(caps)
  const symbol = new RegExp(
    `\\b(?:function|const|class)\\s+(?:is|build)?(?:${tokens})(?:${ROLE})\\w*\\b`,
  )
  const fileName = new RegExp(`(?:${tokens})[-_.]?(?:assignment|preset|card)`, 'i')
  const hits: BespokeHit[] = []
  for (const file of files) {
    if (isGenericCustomizePath(file.path)) continue
    const base = path.basename(file.path)
    const named = fileName.exec(base)
    if (named !== null) {
      hits.push({
        path: file.path,
        cap: capOf(named[0], caps),
        message: `bespoke file name "${base}"`,
      })
    }
    const found = symbol.exec(file.text)
    if (found !== null) {
      hits.push({
        path: file.path,
        cap: capOf(found[0], caps),
        message: `bespoke builder "${found[0].trim()}"`,
      })
    }
  }
  return hits
}

function capOf(text: string, caps: readonly string[]): string {
  const lower = text.toLowerCase()
  const found = caps.find((cap) =>
    nameTokens(cap).some((token) => lower.includes(token.toLowerCase())),
  )
  return found ?? caps[0] ?? ''
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = path.join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      walk(full, out)
      continue
    }
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full)
  }
}

export function scanCustomizeSources(repoRoot: string): readonly SourceFile[] {
  const files: string[] = []
  for (const root of SCAN_ROOTS) {
    const dir = path.join(repoRoot, root)
    if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir, files)
  }
  return files.map((file) => ({
    path: path.relative(repoRoot, file),
    text: readFileSync(file, 'utf8'),
  }))
}
