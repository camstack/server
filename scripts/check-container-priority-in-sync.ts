/**
 * The container-child precedence has ONE definition and one copy that cannot
 * import it. This makes that fact checkable instead of asking for it in a
 * comment.
 *
 * `packages/types/src/device/container-primary-child.ts` is the definition.
 * admin-ui's ui-library, the server's linked-devices expansion and the viewer
 * (`resolveContainerPrimaryChild` through `@camstack/types/client`) import it.
 * The Home Assistant provider cannot: it expresses the same precedence over the
 * `DeviceType` ENUM, because it answers a different question (what type should
 * the adopted PARENT be) from the same ordering. A copy that drifts makes the
 * adoption preview name a DIFFERENT child as "the container" than admin-ui.
 */
import { readFileSync } from 'node:fs'
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
const problems: string[] = []

if (canonical.length === 0)
  problems.push('the canonical list is empty — the parser is broken, not the data')
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
console.log(
  `  ✔ container-child precedence: ${canonical.length} entries, ${haValues.length} HA types in agreement`,
)
