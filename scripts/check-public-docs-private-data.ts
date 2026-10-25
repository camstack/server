#!/usr/bin/env tsx
/**
 * Public-working-docs guard — design notes carry no private data.
 *
 * ## The failure this catches
 *
 * `docs/design/**` was written next to local working notes (specs, plans,
 * handovers, ledgers, subagent reports). Those notes moved to the sibling
 * planning repo. Design notes stay here and were written against one house's
 * cluster, with that house's LAN addresses, host names, home-directory paths,
 * account names and the names of the people whose faces the recogniser was
 * being tuned on. On 2026-10-01 the operator decided the working notes become
 * part of the (soon public) repository, and they were sanitized once by hand.
 * Nothing about HOW a design note gets written changed: the next one will paste
 * the hub's address again. This guard is what makes the one-off scrub stick.
 *
 * ## What counts as private (the definition lives in this file)
 *
 *   - `lan-ip`     a LAN address: 10/8, 172.16/12, 192.168/16, and the
 *                  100.64/10 CGNAT range Tailscale hands out (with or without
 *                  `:port`). The range literal `100.64.0.0` is not a host.
 *   - `host-path`  an absolute path that describes the house rather than the
 *                  code: `/Users/<someone>/…`, `/mnt/…` (the NAS pools),
 *                  `/private/tmp/claude-<uid>/…` and `/tmp/claude-<uid>/…`.
 *   - `private-term` a person's name, an account/user name, or a private
 *                  host name. Matched by HASH, never written here — this file
 *                  is public too, and a list of the family's names in it would
 *                  be the very leak it exists to stop. Each term is the first
 *                  16 hex chars of sha256(lowercase NFC token).
 *   - `email`      any e-mail address except the commit-trailer `noreply@`
 *                  ones and `example.*` domains.
 *   - `token`      a credential of a known shape: GitHub (`ghp_` `gho_` `ghu_`
 *                  `ghs_` `ghr_` `github_pat_`), npm (`npm_`), Hugging Face
 *                  (`hf_`), a JWT, an `sk-` key of real
 *                  length, an AWS key id, a PEM private-key block, and a
 *                  quoted value assigned to a `secret`/`password`/`token`/
 *                  `apiKey` name.
 *   - `mac`        a hardware (MAC) address.
 *   - `plate`      an Italian-format licence plate, except the synthetic
 *                  fixtures the tests use (`AB123CD` family, `ZZ999ZZ`, …).
 *   - `serial`     a value assigned to a `serial`/`serialNumber` field.
 *
 * House names, home addresses, host names, room names and the house's camera
 * ids are refused in the whole tree by `scripts/check-tree-private-data.ts`.
 * This guard does not repeat that list. A generic node id (`hub`) is not a
 * house host.
 *
 * ## Exceptions
 *
 * `scripts/check-public-docs-private-data.allowlist.json` lists `{ file, match,
 * why }`. An entry that no longer matches anything FAILS the guard: an
 * exception nobody needs is a hole waiting for the next leak.
 *
 * ## Scope
 *
 * Only files in the git index under `docs/design`. A `/mnt/…` path there is
 * architecture (the NAS pool layout the records describe) and is not a finding;
 * every other category applies. The session diary and the working-note trees
 * moved to the planning repo and are no longer scanned here.
 *
 * Run: npx tsx scripts/check-public-docs-private-data.ts
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SCOPES: readonly string[] = ['docs/design']
/** Design records describe the NAS pool layout as architecture (AGENTS.md does too): `/mnt/…` is allowed there. */
export const NAS_MOUNT_EXEMPT_PREFIXES: readonly string[] = ['docs/design/']
const ALLOWLIST_FILE = 'scripts/check-public-docs-private-data.allowlist.json'

export type PrivateCategory =
  | 'lan-ip'
  | 'host-path'
  | 'private-term'
  | 'email'
  | 'token'
  | 'mac'
  | 'plate'
  | 'serial'

export interface PrivateFinding {
  readonly file: string
  readonly line: number
  readonly category: PrivateCategory
  readonly match: string
}

export interface AllowlistEntry {
  readonly file: string
  readonly match: string
  readonly why: string
}

/**
 * sha256(token)[0..16] of every private term. Add a term by hashing it:
 *   printf '%s' "<term lowercase>" | shasum -a 256 | cut -c1-16
 * and say in the comment WHAT KIND of term it is, never which.
 */
/**
 * The hub NAS host name is also an ordinary ML word ("text tower", "vision
 * tower"); it is private only when it is not one.
 */
const NAS_HOST_HASH = 'ad2015263f339bff'
const NAS_HOST_ML_PREFIX = /(?:text|vision|image|per-)\s*$/i
const NAS_HOST_ML_WORD = /^(?:text|vision|image)tower$/i

