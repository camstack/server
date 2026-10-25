#!/usr/bin/env tsx
/**
 * Third-party product names — name the mechanism.
 *
 * Competing products and marketing names do not belong in the tree. A stored
 * provider id, an upstream artifact id, a URL, a licence URL and the
 * restreamer binary this repo actually downloads are the keep list.
 *
 * Run: npx tsx scripts/check-no-third-party-products.ts
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const SKIP_FILES: ReadonlySet<string> = new Set([
  'scripts/check-no-third-party-products.ts',
  'scripts/__tests__/check-no-third-party-products.spec.ts',
  'scripts/install-go2rtc.sh',
])

/** Product words. The keep list below is the only way one may remain. */
const PRODUCT =
  /\b(?:scrypted|frigate|blue\s*iris|blueiris|shinobi|zoneminder|motioneye|agent\s*dvr|agentdvr|unifi\s*protect|synology\s*surveillance|go2rtc|hassio|nabu\s*casa)\b/gi

/**
 * Spans that are the integration, not a mention. A product word is kept only
 * when the whole match sits inside one of these.
 */
const KEPT: readonly RegExp[] = [
  /https?:\/\/\S+/g,
  /docs\.frigate\.video\S*/g,
  /api\.frigate\.video\S*/g,
  /github\.com\/\S+/g,
  /huggingface\.co\/\S+/g,
  /scrypted\/plugin-models/g,
  /scrypted[_-]yolov\d[\w.-]*/g,
  /frigate-detector[\w.-]*/g,
  /frigate-(?:mobiledet|yolonas|yolo\d|coco|vehicles|ssd|efficientdet)[\w.-]*/g,
  /(?<![\w.-])frigate-plus(?![\w.-])/g,
  /frigate-plus-[0-9a-f]{8,}[\w.-]*/g,
  /(?:scrypted|frigate):/g,
  /(['"`])(?:scrypted|frigate|hassio)\1/g,
  /\/(?:scrypted|frigate)\/i\b/g,
  /bin\/go2rtc/g,
  /install-go2rtc\.sh/g,
  /go2rtc_(?:mac|linux)[\w.-]*/g,
]

const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|mp4|mov|woff2?)$/i

export interface ProductMention {
  readonly file: string
  readonly line: number
  readonly match: string
}

function lineOf(text: string, index: number): number {
  let n = 1
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) n += 1
  return n
}

function keptSpans(line: string): ReadonlyArray<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = []
  for (const pattern of KEPT) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
    const re = new RegExp(pattern.source, flags)
    for (const found of line.matchAll(re)) {
      const start = found.index ?? 0
      spans.push([start, start + found[0].length])
    }
  }
  return spans
}

function inside(
  spans: ReadonlyArray<readonly [number, number]>,
  start: number,
  end: number,
): boolean {
  for (const [from, to] of spans) if (start >= from && end <= to) return true
  return false
}

export function findThirdPartyProducts(text: string, file: string): readonly ProductMention[] {
  if (SKIP_FILES.has(file)) return []
  const found: ProductMention[] = []
  for (const match of text.matchAll(PRODUCT)) {
    const index = match.index ?? 0
    const word = match[0] ?? ''
    const lineStart = text.lastIndexOf('\n', index - 1) + 1
    const lineEnd = text.indexOf('\n', index)
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
    const local = index - lineStart
    if (inside(keptSpans(line), local, local + word.length)) continue
    found.push({ file, line: lineOf(text, index), match: word })
  }
  return found
}

function listedFiles(): readonly string[] {
  const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
  const out = execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out.split('\0').filter((file) => file.length > 0 && !BINARY_EXT.test(file))
}

function main(): void {
  const findings: ProductMention[] = []
  let scanned = 0
  for (const rel of listedFiles()) {
    const abs = path.join(ROOT, rel)
    if (!fs.existsSync(abs)) continue
    let text: string
    try {
      text = fs.readFileSync(abs, 'utf-8')
    } catch {
      continue
    }
    if (text.includes('\0')) continue
    scanned += 1
    findings.push(...findThirdPartyProducts(text, rel))
  }
  if (findings.length > 0) {
    console.error(
      `\n✗ third-party product guard: ${findings.length} finding(s).\n` +
        '  Name the mechanism (plus catalog, plugin catalog, external restreamer,\n' +
        '  a separate NVR). Keep a product word only for a stored id, an upstream\n' +
        '  artifact id, a URL, or the restreamer binary in scripts/install-go2rtc.sh.\n',
    )
    for (const finding of findings.slice(0, 80))
      console.error(`  ${finding.file}:${finding.line}  ${finding.match}`)
    if (findings.length > 80) console.error(`  … ${findings.length - 80} more`)
    process.exitCode = 1
    return
  }
  console.log(`✔ third-party product guard: ${scanned} files, 0 findings`)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)
  main()
