/**
 * The device-picker selection helper has TWO copies that cannot import each
 * other. This makes "they are the same" checkable instead of promised.
 *
 * `device-selection.ts` decides what every notification device picker says
 * about a selected id: removed (only from a list that ANSWERED — D315), named,
 * or unknown, and never drops one on a read (D49). The admin keeps it at
 * `packages/addon-admin-ui/src/pages/system/`; the VIEWER (`camstack/`) keeps it
 * at `src/components/notifications/`, because the viewer resolves
 * `@camstack/types` from a published release and a helper added to the
 * workspace would not exist there. Two copies that drift make the two UIs
 * disagree about whether the same rule's device is gone.
 *
 * Checked: the two helpers are BYTE-identical, and so are their specs once the
 * one legitimate difference — the viewer's `.js` import specifier — is
 * normalised. A spec that drifted would let one copy's behaviour change with
 * nothing pinning it.
 *
 * Why a guard and not an admin spec that reads the viewer file: `camstack/` is
 * a git SUBMODULE, absent in CI (`actions/checkout` without `submodules`) and
 * in a fresh worktree. A spec would have to skip there silently, inside a green
 * suite. This guard runs in the pre-commit hook — where the submodule is on
 * disk — and, when it is absent, SAYS it did not look (the precedent is
 * `check-container-priority-in-sync.ts`): "I could not look" and "it is fine"
 * are different answers (D315).
 *
 * `CAMSTACK_VIEWER_DIR=<viewer checkout>` points the guard at a viewer checkout
 * instead of the `camstack/` submodule, so a worktree that has no submodule can
 * still check the copies against a checkout elsewhere. When it is set, a missing
 * viewer file is a PROBLEM (the operator asked for that checkout to be compared),
 * never a skip. CI sets neither, so its behaviour is unchanged. An EMPTY value
 * counts as unset.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const VIEWER_DIR_ENV = 'CAMSTACK_VIEWER_DIR'
// An EMPTY value is unset: `CAMSTACK_VIEWER_DIR=` in a shell or a CI matrix must not
// point the guard at the repo root and fail every pair as "missing".
const VIEWER_DIR = process.env[VIEWER_DIR_ENV] || undefined
const VIEWER_ROOT = VIEWER_DIR ?? join(ROOT, 'camstack')

interface CopyPair {
  readonly label: string
  readonly admin: string
  readonly viewer: string
}

const PAIRS: readonly CopyPair[] = [
  {
    label: 'helper',
    // The admin file is a re-export since the picker moved into ui-library
    // (f74a47280); the shared source is what the viewer copy must match.
    admin: 'packages/ui-library/src/composites/device-picker/device-selection.ts',
    viewer: 'src/components/notifications/device-selection.ts',
  },
  {
    label: 'spec',
    admin: 'packages/addon-admin-ui/src/pages/system/__tests__/device-selection.spec.ts',
    viewer: 'src/components/notifications/__tests__/device-selection.spec.ts',
  },
  // The smart picker's decisions (search, groups, per-group bulk, chip
  // overflow, bounded render) — the two UIs must pick the same way (D636).
  {
    label: 'picker model',
    admin: 'packages/ui-library/src/composites/device-picker/device-picker-model.ts',
    viewer: 'src/components/notifications/device-picker-model.ts',
  },
  {
    label: 'picker model spec',
    admin: 'packages/addon-admin-ui/src/pages/system/__tests__/device-picker-model.spec.ts',
    viewer: 'src/components/notifications/__tests__/device-picker-model.spec.ts',
  },
  // The system family's node and package pickers (D637): what a stored node
  // or package id is judged as — the two UIs must agree it is gone.
  {
    label: 'scope pickers',
    admin: 'packages/addon-admin-ui/src/pages/system/scope-pickers.helpers.ts',
    viewer: 'src/components/notifications/scope-pickers.helpers.ts',
  },
  {
    label: 'scope pickers spec',
    admin: 'packages/addon-admin-ui/src/pages/system/__tests__/scope-pickers.helpers.spec.ts',
    viewer: 'src/components/notifications/__tests__/scope-pickers.helpers.spec.ts',
  },
  // The rule editor's scope pre-selector (D641): "All | Only these | All
  // except these" over one list per axis — the two editors must derive the
  // same mode from a stored rule and save the same lists from it.
  {
    label: 'rule scope model',
    admin: 'packages/addon-admin-ui/src/pages/system/rule-scope-model.ts',
    viewer: 'src/components/notifications/rule-scope-model.ts',
  },
  {
    label: 'rule scope model spec',
    admin: 'packages/addon-admin-ui/src/pages/system/__tests__/rule-scope-model.spec.ts',
    viewer: 'src/components/notifications/__tests__/rule-scope-model.spec.ts',
  },
  // The alarm's sensor table (D697): what a row says and what its switch
  // writes — the two UIs must read the same answer the same way.
  {
    label: 'alarm sensor table model',
    admin: 'packages/addon-admin-ui/src/pages/system/alarm-sensor-table-model.ts',
    viewer: 'src/components/notifications/alarm-sensor-table-model.ts',
  },
  {
    label: 'alarm sensor table model spec',
    admin: 'packages/addon-admin-ui/src/pages/system/__tests__/alarm-sensor-table-model.spec.ts',
    viewer: 'src/components/notifications/__tests__/alarm-sensor-table-model.spec.ts',
  },
]

/**
 * The modules a shared copy may import by a relative specifier. Each side has
 * its own file of that name (`device-fleet-view` is NOT shared — each UI keeps
 * its own); only the extension differs.
 */
