#!/usr/bin/env tsx
/**
 * Tree scrub guard — house names, hosts, addresses, rooms and camera ids.
 *
 * ## The failure this catches
 *
 * `scripts/check-public-docs-private-data.ts` only reads the working-docs
 * folders, and it used to treat this cluster's hosts, rooms and camera ids as
 * publishable. They are not. The values are stored as hashes so this file,
 * which is public, does not repeat them.
 *
 * The security contact address is stored as a hash. Its plaintext may appear
 * only in `SECURITY.md` and `.github/ISSUE_TEMPLATE/config.yml`. The same
 * address anywhere else is a finding. Other e-mail addresses are not scanned
 * here (`check-public-docs-private-data.ts` still scans `docs/design`).
 *
 * Run: npx tsx scripts/check-tree-private-data.ts
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { termHash } from './check-public-docs-private-data.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export type TreePrivateCategory = 'person' | 'host' | 'room' | 'home-ip' | 'camera-id' | 'email'

/**
 * sha256(lowercase NFC)[0..16] of the security contact. The plaintext is
 * allowed only in the two files below — never in this source file.
 */
export const SECURITY_CONTACT_HASH = 'b8cf1eead6cd2123'
export const SECURITY_CONTACT_FILES: ReadonlySet<string> = new Set([
  'SECURITY.md',
  '.github/ISSUE_TEMPLATE/config.yml',
])

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g

export interface TreePrivateFinding {
  readonly file: string
  readonly line: number
  readonly category: TreePrivateCategory
  readonly match: string
}

/** sha256(lowercase NFC)[0..16]. Comments name the kind, never the value. */
export const PERSON_HASHES: ReadonlySet<string> = new Set([
  'ec27c5dcb1aba241',
  '926dc6fb2c9459c7',
  'bd3dae5fb91f88a4',
  '05a642215a9ffabd',
  '0da07cfe048ddf1c',
  '58cc6181518fbfb4',
  '5aac48366e75edaf',
  '82e8a5dda420d57d',
])

export const HOST_HASHES: ReadonlySet<string> = new Set([
  'ffbdf3346fe9d894',
  'f3f39556097176ef',
  '9630fb853fdd1d9a',
  '442069d9309f9b61',
  'ad2015263f339bff', // also an ML word; see towerIsMl
])

export const ROOM_HASHES: ReadonlySet<string> = new Set([
  '3ef62019e2ff1b73', // also the Italian word for entry/input
  '135a315c16ea83ae',
  '13337113ce05d55e',
  '46b4eb8144194bab',
  '60e9764981a31bf1',
  '5ce85d37f0c84c52',
  'b77235a7a5e00269',
  '1dd817165d3c0099',
  'f4e6b7a156740be1',
  '17216fd9814fc91b',
])

export const HOME_IP_HASHES: ReadonlySet<string> = new Set([
  'e41d6b2fda656eef',
  '725b4c8929840ff6',
  '6030d4d6a0d9b264',
  'b3a6c05e6c3e26b2',
  '8dc92b0ba9644d93',
  'b12a705d8feeb382',
  'b5fc5e0389850fc0',
])

export const CAMERA_ID_HASHES: ReadonlySet<string> = new Set([
  '3de8392541ace282',
  '85ea151b8c5b5ab0',
  '085bcb597bbd610a',
  'e6fcc0253ed7a328',
  'fa7aec4efb728534',
  '3f1bb7c0da3c01e6',
  '793733573a1dfd14',
  'ee377871c73631fd',
  '219de1387a6743e5',
  '82a93b152b275d4c',
  '298647699bcb31c2',
])

const ENTRY_ROOM_HASH = '3ef62019e2ff1b73'
const BATHROOM_HASH = '60e9764981a31bf1'
const TOWER_HASH = 'ad2015263f339bff'
const BEDROOM_PHRASE: readonly string[] = [
  '89e8b9518d922794',
  'aa58b21b01d6b8a9',
  'c218787bda9bfe4c',
]

