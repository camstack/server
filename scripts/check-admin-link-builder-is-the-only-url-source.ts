#!/usr/bin/env tsx
/**
 * Admin-link URL guard — **`buildDeviceAdminUrl` is the only place a
 * `device-admin-link` URL is assembled.**
 *
 * ## The failure this catches
 *
 * Every provider that can answer `device-admin-link` holds the device's host in
 * the same object as its password: `{ host, port, username, password }` is the
 * literal shape of the Hikvision, Amcrest, Reolink and ONVIF device configs.
 * The helpful version of this feature is one template literal away —
 *
 *     url: `http://${cfg.username}:${cfg.password}@${cfg.host}/`
 *
 * — it works, browsers accept it, and it puts a live camera credential in the
 * DOM, in a right-click → copy, in a screenshot and in any log line that prints
 * what was opened. `scripts/check-no-credential-urls-in-fixtures.ts` exists
 * because this repo already shipped that leak on the RTSP surfaces; this guard
 * is the same rule applied at the SOURCE rather than at the recording.
 *
 * The second failure is quieter and was found on the live fleet on 2026-09-22:
 * a provider that reads a `port` field without knowing what that port IS.
 * Reolink's device config carries `port: 9000` — the Baichuan media port — and
 * `http://192.168.x.x:9000/` refuses the connection while `:80` answers 200.
 * A hand-rolled URL has nowhere to record that; the builder's `port: number |
 * null` argument, with its docblock, is that place.
 *
 * ## What it checks
 *
 * Every `getAdminLink:` implementation under `packages/` — the body of the one
 * method `device-admin-link` has — must:
 *
 *   1. call `buildDeviceAdminUrl(`, and
 *   2. contain no string or template literal that assembles a scheme and an
 *      authority itself (`http://…`, `https://…`, `${…}://…`).
 *
 * The scan is the METHOD BODY, not the file: the same camera classes legitimately
 * build `rtsp://user:pass@host/…` a few hundred lines away, for a stream the
 * broker dials rather than a page a browser opens. A file-wide rule fired on
 * seven of those and would have been deleted within the week.
 *
 * The cap definition, the builder and the builder's own tests are exempt by
 * path — they are where those strings legitimately live.
 *
 * Usage: tsx scripts/check-admin-link-builder-is-the-only-url-source.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/** Files that ARE the implementation of the rule, not consumers of it. */
const EXEMPT: readonly string[] = [
  'packages/types/src/capabilities/device-admin-link.cap.ts',
  'packages/types/src/capabilities/device-admin-link-url.ts',
  'packages/types/src/capabilities/__tests__/device-admin-link-url.spec.ts',
]

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'worktrees', '__tests__'])

/** The one method a `device-admin-link` provider implements. */
const METHOD = 'getAdminLink'
/** The only sanctioned URL source. */
const BUILDER = 'buildDeviceAdminUrl'
/** Upper bound on a method body, so a malformed file cannot swallow a module. */
const MAX_BODY_LINES = 120

/**
 * A literal that assembles scheme + authority. Deliberately broad: it fires on
 * `'http://'`, on a backtick template with `://` in it, and on `${scheme}://`.
 * A provider has no reason to write any of them — the builder takes the scheme
 * as a typed argument.
 */
const SELF_ASSEMBLED_URL = /(['"`])[^'"`\n]*:\/\/|\$\{[^}\n]*\}:\/\//

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), out)
      continue
    }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
    if (entry.name.includes('.spec.') || entry.name.includes('.test.')) continue
    out.push(path.join(dir, entry.name))
  }
}

const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/')

interface Problem {
  readonly where: string
  readonly line: number
  readonly what: string
}

/**
 * The lines of one `getAdminLink` implementation: from its declaration to the
 * `registerNativeCap` that publishes it, bounded so a malformed file cannot
 * swallow the rest of the module.
 */
function methodBodies(lines: readonly string[]): readonly { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  lines.forEach((line, i) => {
    if (!line.includes(`${METHOD}:`)) return
    let end = Math.min(lines.length - 1, i + MAX_BODY_LINES)
    for (let j = i + 1; j <= end; j += 1) {
      const candidate = lines[j]
      if (candidate !== undefined && candidate.includes('registerNativeCap(')) {
        end = j
        break
      }
    }
    out.push({ start: i, end })
  })
  return out
}

function main(): void {
  const files: string[] = []
  walk(path.join(ROOT, 'packages'), files)

  const problems: Problem[] = []
  let checked = 0

  for (const file of files) {
    const relative = rel(file)
    if (EXEMPT.includes(relative)) continue
    if (relative.includes('/src/generated/')) continue
    const lines = fs.readFileSync(file, 'utf-8').split('\n')
    const bodies = methodBodies(lines)
    if (bodies.length === 0) continue

    for (const body of bodies) {
      checked += 1
      const slice = lines.slice(body.start, body.end + 1)
      const text = slice.join('\n')

      if (!text.includes(`${BUILDER}(`)) {
        problems.push({
          where: relative,
          line: body.start + 1,
          what: `${METHOD} does not call ${BUILDER}()`,
        })
      }

      slice.forEach((line, offset) => {
        const trimmed = line.trimStart()
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) return
        if (SELF_ASSEMBLED_URL.test(line)) {
          problems.push({
            where: relative,
            line: body.start + offset + 1,
            what: `assembles a URL itself: ${trimmed.slice(0, 100)}`,
          })
        }
      })
    }
  }

  if (problems.length > 0) {
    console.error(
      `\x1b[31m✘ ${problems.length} device-admin-link URL(s) not built by ${BUILDER}\x1b[0m:`,
    )
    for (const p of problems) console.error(`    ${p.where}:${p.line} — ${p.what}`)
    console.error(
      `\n    Every device-admin-link URL goes through ${BUILDER}(), which takes host,\n` +
        '    port, scheme and path as separate arguments so no credential can be passed in,\n' +
        '    and re-checks its own output for `scheme://user:pass@`. A hand-rolled URL has no\n' +
        '    such gate, and the password sits in the same config object as the host.',
    )
    process.exit(1)
  }

  console.log(
    `  ✔ ${String(checked)} getAdminLink implementation(s) build their URL via ${BUILDER}`,
  )
}

main()