const SHARED_SPECIFIERS = [
  'device-selection',
  'device-picker-model',
  'device-fleet-view',
  'scope-pickers.helpers',
  'rule-scope-model',
  'alarm-sensor-table-model',
] as const

/** The viewer imports `'../device-selection.js'`; the admin `'../device-selection'`. */
function normalise(src: string): string {
  let out = src
  for (const name of SHARED_SPECIFIERS) {
    for (const dir of ['./', '../']) {
      out = out.replaceAll(`from '${dir}${name}.js'`, `from '${dir}${name}'`)
    }
  }
  return out
}

const problems: string[] = []
let checked = 0
let skipped = 0

for (const pair of PAIRS) {
  const adminPath = join(ROOT, pair.admin)
  if (!existsSync(adminPath)) {
    problems.push(`${pair.admin} is missing — the admin copy is in THIS repository`)
    continue
  }
  const viewerPath = join(VIEWER_ROOT, pair.viewer)
  if (!existsSync(viewerPath)) {
    if (VIEWER_DIR === undefined) {
      skipped++
    } else {
      problems.push(`${pair.viewer} is missing under ${VIEWER_DIR_ENV}=${VIEWER_DIR}`)
    }
    continue
  }
  const admin = normalise(readFileSync(adminPath, 'utf8'))
  const viewer = normalise(readFileSync(viewerPath, 'utf8'))
  if (admin.length === 0) problems.push(`${pair.admin} is empty — the read is broken, not the data`)
  if (admin !== viewer) {
    const lines = { admin: admin.split('\n'), viewer: viewer.split('\n') }
    const at = lines.admin.findIndex((line, i) => line !== lines.viewer[i])
    const lineNo = at === -1 ? Math.min(lines.admin.length, lines.viewer.length) + 1 : at + 1
    problems.push(
      `the ${pair.label} copies differ (first at line ${String(lineNo)}):\n` +
        `    admin:  ${pair.admin}\n    viewer: ${join(VIEWER_ROOT, pair.viewer)}\n` +
        `    admin  > ${lines.admin[lineNo - 1] ?? '<end of file>'}\n` +
        `    viewer > ${lines.viewer[lineNo - 1] ?? '<end of file>'}`,
    )
  }
  checked++
}

if (problems.length > 0) {
  console.error('✗ device-selection copies guard')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
if (skipped > 0) {
  console.log(`  ✔ device-selection: admin copies present`)
  console.log(
    `  ⊘ viewer copies NOT checked: the camstack/ submodule is not checked out here — run \`git submodule update --init camstack\`, or set \`${VIEWER_DIR_ENV}=<viewer checkout>\``,
  )
} else {
  console.log(`  ✔ device-selection: ${String(checked)} admin/viewer pairs identical`)
}
