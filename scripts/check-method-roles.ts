#!/usr/bin/env tsx
/**
 * Method roles (D921): what each cap method is for a VIEWER.
 *
 * `METHOD_ACCESS_MAP[path].role` is resolved from the cap definitions by
 * `resolveMethodRole` — the one source. This guard refuses:
 *   - a role outside `public | viewer | admin | feature:<catalog id>`;
 *   - a catalog feature no method carries (an empty toggle in the admin UI);
 *   - a credential / account / installation method a viewer could reach;
 *   - an actuation method (D403's list) a viewer could NOT reach;
 *   - a cap-level `role: 'viewer'` — it would hand a viewer every admin method
 *     of the cap at once; baseline is decided method by method;
 *   - any change against `scripts/method-role-baseline.json` that was not
 *     accepted with `--update` (the diff a reviewer reads, as for tiers).
 *
 *   npx tsx scripts/check-method-roles.ts            # check
 *   npx tsx scripts/check-method-roles.ts --update   # accept current roles
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  ALL_CAPABILITY_DEFINITIONS,
  featureOfRole,
  METHOD_ACCESS_MAP,
  VIEWER_FEATURE_IDS,
} from '../packages/types/src/index.js'
import { ACTUATION_CAPS } from './lib/actuation-caps.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const BASELINE_FILE = path.join(ROOT, 'scripts/method-role-baseline.json')

/** Never reachable by a viewer, whatever a label says. */
const ADMIN_ONLY: readonly RegExp[] = [
  // `getStatus` is the password-free status slice (camera-credentials.cap.ts).
  /^cameraCredentials\.(?!getStatus$)/,
  /^deviceCredentials\./,
  /^keychain\./,
  /^userManagement\./,
  /^deviceManager\.(loadConfig|persistConfig|updateConfig|loadRuntimeState|remove)$/,
  /^addons\.(install|uninstall|update)/,
  /^serverManagement\./,
  /^backup/,
]

export interface RoleViolation {
  readonly path: string
  readonly reason: string
}

export function roleViolations(): RoleViolation[] {
  const out: RoleViolation[] = []
  const used = new Set<string>()
  for (const [p, rec] of Object.entries(METHOD_ACCESS_MAP)) {
    const role = rec.role
    const feature = featureOfRole(role)
    if (role.startsWith('feature:')) {
      if (feature === null) out.push({ path: p, reason: `unknown feature in role '${role}'` })
      else used.add(feature)
    } else if (role !== 'public' && role !== 'viewer' && role !== 'admin') {
      out.push({ path: p, reason: `unknown role '${role}'` })
    }
    if (role !== 'admin' && ADMIN_ONLY.some((re) => re.test(p))) {
      out.push({ path: p, reason: `credential/administration method labelled '${role}'` })
    }
    if (ACTUATION_CAPS.includes(rec.capName) && role !== 'viewer') {
      out.push({
        path: p,
        reason: `actuation method labelled '${role}' — a viewer must operate it`,
      })
    }
  }
  for (const id of VIEWER_FEATURE_IDS) {
    if (!used.has(id))
      out.push({ path: `feature:${id}`, reason: 'catalog feature no method carries' })
  }
  for (const def of ALL_CAPABILITY_DEFINITIONS) {
    if (def.role === 'viewer') {
      out.push({ path: def.name, reason: "cap-level role 'viewer' — label methods one by one" })
    }
  }
  return out
}

function currentRoles(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of Object.keys(METHOD_ACCESS_MAP).sort()) {
    const rec = METHOD_ACCESS_MAP[p]
    if (rec !== undefined) out[p] = rec.role
  }
  return out
}

function readBaseline(): Record<string, string> {
  if (!fs.existsSync(BASELINE_FILE)) return {}
  const raw: unknown = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
  const out: Record<string, string> = {}
  if (raw !== null && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v
  }
  return out
}

function main(): void {
  const violations = roleViolations()
  if (violations.length > 0) {
    console.error(`✖ method roles: ${violations.length} violation(s)`)
    for (const v of violations) console.error(`  • ${v.path}: ${v.reason}`)
    process.exit(1)
  }
  const current = currentRoles()
  if (process.argv.includes('--update')) {
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(current, null, 2)}\n`)
    console.log(`✔ method-role baseline updated: ${Object.keys(current).length} methods`)
    return
  }
  const baseline = readBaseline()
  const drift: string[] = []
  for (const [p, role] of Object.entries(current)) {
    if (baseline[p] !== role) drift.push(`${p}: ${baseline[p] ?? '(new)'} → ${role}`)
  }
  for (const p of Object.keys(baseline)) if (!(p in current)) drift.push(`${p}: removed`)
  if (drift.length > 0) {
    console.error('✖ method-role drift — review each line:')
    for (const d of drift) console.error(`  • ${d}`)
    console.error('\n  If every line is intended: npx tsx scripts/check-method-roles.ts --update')
    process.exit(1)
  }
  const counts = new Map<string, number>()
  for (const role of Object.values(current)) counts.set(role, (counts.get(role) ?? 0) + 1)
  const summary = [...counts.entries()]
    .sort()
    .map(([r, n]) => `${r} ${n}`)
    .join(', ')
  console.log(`✔ method roles: ${Object.keys(current).length} methods (${summary})`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
