/**
 * The device-name rule has one definition. The viewer cannot import
 * ui-library (it is a web package; the viewer is React Native) and it resolves
 * `@camstack/types` from an installed release, so it keeps a copy of
 * `format-device-name.ts`. This fails when the two diverge.
 *
 * The viewer half skips when `camstack/` is not checked out, and says so.
 * "I could not look" is not "I looked and it was fine".
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const CANONICAL = 'packages/ui-library/src/composites/device-name/format-device-name.ts'
const VIEWER_COPY = 'camstack/src/data/device-name.ts'

function body(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n').trim()
}

const viewerPresent = existsSync(join(ROOT, VIEWER_COPY))
if (!viewerPresent) {
  console.log(`  ✔ device-name rule: canonical file is present`)
  console.log(
    `  ⊘ viewer copy NOT checked: ${VIEWER_COPY} is absent (the camstack/ submodule is not checked out here) — run \`git submodule update --init camstack\` to check it`,
  )
  process.exit(0)
}

const canonical = body(CANONICAL)
const viewer = body(VIEWER_COPY)
if (canonical !== viewer) {
  console.error('✗ device-name rule: the viewer copy has drifted from the canonical file')
  console.error(`  canonical: ${CANONICAL}`)
  console.error(`  viewer:    ${VIEWER_COPY}`)
  process.exit(1)
}
console.log('  ✔ device-name rule: viewer copy identical')
