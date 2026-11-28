#!/usr/bin/env tsx
/**
 * No `CAMSTACK_` environment variable name anywhere in tracked code, the
 * Dockerfile or the workflows. The container and process contract is named
 * `DOMINEVO_*` and the old names are not read as a fallback: a template or
 * script that still sets `CAMSTACK_ROLE` stops working, on purpose.
 *
 * Textual, over every tracked file: a `CAMSTACK_` token that is not preceded
 * by an identifier character is a finding unless it is one of the code
 * identifiers below (constants and a stdout protocol prefix that never name an
 * environment variable). Allowed places: the rename tooling (it NAMES the old
 * names to rewrite them), changelogs and the decision/design history.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const LEGACY = /(?:(?<![A-Za-z0-9_])|(?<=\\[bnrt]))CAMSTACK_[A-Za-z0-9_]*/g

/** Code identifiers and a protocol prefix that are not environment names. */
export const NON_ENV_TOKENS: ReadonlySet<string> = new Set([
  'CAMSTACK_APP_LINK_ORIGIN',
  'CAMSTACK_CMD',
  'CAMSTACK_CMD_RE',
  'CAMSTACK_HEX',
  'CAMSTACK_FALLBACK',
  'CAMSTACK_SCOPE_PREFIX',
  'CAMSTACK_NAME_PATTERN',
  'CAMSTACK_EVENT',
  'CAMSTACK_EVENT_PREFIX',
  'CAMSTACK_CHILD',
])

const ALLOWED_PATHS: readonly RegExp[] = [
  /^scripts\/rename\//,
  /(^|\/)CHANGELOG[^/]*$/,
  /^docs\/decisions\//,
  /^docs\/design\//,
  /^docs\/reference\//,
  /^patches\//,
  /^packages\/addon-pipeline-orchestrator\/assets\//,
  /^scripts\/check-no-legacy-product-env\.ts$/,
  /^scripts\/__tests__\/check-no-legacy-product-env\.spec\.ts$/,
]

export interface LegacyEnvFinding {
  readonly file: string
  readonly line: number
  readonly token: string
}

export function findLegacyProductEnv(
  files: readonly { readonly rel: string; readonly content: string }[],
): LegacyEnvFinding[] {
  const findings: LegacyEnvFinding[] = []
  for (const { rel, content } of files) {
    if (ALLOWED_PATHS.some((re) => re.test(rel))) continue
    for (const [i, text] of content.split('\n').entries()) {
      for (const m of text.matchAll(LEGACY)) {
        if (NON_ENV_TOKENS.has(m[0])) continue
        findings.push({ file: rel, line: i + 1, token: m[0] })
      }
    }
  }
  return findings
}

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
  })
  return out.split('\0').filter((f) => f !== '' && !f.startsWith('camstack/'))
}

function main(): void {
  const files: { rel: string; content: string }[] = []
  for (const rel of trackedFiles()) {
    let buf: Buffer
    try {
      buf = readFileSync(path.join(ROOT, rel))
    } catch {
      continue
    }
    if (buf.subarray(0, 4096).includes(0)) continue
    files.push({ rel, content: buf.toString('utf-8') })
  }
  const findings = findLegacyProductEnv(files)
  if (findings.length === 0) {
    console.log(`check-no-legacy-product-env: ${files.length} tracked files, no CAMSTACK_ env name`)
    return
  }
  console.error(
    'check-no-legacy-product-env: the environment contract is DOMINEVO_*, not CAMSTACK_*:',
  )
  for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.token}`)
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
