import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseBootRole,
  readBootRoleSync,
  shouldIgnoreCertificateErrors,
  STORE_FILE_NAME,
} from '../role/boot-role'

const tempDirs: string[] = []

function makeUserDataDir(contents: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-boot-role-'))
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

describe('parseBootRole', () => {
  it('reads each configured role back', () => {
    expect(parseBootRole('{"role":"hub"}')).toBe('hub')
    expect(parseBootRole('{"role":"agent"}')).toBe('agent')
    expect(parseBootRole('{"role":"viewer"}')).toBe('viewer')
  })

  it('falls back to "hub" when the file is absent', () => {
    expect(parseBootRole(null)).toBe('hub')
  })

  it('falls back to "hub" when the file is corrupt or not an object', () => {
    expect(parseBootRole('')).toBe('hub')
    expect(parseBootRole('{ not json')).toBe('hub')
    expect(parseBootRole('"viewer"')).toBe('hub')
    expect(parseBootRole('["viewer"]')).toBe('hub')
    expect(parseBootRole('null')).toBe('hub')
  })

  it('falls back to "hub" when the role key is missing or wrong-typed', () => {
    expect(parseBootRole('{}')).toBe('hub')
    expect(parseBootRole('{"role":null}')).toBe('hub')
    expect(parseBootRole('{"role":"Viewer"}')).toBe('hub')
    expect(parseBootRole('{"role":{"role":"viewer"}}')).toBe('hub')
  })
})

describe('readBootRoleSync', () => {
  it('reads the role out of <userData>/config.json', () => {
    expect(readBootRoleSync(makeUserDataDir('{"role":"agent"}'), 'node')).toBe('agent')
  })

  it('returns "hub" when the store file does not exist', () => {
    expect(readBootRoleSync(makeUserDataDir(null), 'node')).toBe('hub')
  })

  it('returns "hub" when the store file is corrupt', () => {
    expect(readBootRoleSync(makeUserDataDir('{"role":'), 'node')).toBe('hub')
  })

  it('is the viewer role in the reduced product without consulting the file', () => {
    expect(readBootRoleSync(makeUserDataDir('{"role":"hub"}'), 'viewer')).toBe('viewer')
  })
})

describe('shouldIgnoreCertificateErrors', () => {
  it('keeps the switch for the roles that talk to a localhost child', () => {
    expect(shouldIgnoreCertificateErrors('hub')).toBe(true)
    expect(shouldIgnoreCertificateErrors('agent')).toBe(true)
  })

  it('never appends the switch for the viewer role', () => {
    expect(shouldIgnoreCertificateErrors('viewer')).toBe(false)
  })
})
