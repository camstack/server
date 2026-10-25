#!/usr/bin/env tsx
/**
 * Actuation guard — using a device is not administering the system.
 *
 * ── The bug this prevents ──────────────────────────────────────────────────
 * Measured on the live hub, 2026-09-08: a non-admin household user held a
 * `device` grant of `{selector: {kind: 'all'}, access: ['view','create'],
 * includeLinked: true}` — a deliberate, explicit grant over every camera AND
 * its accessory children — and could not turn on a single light. Every
 * actuation method of every control cap declared `auth: 'admin'`, and
 * `resolveMethodAuth` → `procedureAuthKey` sends `'admin'` to a procedure that
 * checks `isAdmin` and NEVER consults the scope set. The grant was correct,
 * complete and unreachable: the device-scope matcher (selector +
 * `includeLinked` + the ancestor walk) is dead code for any method marked
 * admin.
 *
 * The failure is silent in the worst way — the UI renders the control, because
 * the cap is bound to the device, and only the tap fails.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * A cap in {@link ACTUATION_CAPS} — the caps whose whole surface is "use this
 * device", the set the viewer's accessory-control registry renders — declares
 * NO method with `auth: 'admin'`. Those methods are governed by the caller's
 * `device` grant, which is what that grant was built to express.
 *
 * This is deliberately an ALLOWLIST, not a heuristic over every device cap.
 * `reboot`, `camera-credentials`, `privacy-mask`, `zones`, `osd`,
 * `script-runner` and friends are device-scoped and ARE administration; a
 * guard that inferred "device cap ⇒ not admin" would hand a house guest the
 * camera's credentials. Adding a cap here is a decision, made once, in a diff
 * someone reviewed. See D403.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACTUATION_CAPS } from './lib/actuation-caps.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CAPS_DIR = path.join(ROOT, 'packages/types/src/capabilities')

interface Violation {
  readonly capName: string
  readonly count: number
}

function main(): void {
  const violations: Violation[] = []
  const missing: string[] = []

  for (const capName of ACTUATION_CAPS) {
    const file = path.join(CAPS_DIR, `${capName}.cap.ts`)
    if (!fs.existsSync(file)) {
      missing.push(capName)
      continue
    }
    const source = fs.readFileSync(file, 'utf8')
    const count = source.split("auth: 'admin'").length - 1
    if (count > 0) violations.push({ capName, count })
  }

  if (violations.length === 0 && missing.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      `  \x1b[32m✔\x1b[0m  actuation guard: ${ACTUATION_CAPS.length} control caps, none admin-gated`,
    )
    return
  }

  // eslint-disable-next-line no-console
  console.error('\n\x1b[31m✘ actuation guard failed\x1b[0m')
  for (const v of violations) {
    // eslint-disable-next-line no-console
    console.error(
      `    - ${v.capName}: ${v.count} method(s) still \`auth: 'admin'\` — a device grant cannot reach them (D403)`,
    )
  }
  for (const capName of missing) {
    // eslint-disable-next-line no-console
    console.error(`    - ${capName}: listed as an actuation cap but ${capName}.cap.ts is gone`)
  }
  // eslint-disable-next-line no-console
  console.error('')
  process.exit(1)
}

main()