const ENTRY_BEFORE = /(?:di|in|del|al|col|sul|dal|nel|ritardo|fps|d['’]|dell['’]|all['’])\s*$/i
const TOWER_FIXTURE_FILES: ReadonlySet<string> = new Set([
  'scripts/__tests__/check-public-docs-private-data.spec.ts',
  'scripts/__tests__/check-tree-private-data.spec.ts',
  'packages/types/src/device/icon-catalog.generated.ts',
])

const IPV4 = /(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/g
const TOKEN = /[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)*/gu
const CAMERA_TOKEN = /(?<![\d.x×A-Za-z@-])(\d{3,4})(?![\dx×@-])/g
const FILE_LINE = /\.(?:ts|tsx|js|mjs|cjs|mts|md|py|go|json|yml|yaml|sh):$/

export interface TreeScanOptions {
  readonly person?: ReadonlySet<string>
  readonly host?: ReadonlySet<string>
  readonly room?: ReadonlySet<string>
  readonly homeIp?: ReadonlySet<string>
  readonly cameraId?: ReadonlySet<string>
  readonly securityContactHash?: string
  readonly securityContactFiles?: ReadonlySet<string>
}

function lineOf(text: string, index: number): number {
  let n = 1
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) n += 1
  return n
}

function wordPieces(word: string): readonly string[] {
  const pieces = word.split(/(?<=[\p{Ll}])(?=\p{Lu})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u)
  return pieces.length > 1 ? [word, ...pieces] : [word]
}

function roomFile(file: string): boolean {
  return (
    file.endsWith('/i18n/it.json') ||
    file.endsWith('state-labels.ts') ||
    file.endsWith('icon-synonyms.ts') ||
    file.includes('assets/viewer/')
  )
}

function towerIsMl(
  line: string,
  word: string,
  piece: string,
  before: string,
  after: string,
): boolean {
  if (piece.length < word.length) return true
  if (/^(?:text|vision|image|embedding)tower$/i.test(word)) return true
  if (/(?:text|vision|image|embedding|per-)\s*$/i.test(before)) return true
  if (before.endsWith('-') || after.startsWith('-')) return true
  if (/\b(?:a|the|its|that|one|each|other|idle|loaded|this|every)\s+$/i.test(before)) return true
  if (/embedding|clip|encoder|siglip|mobileclip/i.test(line)) return true
  return line.includes('EmbeddingTower')
}

function vendorCatalog(file: string): boolean {
  return file.includes('/python/vendor/') || file.endsWith('/catalog.json')
}

function towerIsHostLeak(
  file: string,
  word: string,
  piece: string,
  before: string,
  after: string,
  line: string,
): boolean {
  if (vendorCatalog(file)) return false
  if (after.startsWith('_') || before.endsWith('_')) return false
  if (piece.toLowerCase() !== 'tower') return true
  if (towerIsMl(line, word, piece, before, after)) return false
  if (word === word.toLowerCase()) {
    return after.startsWith('.local') || /\b(?:hostname|nas)\b/i.test(line)
  }
  if (word === 'Tower' && /\b(?:format|precision|image|text|vision)\b/i.test(line)) return false
  return true
}

function skipHostLine(line: string): boolean {
  return line.includes('runs-on:') || line.includes('runner_labels')
}

function cameraContext(line: string, index: number): boolean {
  if (line.startsWith('@@')) return false
  if (FILE_LINE.test(line.slice(Math.max(0, index - 24), index))) return false
  if (/yolo|viewport|width|height|resolution|\bpx\b/i.test(line)) return false
  return /device|camera|doorbell|\bcam\b/i.test(line)
}

export function findTreePrivateData(
  text: string,
  file: string,
  options: TreeScanOptions = {},
): readonly TreePrivateFinding[] {
  const person = options.person ?? PERSON_HASHES
  const host = options.host ?? HOST_HASHES
  const room = options.room ?? ROOM_HASHES
  const homeIp = options.homeIp ?? HOME_IP_HASHES
  const cameraId = options.cameraId ?? CAMERA_ID_HASHES
  const securityContactHash = options.securityContactHash ?? SECURITY_CONTACT_HASH
  const securityContactFiles = options.securityContactFiles ?? SECURITY_CONTACT_FILES
  const found: TreePrivateFinding[] = []
  const add = (category: TreePrivateCategory, index: number, match: string): void => {
    found.push({ file, line: lineOf(text, index), category, match })
  }

  for (const m of text.matchAll(IPV4)) {
    const hostPart = (m[0] ?? '').replace(/:\d+$/, '')
    if (homeIp.has(termHash(hostPart))) add('home-ip', m.index ?? 0, m[0] ?? '')
  }

  const phrase: string[] = []
  for (const m of text.matchAll(TOKEN)) {
    const index = m.index ?? 0
    const word = m[0] ?? ''
    const before = text.slice(Math.max(0, index - 16), index)
    const after = text.slice(index + word.length, index + word.length + 12)
    const lineStart = text.lastIndexOf('\n', index - 1) + 1
    const lineEnd = text.indexOf('\n', index)
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
    let tagged = false
    for (const piece of wordPieces(word)) {
      const hash = termHash(piece)
      if (person.has(hash)) {
        add('person', index, word)
        tagged = true
        break
      }
      if (host.has(hash)) {
        if (skipHostLine(line)) break
        if (hash === TOWER_HASH && !towerIsHostLeak(file, word, piece, before, after, line)) break
        if (
          hash === TOWER_HASH &&
          (TOWER_FIXTURE_FILES.has(file) ||
            after.startsWith(':') ||
            line.includes('self-hosted') ||
            file.includes('assets/viewer/') ||
            (file.startsWith('.github/workflows/') && /^\s*runner:/.test(line)))
        )
          break
        add('host', index, word)
        tagged = true
        break
      }
      if (room.has(hash) && !roomFile(file) && !vendorCatalog(file)) {
        if (hash === ENTRY_ROOM_HASH && ENTRY_BEFORE.test(before)) break
        if (hash === BATHROOM_HASH && /^-a-ripoli/i.test(after)) break
        add('room', index, word)
        tagged = true
        break
      }
    }
    phrase.push(termHash(word))
    if (!tagged && phrase.length >= 3 && !roomFile(file) && !vendorCatalog(file)) {
      const tail = phrase.slice(-3)
      if (
        tail[0] === BEDROOM_PHRASE[0] &&
        tail[1] === BEDROOM_PHRASE[1] &&
        tail[2] === BEDROOM_PHRASE[2]
      )
        add('room', index, word)
    }
  }

  for (const m of text.matchAll(EMAIL_RE)) {
    const address = m[0] ?? ''
    if (termHash(address) !== securityContactHash) continue
    if (securityContactFiles.has(file)) continue
    add('email', m.index ?? 0, address)
  }

  if (!file.includes('assets/viewer/')) {
    for (const m of text.matchAll(CAMERA_TOKEN)) {
      const id = m[1] ?? ''
      if (!cameraId.has(termHash(id))) continue
      const index = m.index ?? 0
      const lineStart = text.lastIndexOf('\n', index - 1) + 1
      const lineEnd = text.indexOf('\n', index)
      const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
      if (cameraContext(line, index - lineStart)) {
        const local = index - lineStart
        const around = line.slice(Math.max(0, local - 4), local)
        if (/\d $/.test(around)) continue
        add('camera-id', index, id)
      }
    }
  }
  return found
}

const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|mp4|mov|woff2?)$/i

function main(): void {
  const out = execFileSync('git', ['ls-files', '-z', '--cached'], {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const files = out.split('\0').filter((f) => f.length > 0 && !BINARY_EXT.test(f))
  const findings: TreePrivateFinding[] = []
  for (const rel of files) {
    let text: string
    try {
      text = fs.readFileSync(path.join(ROOT, rel), 'utf-8')
    } catch {
      continue
    }
    if (text.includes('\0')) continue
    findings.push(...findTreePrivateData(text, rel))
  }
  if (findings.length > 0) {
    console.error(
      `\n✗ tree private-data guard: ${findings.length} finding(s).\n` +
        '  Replace a person with Alice/Bob/Carol/Dave, a host with agent-a/agent-b/\n' +
        '  agent-mac/ci-runner, a home address with 192.0.2.0/24, a room with an\n' +
        '  English name (Front door, Porch, Kitchen), a camera id with 101, 102, …\n',
    )
    for (const f of findings.slice(0, 80))
      console.error(`  ${f.file}:${f.line}  [${f.category}]  ${f.match}`)
    if (findings.length > 80) console.error(`  … ${findings.length - 80} more`)
    process.exitCode = 1
    return
  }
  console.log(`✔ tree private-data guard: ${files.length} files, 0 findings`)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)
  main()
