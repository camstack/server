/**
 * A device's name is painted by `DeviceName` / `useDeviceLabel`. A JSX file
 * that interpolates `device.name` (and the sibling shapes below) is a second
 * naming rule.
 *
 * The allow-list is short and named. Identity editors show the stored string
 * because that is what the operator is editing. Adoption previews are not
 * fleet rows. Anything else is a miss.
 *
 * `row.name` / `d.name` are not in this cut: they also mean nodes, rules and
 * integrations. `parentName={device.name}` is the raw parent handed to a
 * child that formats itself; it is not the painted label.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

const ROOTS: readonly string[] = ['packages/addon-admin-ui/src', 'packages/ui-library/src']

/**
 * Suffix match on the repo-relative path. A directory suffix covers the
 * component; a file suffix is one surface, named in the comment.
 */
const ALLOW: readonly { readonly suffix: string; readonly why: string }[] = [
  {
    suffix: 'packages/ui-library/src/composites/device-name/',
    why: 'the component and its hooks',
  },
  {
    suffix: 'components/device/customize/IdentityRow.tsx',
    why: 'the stored name being edited',
  },
  {
    suffix: 'components/device/customize/IdentityDisplayFields.tsx',
    why: 'the stored name being edited, and the placeholder that falls back to it',
  },
  {
    suffix: 'composites/discovery-panel.tsx',
    why: 'adoption preview — candidates, not fleet devices',
  },
  {
    suffix: 'components/integrations/AdoptDevicesModal.tsx',
    why: 'adoption candidates, not fleet devices',
  },
  {
    suffix: 'pages/system/Terminal.tsx',
    why: 'legacy terminal profiles — a name, a node and a profile, not a fleet device',
  },
]

const DISPLAY: readonly RegExp[] = [
  />\s*\{[^}\n]*\b(?:device|child|accessory|parentDevice|sourceDevice|camera)\.name\b/,
  />\s*\{[^}\n]*\b(?:row|r)\.device\.name\b/,
  /^\s*\{[^}\n]*\b(?:device|child|accessory|parentDevice|sourceDevice|camera)\.name\b/,
  /^\s*\{[^}\n]*\b(?:row|r)\.device\.name\b/,
  /\{String\((?:device|parentDevice|child|camera)\.name\b/,
  /\b(?:title|alt|placeholder|aria-label)=\{[^}\n]*\b(?:device|child|accessory|parentDevice|sourceDevice|camera)\.name\b/,
  /\b(?:title|alt|placeholder|aria-label)=\{[^}\n]*\b(?:row|r)\.device\.name\b/,
  /\b(?:title|alt|placeholder|aria-label)=\{[^}\n]*\bcamera\.name\b/,
  /\{\s*name:\s*(?:r\.device|row\.device|device|child|accessory|parentDevice|sourceDevice|camera)\.name\b/,
  /\{\s*camera:\s*camera\.name\b/,
  /\bdeviceName=\{(?:String\()?device\.name\b/,
  /\bdeviceName=\{row\.device\.name\b/,
]

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules' || name.includes('.design-sync')) continue
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) walk(abs, out)
    else if (name.endsWith('.tsx')) out.push(abs)
  }
}

function allowed(rel: string): boolean {
  return ALLOW.some((entry) => rel.endsWith(entry.suffix) || rel.includes(entry.suffix))
}

const problems: string[] = []
for (const root of ROOTS) {
  const files: string[] = []
  walk(join(ROOT, root), files)
  for (const abs of files) {
    const rel = abs.slice(ROOT.length + 1)
    if (allowed(rel)) continue
    const lines = readFileSync(abs, 'utf8').split('\n')
    lines.forEach((line, index) => {
      // The raw parent name is an input to a child row's noun, not the label.
      if (line.includes('parentName={')) return
      if (!DISPLAY.some((pattern) => pattern.test(line))) return
      problems.push(`${rel}:${String(index + 1)}: ${line.trim()}`)
    })
  }
}

if (problems.length > 0) {
  console.error('✗ device name rendered outside DeviceName')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error(
    '  Paint it with <DeviceName> or useDeviceLabel. Identity editors and adoption previews are the allow-list in this file.',
  )
  process.exit(1)
}
console.log('  ✔ device names go through DeviceName')
