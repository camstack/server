#!/usr/bin/env tsx
/**
 * Credential guard — no Google service-account key, and no private key of any
 * kind, may be committed to this repository.
 *
 * ## Why this exists, and why it is not a general secret scanner
 *
 * `packages/addon-export-alexa/src/public-skill.ts` commits a real LWA client
 * secret ON PURPOSE, and that is sound: Amazon's published-skill model gives a
 * skill ONE set of "Send Alexa Events" credentials, the secret identifies the
 * public skill, and it grants nothing without a per-account OAuth grant. That
 * file's docblock says so.
 *
 * The danger is that the next exporter copies the shape. A Google HomeGraph
 * **service-account key is not the same class of credential**: it is an RSA
 * private key that authenticates as a principal in the operator's Google Cloud
 * project, and its blast radius is every API that project has enabled — not one
 * smart-home Action. There is no "public" variant of it. Committing one, even
 * as a realistic-looking placeholder, is not a smaller version of the Alexa
 * decision; it is a different decision, and the answer is always no
 * (docs/decisions/adr-0269.md).
 *
 * So this guard is deliberately narrow. It looks for the two shapes that can
 * only be a private credential — a service-account JSON envelope, and a PEM
 * private-key block — and nothing else. A guard that flagged the word "secret"
 * would fire on prose, be muted within a week, and catch nothing.
 *
 * Usage: npx tsx scripts/check-no-service-account-keys.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { walkSources } from './lib/walk-sources.js'

const ROOT = path.resolve(import.meta.dirname, '..')

/** Directories never worth walking. */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.nx',
  '.next',
  'ios',
  'android',
  'releases',
])

/** Only text this repo actually authors. A binary is not scanned. */
const SCAN_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.yml',
  '.yaml',
  '.env',
  '.sh',
  '.md',
  '.pem',
  '.txt',
])

/** Bigger than any hand-written source file here; a bundle is not our problem. */
const MAX_BYTES = 2_000_000

interface Rule {
  readonly id: string
  readonly explain: string
  readonly test: (content: string) => boolean
  /** Single-line pattern used only to report WHERE. Never to decide. */
  readonly locate: RegExp
}

/**
 * A Google service-account key is a JSON object carrying BOTH
 * `"type": "service_account"` and a `private_key`. Requiring both is what keeps
 * the rule off documentation that merely names the field.
 */
const serviceAccountJson: Rule = {
  id: 'google-service-account-key',
  explain:
    'a Google service-account key (`"type": "service_account"` + `private_key`). Full write access to a Cloud project — it belongs in an operator-supplied file or environment variable, never in this repository.',
  test: (content) =>
    /"type"\s*:\s*"service_account"/.test(content) && /"private_key"\s*:\s*"/.test(content),
  locate: /"type"\s*:\s*"service_account"/,
}

/**
 * A PEM private key WITH a body.
 *
 * The BEGIN marker alone is not enough and the first run proved it: two files
 * assert `key.startsWith('-----BEGIN PRIVATE KEY-----')` about a certificate
 * this repo generates at runtime, which is exactly the correct pattern. A rule
 * that fires on those is a rule someone deletes. Requiring an encoded body and
 * a matching END marker is what separates a leak from a string literal.
 */
const pemPrivateKey: Rule = {
  id: 'pem-private-key',
  explain:
    'a PEM private key block with key material. Test fixtures must generate keys at runtime (`node:crypto`), never carry one in the tree.',
  test: (content) =>
    /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{100,}-----END/.test(
      content,
    ),
  locate: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
}

const RULES: readonly Rule[] = [serviceAccountJson, pemPrivateKey]

/**
 * This guard's own source names both patterns, and so may a decision record
 * that explains the rule. Allow-listed by PATH, exactly — never by a magic
 * comment a real leak could also carry.
 */
const ALLOWED_PATHS: readonly string[] = [
  'scripts/check-no-service-account-keys.ts',
  'docs/decisions/adr-0269-a-google-export-that-holds-no-google-credential.md',
]

interface Finding {
  readonly file: string
  readonly rule: Rule
  readonly line: number
}

/**
 * What a commit CARRIES, nothing else. This used to `readdir` from the
 * repository root and descend into every untracked tree that was not on a
 * skip list — 130 s under load on 2026-09-20, for a guard whose subject is
 * "did a credential reach a commit". `git ls-files` answers exactly that.
 * `source` is scanned VERBATIM: a private key in a comment is still a leak.
 */
function trackedFiles(): readonly string[] {
  const listed = walkSources(ROOT, ['.'], {
    extensions: [...SCAN_EXTENSIONS],
    includeTests: true,
    includeDeclarations: true,
    includeBuildOutput: true,
  }).map((f) => f.file)
  // Extensionless `.env*` files carry no extension for the filter to see.
  const envFiles = walkSources(ROOT, ['.'], {
    extensions: [''],
    includeTests: true,
    includeBuildOutput: true,
  })
    .filter((f) => path.basename(f.rel).startsWith('.env'))
    .map((f) => f.file)
  return [...listed, ...envFiles].filter(
    (f) => !SKIP_DIRS.has(path.relative(ROOT, f).split(path.sep)[0] ?? ''),
  )
}

function firstMatchingLine(content: string, rule: Rule): number {
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line !== undefined && rule.locate.test(line)) return i + 1
  }
  return 0
}

function main(): void {
  const files = trackedFiles()

  const findings: Finding[] = []
  for (const file of files) {
    const relative = path.relative(ROOT, file)
    if (ALLOWED_PATHS.includes(relative)) continue
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      continue
    }
    if (stat.size > MAX_BYTES) continue
    let content: string
    try {
      content = fs.readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    for (const rule of RULES) {
      if (!rule.test(content)) continue
      findings.push({ file: relative, rule, line: firstMatchingLine(content, rule) })
    }
  }

  if (findings.length === 0) {
    console.log(`  ✔ no committed private credentials (${files.length} files scanned)`)
    return
  }

  console.error('\n  ✖ committed private credential(s) found\n')
  for (const finding of findings) {
    // Location and rule only. The guard never prints the matched text — a CI
    // log is one more place a leaked key would then live.
    const at = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file
    console.error(`    ${at}`)
    console.error(`      ${finding.rule.id} — ${finding.rule.explain}\n`)
  }
  console.error('  Rotate anything that reached a commit; removing the file is not enough.\n')
  process.exit(1)
}

main()
