import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { STORE_FILE_NAME, readBootRoleSync, shouldIgnoreCertificateErrors } from '../role/boot-role'
import { isRoleRetiredByProduct, roleForProduct } from '../role/effective-role'

const tempDirs: string[] = []

function makeUserDataDir(contents: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-effective-role-'))
  tempDirs.push(dir)
  if (contents !== null) fs.writeFileSync(path.join(dir, STORE_FILE_NAME), contents)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('roleForProduct', () => {
  it('is viewer in the reduced product, whatever the store says', () => {
    expect(roleForProduct('viewer', 'viewer')).toBe('viewer')
    expect(roleForProduct('viewer', 'hub')).toBe('viewer')
    expect(roleForProduct('viewer', 'agent')).toBe('viewer')
  })

  it('keeps the two supervised roles in the node product', () => {
    expect(roleForProduct('node', 'hub')).toBe('hub')
    expect(roleForProduct('node', 'agent')).toBe('agent')
  })

  it('never runs the retired viewer role in the node product', () => {
    expect(roleForProduct('node', 'viewer')).toBe('hub')
  })
})

describe('isRoleRetiredByProduct', () => {
  it('flags only a node product still holding the retired viewer role', () => {
    expect(isRoleRetiredByProduct('node', 'viewer')).toBe(true)
    expect(isRoleRetiredByProduct('node', 'hub')).toBe(false)
    expect(isRoleRetiredByProduct('node', 'agent')).toBe(false)
    expect(isRoleRetiredByProduct('viewer', 'viewer')).toBe(false)
    expect(isRoleRetiredByProduct('viewer', 'hub')).toBe(false)
  })
})

/**
 * The composition `main.ts` performs at module top, exercised end to end from
 * the bytes on disk. Each case is a way the store can lie to the reduced
 * product about which role it is.
 */
function appendsCertificateBypass(userDataDir: string, product: 'node' | 'viewer'): boolean {
  return shouldIgnoreCertificateErrors(readBootRoleSync(userDataDir, product))
}

describe('the certificate switch, composed as main.ts composes it', () => {
  it('never appends it in the viewer product, even with a hub store', () => {
    expect(appendsCertificateBypass(makeUserDataDir('{"role":"hub"}'), 'viewer')).toBe(false)
  })

  it('never appends it in the viewer product with an agent store', () => {
    expect(appendsCertificateBypass(makeUserDataDir('{"role":"agent"}'), 'viewer')).toBe(false)
  })

  it('never appends it in the viewer product with a corrupt store', () => {
    expect(appendsCertificateBypass(makeUserDataDir('{"role":'), 'viewer')).toBe(false)
    expect(appendsCertificateBypass(makeUserDataDir(''), 'viewer')).toBe(false)
    expect(appendsCertificateBypass(makeUserDataDir('["viewer"]'), 'viewer')).toBe(false)
  })

  it('never appends it in the viewer product with no store at all', () => {
    expect(appendsCertificateBypass(makeUserDataDir(null), 'viewer')).toBe(false)
  })

  it('does not even read the store file in the viewer product', () => {
    const dir = makeUserDataDir('{"role":"hub"}')
    fs.chmodSync(path.join(dir, STORE_FILE_NAME), 0o000)
    expect(readBootRoleSync(dir, 'viewer')).toBe('viewer')
    fs.chmodSync(path.join(dir, STORE_FILE_NAME), 0o600)
  })

  it('keeps appending it in the node product, exactly as before', () => {
    expect(appendsCertificateBypass(makeUserDataDir('{"role":"hub"}'), 'node')).toBe(true)
    expect(appendsCertificateBypass(makeUserDataDir('{"role":"agent"}'), 'node')).toBe(true)
    expect(appendsCertificateBypass(makeUserDataDir(null), 'node')).toBe(true)
    expect(appendsCertificateBypass(makeUserDataDir('{ not json'), 'node')).toBe(true)
  })

  it('appends it in the node product holding the retired viewer role, which is coerced to hub', () => {
    const dir = makeUserDataDir('{"role":"viewer"}')
    expect(readBootRoleSync(dir, 'node')).toBe('hub')
    expect(appendsCertificateBypass(dir, 'node')).toBe(true)
  })
})
