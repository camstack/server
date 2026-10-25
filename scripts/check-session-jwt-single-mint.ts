#!/usr/bin/env tsx
/**
 * D712 guard — a session JWT is signed in ONE place.
 *
 * `server/backend/src/auth/session-mint.ts` is the session mint: it signs from
 * the user record as it is at mint time. `/api/auth/sso/finish` used to sign
 * its own session from a bridge's claims (`allowedDevices: {}`, no scopes, the
 * bridge's `isAdmin`), so a deleted or demoted user's magic-link still minted
 * a session. Any other `.signToken(` call is a second mint that can do the same.
 *
 * Two rules, over every production `.ts` / `.tsx` under `server/` and
 * `packages/` (tests, `dist`, `node_modules` and generated code are skipped):
 *
 *   1. `.signToken(` appears only in the session mint.
 *   2. `jwt.sign(` appears only in `AuthManager`, which owns the secret.
 *
 * Usage: npx tsx scripts/check-session-jwt-single-mint.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')
const SCAN_ROOTS = ['server', 'packages'].map((dir) => path.join(ROOT, dir))
const SKIP_DIRS = new Set(['dist', 'node_modules', '__tests__', '.git', 'coverage', 'generated'])

const SESSION_MINT = path.join(ROOT, 'server/backend/src/auth/session-mint.ts')
const AUTH_MANAGER = path.join(ROOT, 'packages/system/src/auth/auth-manager.ts')

interface Rule {
  readonly pattern: RegExp
  readonly allowed: string
  readonly reason: string
}

const RULES: readonly Rule[] = [
  {
    pattern: /\.signToken\s*\(/,
    allowed: SESSION_MINT,
    reason: 'a session JWT is signed only by the session mint (createSessionMinter, D712)',
  },
  {
    pattern: /\bjwt\.sign\s*\(/,
    allowed: AUTH_MANAGER,
    reason: 'only AuthManager signs a JWT with the hub secret (D712)',
  },
]

function isProductionSource(name: string): boolean {
  if (!/\.tsx?$/.test(name) || name.endsWith('.d.ts')) return false
  return !/\.(spec|test)\.tsx?$/.test(name)
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile() && isProductionSource(entry.name)) out.push(full)
  }
  return out
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

const violations: string[] = []
for (const file of SCAN_ROOTS.flatMap((dir) => walk(dir))) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    if (isCommentLine(line)) return
    for (const rule of RULES) {
      if (file !== rule.allowed && rule.pattern.test(line)) {
        violations.push(
          `${path.relative(ROOT, file)}:${index + 1}: ${line.trim()}\n    → ${rule.reason}`,
        )
      }
    }
  })
}

if (violations.length === 0) {
  console.log('check-session-jwt-single-mint: OK — one session mint, one JWT signer')
  process.exit(0)
}
console.error(`check-session-jwt-single-mint: ${violations.length} violation(s)\n`)
for (const v of violations) console.error(`  ${v}`)
process.exit(1)
