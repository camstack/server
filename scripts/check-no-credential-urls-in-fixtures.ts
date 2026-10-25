#!/usr/bin/env tsx
/**
 * Credential-URL fixture guard — a RECORDED cap-output fixture must never carry
 * a live camera credential.
 *
 * ## The failure this catches
 *
 * The stream surfaces (`cameraStreams.getRtspEntries`, `streamBroker.getRtspEntry`,
 * `deviceOps.getStreamSources`, …) hand back `rtsp://admin:hunter2@host/…`. A
 * non-admin caller reaching one got the camera's own credentials verbatim — a
 * read-only token could open every camera by copy-paste. The wire fix lives in
 * `device-config-secret-redaction.ts` (`redactStreamUrlSecrets`, registered in
 * `NON_ADMIN_CONFIG_REDACTED_METHODS`).
 *
 * A snapshot or golden fixture records the SHAPE a method returns. If a recorded
 * output contains embedded userinfo (`scheme://user:pass@host`), either a real
 * credential was checked into the repo, or the redaction was removed and the
 * golden captured the leak. Both must fail the build.
 *
 * ## What it checks
 *
 * Every RECORDED-OUTPUT file — `*.snap`, and anything under a `__fixtures__/` or
 * `/fixtures/` directory, plus `*.fixture.json` / `*.golden.json` — under
 * `packages/` and `server/` is scanned for a URL that embeds userinfo. A hand
 * written source file or a masking unit-test (which legitimately contains such a
 * string as INPUT) is NOT a recorded output and is not scanned — this keeps the
 * guard free of the false positives that get a guard deleted.
 *
 * Usage: tsx scripts/check-no-credential-urls-in-fixtures.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/**
 * A URL that embeds `user:password@` userinfo. Anchored to a scheme so a bare
 * `host:port/path` (no `@`) never matches; the userinfo halves forbid `/`, `@`,
 * whitespace and quotes so it cannot run past the authority component.
 */
const CREDENTIAL_URL = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@'"]+:[^/\s:@'"]+@/i

/** Directories never worth walking. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage'])

/**
 * Is this a RECORDED-OUTPUT file — a golden/snapshot whose content is a captured
 * method result, not hand-authored source? Only these are scanned.
 */
function isRecordedOutput(relative: string): boolean {
  if (relative.endsWith('.snap')) return true
  if (relative.includes('/__fixtures__/') || relative.includes('/fixtures/')) return true
  if (relative.endsWith('.fixture.json') || relative.endsWith('.golden.json')) return true
  return false
}

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), out)
      continue
    }
    out.push(path.join(dir, entry.name))
  }
}

const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/')

interface Problem {
  readonly where: string
  readonly line: number
  readonly excerpt: string
}

function main(): void {
  const files: string[] = []
  for (const root of ['packages', 'server']) walk(path.join(ROOT, root), files)

  const problems: Problem[] = []
  for (const file of files) {
    const relative = rel(file)
    if (relative.includes('/worktrees/') || !isRecordedOutput(relative)) continue
    const lines = fs.readFileSync(file, 'utf-8').split('\n')
    lines.forEach((line, i) => {
      const m = CREDENTIAL_URL.exec(line)
      if (m) problems.push({ where: relative, line: i + 1, excerpt: m[0] })
    })
  }

  if (problems.length > 0) {
    console.error(
      `\x1b[31m✘ ${problems.length} recorded fixture(s) contain a credential URL (scheme://user:pass@)\x1b[0m:`,
    )
    for (const p of problems) {
      console.error(`    ${p.where}:${p.line} — ${p.excerpt}…`)
    }
    console.error(
      '    A recorded cap output must never carry userinfo. Either a real credential was committed,\n' +
        '    or `redactStreamUrlSecrets` (device-config-secret-redaction.ts) stopped masking and the\n' +
        '    golden captured the leak. Re-record after fixing the redaction, or scrub the credential.',
    )
    process.exit(1)
  }
  console.log('  ✔ no recorded fixture embeds a credential URL')
}

main()
