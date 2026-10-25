/**
 * `@camstack/system` must not be seeded into /data/addons when the running
 * closure already provides it — and MUST still be seeded when it does not.
 *
 * Both halves matter, and they were learned in opposite directions:
 *
 *  - seeding when the closure has it produced a copy that WINS over the
 *    closure and is never refreshed (`camstack deploy` of a framework package
 *    is rejected on an image hub), so a node ran first-boot builtins forever
 *    while `getServerPackageStatus` reported the new version. Measured on two
 *    agents: a 1.2.0 copy from 2026-07-21 against a 1.2.29 closure;
 *  - NOT seeding it at all is how a fresh deployment was once made unbootable
 *    ("No addon provides required infrastructure capability storage-provider"),
 *    which is recorded in `deriveBootstrapList` and is why the guard is
 *    RESOLVABILITY rather than a blanket removal.
 *
 * The second branch is unreachable without the injection point: in a test
 * process `@camstack/system` always resolves.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AddonInstaller, shouldSkipClosureProvidedSeed } from '../addon-installer.js'

let addonsDir: string

beforeEach(() => {
  addonsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-bootstrap-'))
})
afterEach(() => {
  fs.rmSync(addonsDir, { recursive: true, force: true })
})

const isInstalled = (pkg: string): boolean =>
  fs.existsSync(path.join(addonsDir, pkg, 'package.json'))

describe('bootstrap seeding of @camstack/system', () => {
  it('does NOT seed a copy when the closure provides it', async () => {
    const installer = new AddonInstaller({
      addonsDir,
      installSource: 'npm',
      isPackageResolvable: () => true,
    })

    await installer.ensureRequiredPackages(['@camstack/system'])

    expect(isInstalled('@camstack/system')).toBe(false)
  })

  it('does NOT skip when the closure lacks it — the branch that keeps a fresh node bootable', () => {
    // Asserted on the decision rather than the loop: the loop would go to the
    // network, and a test that reaches npm proves nothing about the rule.
    expect(shouldSkipClosureProvidedSeed('@camstack/system', false)).toBe(false)
  })

  it('never skips anything other than the closure-provided package', () => {
    expect(shouldSkipClosureProvidedSeed('@camstack/addon-pipeline', true)).toBe(false)
    expect(shouldSkipClosureProvidedSeed('@camstack/system', true)).toBe(true)
  })

  it('leaves an EXISTING copy alone — removing a stale one is an operator action', async () => {
    const dir = path.join(addonsDir, '@camstack/system')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.2.0' }))

    const installer = new AddonInstaller({
      addonsDir,
      installSource: 'npm',
      isPackageResolvable: () => true,
    })
    await installer.ensureRequiredPackages(['@camstack/system'])

    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'))
    expect(raw).toEqual({ version: '1.2.0' })
  })
})
