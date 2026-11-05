/**
 * A native `<select>` is written in ONE place: the `Select` primitive
 * (`packages/ui-library/src/primitives/select.tsx`), which carries the field
 * chrome, the chevron and the disabled affordance. A raw `<select>` anywhere
 * else in the admin UI or the library is a second, unstyled dropdown.
 *
 * Specs may render a raw `<select>` as a test double; they are not scanned.
 * Baseline is empty: there is no allow-list to grow.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const ROOTS: readonly string[] = ['packages/addon-admin-ui/src', 'packages/ui-library/src']
const PRIMITIVE = 'packages/ui-library/src/primitives/select.tsx'
const TEST_FILE = /(__tests__\/|\.(test|spec)\.tsx?$)/
const RAW_SELECT = /<select[\s>/]/

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith('.tsx')) out.push(full)
  }
}

const offenders: string[] = []
for (const root of ROOTS) {
  const files: string[] = []
  walk(join(ROOT, root), files)
  for (const file of files) {
    const rel = relative(ROOT, file)
    if (rel === PRIMITIVE || TEST_FILE.test(rel)) continue
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const code = line.trimStart()
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return
        if (RAW_SELECT.test(line)) offenders.push(`${rel}:${index + 1}`)
      })
  }
}

if (offenders.length > 0) {
  console.error(
    '✗ native <select> outside the Select primitive — use `Select` from @camstack/ui-library',
  )
  for (const o of offenders) console.error(`  ${o}`)
  process.exit(1)
}
console.log('  ✔ no native <select> outside the Select primitive')
