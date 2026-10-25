#!/usr/bin/env tsx
/**
 * No OAuth client secret may live in a publishable package.
 *
 * ## The failure this catches
 *
 * `@camstack/addon-export-alexa` committed the built-in Alexa skill's Login
 * With Amazon "Send Alexa Events" client secret to source (`public-skill.ts`),
 * with a comment explaining why that was fine. The package is PUBLIC on npm, so
 * every one of its versions shipped the secret to anyone who ran `npm pack`.
 * Rotating it is the fix; this guard is what stops the next one. D753 moved
 * the secret into the skill's Lambda (SSM Parameter Store, D761) behind a token
 * broker — no hub and no npm package holds it any more.
 *
 * ## What it checks
 *
 * Every git-tracked file of every workspace package that is NOT
 * `"private": true` (they are the ones that reach the registry), plus
 * `server/backend`. A file matches when it contains a client-secret-SHAPED
 * value:
 *
 *   - a Login With Amazon client secret (`amzn1.oa2-cs.v1.<hex>`),
 *   - a Google OAuth client secret (`GOCSPX-…`),
 *   - any `client_secret` / `clientSecret` key assigned a literal of 20+
 *     token characters — the shape a pasted secret takes whatever the vendor.
 *
 * Placeholders (`'<your secret>'`, `'s'`, `''`) do not match. There is no
 * opt-out comment on purpose: a real secret has no legitimate reason to be in
 * a published file, and a test fixture can build its value at runtime.
 *
 * Usage: npx tsx scripts/check-no-client-secrets.ts
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export interface SecretPattern {
  readonly id: string
  readonly description: string
  readonly regex: RegExp
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: 'lwa-client-secret',
    description: 'Login With Amazon client secret',
    regex: /amzn1\.oa2-cs\.v1\.[0-9a-f]{32,}/i,
  },
  {
    id: 'google-oauth-client-secret',
    description: 'Google OAuth client secret',
    regex: /GOCSPX-[A-Za-z0-9_-]{20,}/,
  },
  {
    id: 'client-secret-literal',
    description: 'client secret assigned a literal value',
    regex: /\bclient[_-]?secret\b["'`]?\s*[:=]\s*["'`][A-Za-z0-9._~+/=-]{20,}["'`]/i,
  },
]

export interface SecretFinding {
  readonly file: string
  readonly line: number
  readonly pattern: string
}

/** Scan one file's text. Never returns the matched value — only where it is. */
export function findClientSecrets(file: string, text: string): readonly SecretFinding[] {
  const out: SecretFinding[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    for (const p of SECRET_PATTERNS) {
      if (p.regex.test(line)) out.push({ file, line: i + 1, pattern: p.id })
    }
  }
  return out
}

/** Directories of workspace packages that reach the npm registry. */
export function publishablePackageDirs(root: string): readonly string[] {
  const dirs: string[] = []
  const pkgRoot = join(root, 'packages')
  if (existsSync(pkgRoot)) {
    for (const name of readdirSync(pkgRoot)) {
      const pj = join(pkgRoot, name, 'package.json')
      if (!existsSync(pj)) continue
      try {
        const pkg = JSON.parse(readFileSync(pj, 'utf8')) as { private?: unknown }
        if (pkg.private !== true) dirs.push(join(pkgRoot, name))
      } catch {
        // An unparseable package.json is another guard's problem; scan it anyway.
        dirs.push(join(pkgRoot, name))
      }
    }
  }
  const backend = join(root, 'server', 'backend')
  if (existsSync(join(backend, 'package.json'))) dirs.push(backend)
  return dirs
}

/** Generated fixtures / vendored bundles above this are not hand-written config. */
const MAX_SCAN_BYTES = 4 * 1024 * 1024

const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|onnx|tflite|bin|zip|gz|tgz|woff2?|ttf|mp4|wasm|node)$/i

function trackedFiles(root: string, dir: string): readonly string[] {
  const rel = relative(root, dir)
  const raw = execFileSync('git', ['ls-files', '-z', '--', rel], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  return raw.split('\0').filter((f) => f.length > 0 && !BINARY_EXT.test(f))
}

export function scanRepo(root: string): readonly SecretFinding[] {
  const findings: SecretFinding[] = []
  for (const dir of publishablePackageDirs(root)) {
    for (const file of trackedFiles(root, dir)) {
      const abs = join(root, file)
      if (!existsSync(abs) || statSync(abs).size > MAX_SCAN_BYTES) continue
      findings.push(...findClientSecrets(file, readFileSync(abs, 'utf8')))
    }
  }
  return findings
}

function main(): void {
  const findings = scanRepo(process.cwd())
  if (findings.length === 0) {
    console.log('✔ no client-secret-shaped value in any publishable package')
    return
  }
  console.error(
    '✘ client-secret-shaped value(s) in a PUBLISHABLE package (the value is not printed):',
  )
  for (const f of findings) console.error(`    ${f.file}:${f.line}  [${f.pattern}]`)
  console.error(
    [
      '',
      'A published package is public: anything in it is leaked the moment it is on npm.',
      'Keep the secret where it is used (e.g. the Alexa Lambda reads it from SSM',
      'Parameter Store — D753/D761) and give the package a credential that is per-install',
      'and revocable instead. If the value was ever committed, ROTATE it — removing it',
      'from HEAD does not remove it from git history or from published versions.',
    ].join('\n'),
  )
  process.exit(1)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
