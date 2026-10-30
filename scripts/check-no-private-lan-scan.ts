#!/usr/bin/env tsx
/**
 * An addon does not scan the LAN itself (D977).
 *
 * Finding devices is the `local-network` scan engine's job: an addon declares
 * discovery modes (`getDiscoveryModes`) and classifies the hits it is handed. A
 * private `dgram` socket, a multicast group, an interface walk or a /24 sweep
 * inside an addon repeats the scan the engine already ran, on a different set of
 * subnets, with its own timeouts - and was the reason a board found by one scan
 * was missed by the next.
 *
 * Scope: `packages/addon-*\/src`, excluding specs and `__tests__`. Comment-only
 * lines are skipped. A file that legitimately needs a socket or its own address
 * (an RTP receiver, an ICE candidate list, a callback address) is named in
 * {@link ALLOWLIST} with the reason; an entry that no longer matches anything is
 * itself a failure, so the list cannot rot.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

interface Rule {
  readonly name: string
  readonly pattern: RegExp
}

const RULES: readonly Rule[] = [
  { name: 'dgram', pattern: /\bdgram\b/ },
  { name: 'networkInterfaces', pattern: /\bnetworkInterfaces\b/ },
  {
    name: 'multicast address literal',
    pattern: /\b(?:22[4-9]|23\d)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\bff0[0-9a-f]::/i,
  },
  { name: '/24 sweep loop', pattern: /for\s*\([^)]*(?:<=\s*254|<\s*255)\b/ },
]

/** Files that use a socket or the host's own address for something that is not discovery. */
export const ALLOWLIST: Readonly<Record<string, string>> = {
  'packages/addon-export-hap/src/mappers/builders/camera-streams.ts':
    'HomeKit SRTP media sockets and the hub address advertised to the Home app; no device is searched for',
  'packages/addon-pipeline/src/stream-broker/rtsp/udp-audio-rtp-receiver.ts':
    'receives the RTP audio a camera was told to send; binds one port, scans nothing',
  'packages/addon-pipeline/src/stream-broker/webrtc/session.ts':
    'lists the hub own addresses as WebRTC ICE candidates; no device is searched for',
  'packages/addon-provider-homematic/src/callback-host.ts':
    'picks the hub address the CCU calls back on; no device is searched for',
  'packages/addon-provider-reolink/src/email-push-shared.ts':
    'lists the hub LAN addresses a camera can reach its SMTP push server on; no device is searched for',
}

const SKIP_DIRS = new Set([
  'dist',
  'node_modules',
  '.git',
  'coverage',
  'generated',
  '__tests__',
  '__mocks__',
])
const SOURCE_RE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/
const NON_RUNTIME_RE = /\.(?:spec|test|d)\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/

export interface LanScanFinding {
  readonly file: string
  readonly line: number
  readonly rule: string
  readonly text: string
}

function isCommentLine(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

export interface ScannedFile {
  readonly rel: string
  readonly content: string
}

export interface LanScanReport {
  readonly findings: readonly LanScanFinding[]
  /** Allowlist entries whose file no longer contains anything the rules match. */
  readonly staleAllowlist: readonly string[]
}

export function findPrivateLanScans(
  files: readonly ScannedFile[],
  allowlist: Readonly<Record<string, string>> = ALLOWLIST,
): LanScanReport {
  const findings: LanScanFinding[] = []
  const usedAllow = new Set<string>()
  for (const { rel, content } of files) {
    for (const [i, text] of content.split('\n').entries()) {
      if (isCommentLine(text)) continue
      for (const rule of RULES) {
        if (!rule.pattern.test(text)) continue
        if (allowlist[rel] !== undefined) {
          usedAllow.add(rel)
          continue
        }
        findings.push({ file: rel, line: i + 1, rule: rule.name, text: text.trim() })
      }
    }
  }
  const present = new Set(files.map((f) => f.rel))
  const staleAllowlist = Object.keys(allowlist).filter((k) => !usedAllow.has(k) || !present.has(k))
  return { findings, staleAllowlist }
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
    else if (SOURCE_RE.test(name) && !NON_RUNTIME_RE.test(name)) out.push(full)
  }
}

function main(): void {
  const paths: string[] = []
  for (const pkg of readdirSync(path.join(ROOT, 'packages'))) {
    if (pkg.startsWith('addon-')) walk(path.join(ROOT, 'packages', pkg, 'src'), paths)
  }
  const files = paths.map((p) => ({
    rel: path.relative(ROOT, p).split(path.sep).join('/'),
    content: readFileSync(p, 'utf-8'),
  }))
  const { findings, staleAllowlist } = findPrivateLanScans(files)
  if (findings.length === 0 && staleAllowlist.length === 0) {
    console.log(`check-no-private-lan-scan: ${files.length} addon files, no private LAN scan`)
    return
  }
  if (findings.length > 0) {
    console.error(
      'check-no-private-lan-scan: an addon declares discovery modes and classifies hits (D977); ' +
        'it never opens its own socket, walks interfaces or sweeps a subnet:',
    )
    for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.rule}]  ${f.text}`)
  }
  for (const stale of staleAllowlist) {
    console.error(`check-no-private-lan-scan: stale allowlist entry (nothing matches): ${stale}`)
  }
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