function isMlTower(word: string, before: string): boolean {
  return NAS_HOST_ML_WORD.test(word) || NAS_HOST_ML_PREFIX.test(before)
}

export const PRIVATE_TERM_HASHES: ReadonlySet<string> = new Set([
  'ec27c5dcb1aba241', // person (operator)
  '926dc6fb2c9459c7', // person (family)
  '05a642215a9ffabd', // person (family)
  'bd3dae5fb91f88a4', // person (family)
  '0da07cfe048ddf1c', // person (family, accented spelling)
  '58cc6181518fbfb4', // person (family, plain spelling)
  '5aac48366e75edaf', // surname
  'bc72821ca0faa034', // local macOS user name
  '0462db41af8c5245', // account name (stem)
  '5a387b74fc60aada', // GitHub / npm account
  '131bf61292c29cbb', // work account name
  '6a780680a34fd0aa', // employer
  'ee119eb71e4e1e8e', // employer
  '82e8a5dda420d57d', // personal mail local-part stem
  '9630fb853fdd1d9a', // macOS host name
  '442069d9309f9b61', // NAS host name
  NAS_HOST_HASH, // NAS host name (see isMlTower)
])

const IP_RE =
  /(?<![\d.])(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})(?![\d])(?::\d{2,5})?/g
const IP_NOT_A_HOST: ReadonlySet<string> = new Set(['100.64.0.0'])

const PATH_RE =
  /\/Users\/(?!runner\b|Shared\b|you\b|<)[^/\s`'")\]]+|\/mnt\/[^\s`'")\]]*|(?:\/private)?\/tmp\/claude-\d+[^\s`'")\]]*/g

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g
const EMAIL_OK =
  /^(?:noreply@anthropic\.com|[\w.+-]+@users\.noreply\.github\.com|[\w.+-]+@example\.(?:com|org|net))$/i

const MIXED = '(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*[a-z])[A-Za-z0-9]'
const TOKEN_RES: readonly RegExp[] = [
  new RegExp(`\\bgh[pousr]_${MIXED}{6,}`, 'g'),
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  new RegExp(`\\bnpm_${MIXED}{6,}`, 'g'),
  new RegExp(`\\bhf_${MIXED}{8,}`, 'g'),
  /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
]
/** A quoted value assigned to a credential-named key; group 1 is the value. */
const ASSIGNED_SECRET_RE =
  /\b(?:secret|password|passwd|jwtSecret|apiKey|api_key|token)\b["'`]?\s*[:=]\s*["'`]((?=[^"'`\s<>]*\d)(?=[^"'`\s<>]*[A-Za-z])[^"'`\s<>.]{12,})["'`]/gi
/** Obvious fixture values in a quoted assignment — never real credentials. */
const TOKEN_FIXTURE =
  /(?:test|fake|example|dummy|placeholder|secret|redacted|xxx|\*\*\*|changeme|sk-(?:old|new|live|secret))/i

const MAC_RE = /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g
const PLATE_RE = /\b[A-Z]{2} ?\d{3} ?[A-Z]{2}\b/g
const SYNTHETIC_PLATE = /^(?:AB ?123 ?C[A-Z]|ZZ ?999 ?ZZ|XY ?999 ?ZZ|QQ ?000 ?QQ|AA ?999 ?AA)$/
const SERIAL_RE = /\bserial(?:Number|No)?\b["'`]?\s*[:=]\s*["'`]?[A-Z0-9]{8,}/gi

const TOKEN_WORD = /[\p{L}\p{N}]+/gu

export function termHash(token: string): string {
  return createHash('sha256')
    .update(token.normalize('NFC').toLowerCase())
    .digest('hex')
    .slice(0, 16)
}

/** A word, plus its camelCase and letter/digit pieces (`bobAlice`). */
function wordPieces(word: string): readonly string[] {
  const pieces = word.split(/(?<=[\p{Ll}])(?=\p{Lu})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u)
  return pieces.length > 1 ? [word, ...pieces] : [word]
}

function lineOf(text: string, index: number): number {
  let n = 1
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) n += 1
  return n
}

interface ScanOptions {
  readonly termHashes?: ReadonlySet<string>
}

export function findPrivateData(
  text: string,
  file: string,
  options: ScanOptions = {},
): readonly PrivateFinding[] {
  const hashes = options.termHashes ?? PRIVATE_TERM_HASHES
  const found: PrivateFinding[] = []
  const add = (category: PrivateCategory, index: number, match: string): void => {
    found.push({ file, line: lineOf(text, index), category, match })
  }
  const each = (re: RegExp, fn: (m: RegExpMatchArray) => void): void => {
    for (const m of text.matchAll(re)) fn(m)
  }

  each(IP_RE, (m) => {
    const host = m[0].replace(/:\d+$/, '')
    if (!IP_NOT_A_HOST.has(host)) add('lan-ip', m.index ?? 0, m[0])
  })
  each(PATH_RE, (m) => {
    if (NAS_MOUNT_EXEMPT_PREFIXES.some((p) => file.startsWith(p)) && m[0].startsWith('/mnt/'))
      return
    add('host-path', m.index ?? 0, m[0])
  })
  each(EMAIL_RE, (m) => {
    if (!EMAIL_OK.test(m[0])) add('email', m.index ?? 0, m[0])
  })
  for (const re of TOKEN_RES) each(re, (m) => add('token', m.index ?? 0, m[0]))
  each(ASSIGNED_SECRET_RE, (m) => {
    if (!TOKEN_FIXTURE.test(m[1] ?? '')) add('token', m.index ?? 0, m[0])
  })
  each(MAC_RE, (m) => add('mac', m.index ?? 0, m[0]))
  each(PLATE_RE, (m) => {
    if (!SYNTHETIC_PLATE.test(m[0])) add('plate', m.index ?? 0, m[0])
  })
  each(SERIAL_RE, (m) => add('serial', m.index ?? 0, m[0]))

  const cache = new Map<string, boolean>()
  const isPrivate = (piece: string): boolean => {
    const key = piece.toLowerCase()
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    const h = termHash(key)
    const result = hashes.has(h) ? h : ''
    cache.set(key, result !== '')
    return result !== ''
  }
  each(TOKEN_WORD, (m) => {
    const index = m.index ?? 0
    for (const piece of wordPieces(m[0])) {
      if (!isPrivate(piece)) continue
      if (
        termHash(piece) === NAS_HOST_HASH &&
        isMlTower(m[0], text.slice(Math.max(0, index - 12), index))
      )
        continue
      add('private-term', index, m[0])
      break
    }
  })
  return found
}

export function applyAllowlist(
  findings: readonly PrivateFinding[],
  allowlist: readonly AllowlistEntry[],
): { readonly remaining: readonly PrivateFinding[]; readonly unused: readonly AllowlistEntry[] } {
  const used = new Set<AllowlistEntry>()
  const remaining = findings.filter((f) => {
    const entry = allowlist.find((a) => a.file === f.file && a.match === f.match)
    if (entry === undefined) return true
    used.add(entry)
    return false
  })
  return { remaining, unused: allowlist.filter((a) => !used.has(a)) }
}

function isAllowlistEntry(value: unknown): value is AllowlistEntry {
  if (typeof value !== 'object' || value === null) return false
  if (!('file' in value) || !('match' in value) || !('why' in value)) return false
  return (
    typeof value.file === 'string' &&
    typeof value.match === 'string' &&
    typeof value.why === 'string' &&
    value.why.length > 0
  )
}

function loadAllowlist(): readonly AllowlistEntry[] {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, ALLOWLIST_FILE), 'utf-8'))
  if (!Array.isArray(raw) || !raw.every(isAllowlistEntry)) {
    throw new Error(
      `${ALLOWLIST_FILE}: expected an array of { file, match, why } with a non-empty why`,
    )
  }
  return raw
}

