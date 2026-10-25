/**
 * The container-child precedence has ONE definition and two copies that cannot
 * import it. This makes that fact checkable instead of asking for it in a
 * comment.
 *
 * `packages/types/src/device/container-primary-child.ts` is the definition.
 * admin-ui's ui-library and the server's linked-devices expansion import it
 * directly. Two consumers cannot:
 *
 *   - the VIEWER (`camstack/`) resolves `@camstack/types` from its own
 *     `node_modules` — an installed release, not this workspace — so a newly
 *     added export is simply absent at runtime there;
 *   - the Home Assistant provider expresses the same precedence over the
 *     `DeviceType` ENUM, because it answers a different question (what type
 *     should the adopted PARENT be) from the same ordering.
 *
 * Both therefore keep a copy, and both are checked here. A copy that drifts
 * makes admin-ui, the viewer's panel and the adoption preview name DIFFERENT
 * children as "the container", which reads as three bugs rather than one
 * divergence.
 *
 * ── When the viewer is not on disk ─────────────────────────────────────────
 * `camstack/` is a git SUBMODULE. It is absent in a fresh worktree and in CI
 * (`actions/checkout` runs without `submodules: true`), and this guard used to
 * read its copy unconditionally: ENOENT, an uncaught throw, and the ENTIRE
 * pre-commit hook died on it. Every agent working in a worktree then committed
 * with `--no-verify`, so the real cost was never the viewer check — it was the
 * formatter, the docs regeneration and the dozen guards that run after this
 * line and stopped running at all.
 *
 * So the viewer half SKIPS when the submodule is absent, and says so. It must
 * never print the same verdict as a check that ran: "I could not look" and "I
 * looked and it was fine" are different answers (D315), and a guard that
 * collapses them is decoration. The Home Assistant half is in THIS repository
 * and is always enforced.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

/** Pull a string-array literal's entries out of a source file, by const name. */
function readList(relPath: string, constName: string): readonly string[] {
  const src = readFileSync(join(ROOT, relPath), 'utf8')
  const at = src.indexOf(`${constName}: readonly string[] =`)
  if (at === -1) throw new Error(`${relPath}: no ${constName} declaration`)
  // Anchor past the `readonly string[]` annotation — its own brackets are the
  // first ones after the name, and slicing between them yields nothing.
  const open = src.indexOf('[', src.indexOf('=', at))
  const close = src.indexOf(']', open)
  if (open === -1 || close === -1)
    throw new Error(`${relPath}: ${constName} is not an array literal`)
  return [...src.slice(open + 1, close).matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/** The HA copy lists `DeviceType.X` members; map them through the enum's values. */
function readEnumList(relPath: string, constName: string): readonly string[] {
  const src = readFileSync(join(ROOT, relPath), 'utf8')
  const at = src.indexOf(`${constName}: readonly DeviceType[]`)
  if (at === -1) throw new Error(`${relPath}: no ${constName}`)
  // Past the `readonly DeviceType[]` annotation, as above.
  const open = src.indexOf('[', src.indexOf('=', at))
  let depth = 0
  let close = open
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++
    else if (src[i] === ']' && --depth === 0) {
      close = i
      break
    }
  }
  return [...src.slice(open + 1, close).matchAll(/DeviceType\.(\w+)/g)].map((m) => m[1])
}

const canonical = readList(
  'packages/types/src/device/container-primary-child.ts',
  'CONTAINER_CHILD_PRIORITY',
)
const VIEWER_COPY = 'camstack/src/components/camera/accessory-controls/container-primary.ts'
const viewerPresent = existsSync(join(ROOT, VIEWER_COPY))
const viewer = viewerPresent ? readList(VIEWER_COPY, 'CONTAINER_CHILD_PRIORITY') : null

const problems: string[] = []

if (canonical.length === 0)
  problems.push('the canonical list is empty — the parser is broken, not the data')
if (viewer !== null && JSON.stringify(viewer) !== JSON.stringify(canonical)) {
  problems.push(
    `the viewer's copy has drifted.\n    canonical: ${canonical.join(', ')}\n    viewer:    ${viewer.join(', ')}`,
  )
}

// The HA list is enum MEMBER names, so compare the ORDER of the types both
// mention rather than the spellings. It legitimately omits entries (it only
// ranks the types adoption can produce); it must never CONTRADICT the order.
const haMembers = readEnumList(
  'packages/addon-provider-homeassistant/src/ha-domain-mapping.ts',
  'PARENT_TYPE_PRIORITY',
)
const memberToValue = (m: string): string => m.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
const haValues = haMembers.map(memberToValue).filter((v) => canonical.includes(v))
const canonicalOrderOfHa = canonical.filter((v) => haValues.includes(v))
if (haValues.length === 0) {
  // Checking nothing and printing a tick is how a guard becomes decoration.
  problems.push('parsed 0 Home Assistant types — the parser is broken, not the data')
}
if (JSON.stringify(haValues) !== JSON.stringify(canonicalOrderOfHa)) {
  problems.push(
    `the Home Assistant adoption precedence contradicts the canonical order.\n    canonical: ${canonicalOrderOfHa.join(', ')}\n    ha:        ${haValues.join(', ')}`,
  )
}

if (problems.length > 0) {
  console.error('✗ container-child precedence guard')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
if (viewer === null) {
  // Two lines, deliberately: the tick is about what was checked, and the skip
  // is not allowed to hide inside it.
  console.log(
    `  ✔ container-child precedence: ${canonical.length} entries, ${haValues.length} HA types in agreement`,
  )
  console.log(
    `  ⊘ viewer copy NOT checked: ${VIEWER_COPY} is absent (the camstack/ submodule is not checked out here) — run \`git submodule update --init camstack\` to check it`,
  )
} else {
  console.log(
    `  ✔ container-child precedence: ${canonical.length} entries, viewer copy identical, ${haValues.length} HA types in agreement`,
  )
}