function scopedFiles(): readonly string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--', ...SCOPES], {
    cwd: ROOT,
    encoding: 'utf-8',
  })
  return out.split('\0').filter((f) => f.length > 0)
}

const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|mp4|mov|woff2?)$/i

function main(): void {
  const files = scopedFiles()
  const findings: PrivateFinding[] = []
  for (const rel of files) {
    if (BINARY_EXT.test(rel)) continue
    let text: string
    try {
      text = fs.readFileSync(path.join(ROOT, rel), 'utf-8')
    } catch {
      continue // staged deletion
    }
    findings.push(...findPrivateData(text, rel))
  }
  const { remaining, unused } = applyAllowlist(findings, loadAllowlist())

  if (remaining.length > 0 || unused.length > 0) {
    console.error(
      `\n✗ public-docs private-data guard: ${remaining.length} finding(s) in ${SCOPES.join(', ')}.\n` +
        '  These folders are published. Replace each value with a placeholder\n' +
        '  (<hub-ip>, Person A, <repo>/…, <scratchpad>/…),\n' +
        `  or — for a synthetic fixture — add { file, match, why } to ${ALLOWLIST_FILE}.\n`,
    )
    for (const f of remaining) console.error(`  ${f.file}:${f.line}  [${f.category}]  ${f.match}`)
    for (const a of unused)
      console.error(`  stale allowlist entry (matches nothing): ${a.file} → ${a.match}`)
    process.exitCode = 1
    return
  }
  console.log(`✔ public-docs private-data guard: ${files.length} files, 0 findings`)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)
  main()
