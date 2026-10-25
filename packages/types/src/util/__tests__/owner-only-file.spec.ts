import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  icaclsArgs,
  mkdirOwnerOnlySync,
  OwnerOnlyError,
  restrictDirToOwnerSync,
  restrictFileToOwnerSync,
  writeOwnerOnlyFileSync,
} from '../owner-only-file.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camstack-owner-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function windows(exec = vi.fn()) {
  return {
    platform: 'win32' as const,
    exec,
    principal: () => 'HOMEPC\\alice',
    systemRoot: 'C:\\Windows',
  }
}

describe('icaclsArgs', () => {
  it('drops inheritance and grants only the user and SYSTEM (by SID, locale-proof)', () => {
    expect(icaclsArgs('C:\\d\\agent.json', 'HOMEPC\\alice', false)).toEqual([
      'C:\\d\\agent.json',
      '/inheritance:r',
      '/grant:r',
      'HOMEPC\\alice:F',
      '/grant:r',
      '*S-1-5-18:F',
    ])
  })

  it('makes a directory grant flow to its children', () => {
    expect(icaclsArgs('C:\\d', 'HOMEPC\\alice', true)).toContain('HOMEPC\\alice:(OI)(CI)F')
  })
})

describe('restrictFileToOwnerSync on Windows', () => {
  it('runs System32 icacls on the file — chmod would be a no-op there', () => {
    const exec = vi.fn()
    const file = join(dir, 'agent.json')
    writeFileSync(file, '{}')
    restrictFileToOwnerSync(file, windows(exec))
    expect(exec).toHaveBeenCalledTimes(1)
    const [bin, args] = exec.mock.calls[0] as [string, string[]]
    expect(bin).toMatch(/System32.icacls\.exe$/)
    expect(args[0]).toBe(file)
    expect(args).toContain('/inheritance:r')
  })

  it('does not swallow an icacls failure — the caller must know the file is open', () => {
    const exec = vi.fn(() => {
      throw new Error('Access is denied')
    })
    expect(() => restrictFileToOwnerSync(join(dir, 'x'), windows(exec))).toThrow(OwnerOnlyError)
  })
})

describe('writeOwnerOnlyFileSync', () => {
  it('restricts the temp file while it is still EMPTY, then writes, then renames', () => {
    const file = join(dir, 'agent.json')
    const seenAtRestrict: string[] = []
    const exec = vi.fn((_bin: string, args: readonly string[]) => {
      const target = args[0] as string
      seenAtRestrict.push(readFileSync(target, 'utf8'))
    })
    writeOwnerOnlyFileSync(file, '{"secret":"s3"}', windows(exec))
    expect(seenAtRestrict).toEqual([''])
    expect(readFileSync(file, 'utf8')).toBe('{"secret":"s3"}')
    expect(existsSync(`${file}.tmp.${process.pid}`)).toBe(false)
  })

  it('leaves no file behind, and never the target, when restriction fails', () => {
    const file = join(dir, 'agent.json')
    const exec = vi.fn(() => {
      throw new Error('icacls missing')
    })
    expect(() => writeOwnerOnlyFileSync(file, 'secret', windows(exec))).toThrow(OwnerOnlyError)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(`${file}.tmp.${process.pid}`)).toBe(false)
  })

  it('replaces an existing file atomically', () => {
    const file = join(dir, 'agent.json')
    writeFileSync(file, 'old')
    writeOwnerOnlyFileSync(file, 'new', windows())
    expect(readFileSync(file, 'utf8')).toBe('new')
  })

  it.skipIf(process.platform === 'win32')('is mode 0600 on POSIX, with no icacls', () => {
    const exec = vi.fn()
    const file = join(dir, 'nested', 'agent.json')
    writeOwnerOnlyFileSync(file, 'x', { platform: process.platform, exec })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('restrictDirToOwnerSync', () => {
  it('applies the inheriting grant to an existing directory on Windows', () => {
    const exec = vi.fn()
    restrictDirToOwnerSync(dir, windows(exec))
    const [, args] = exec.mock.calls[0] as [string, string[]]
    expect(args[0]).toBe(dir)
    expect(args).toContain('*S-1-5-18:(OI)(CI)F')
  })
})

describe('mkdirOwnerOnlySync', () => {
  it('grants the directory with inheritance on Windows', () => {
    const exec = vi.fn()
    mkdirOwnerOnlySync(join(dir, 'secrets'), windows(exec))
    const [, args] = exec.mock.calls[0] as [string, string[]]
    expect(args).toContain('HOMEPC\\alice:(OI)(CI)F')
  })

  it.skipIf(process.platform === 'win32')('is mode 0700 on POSIX', () => {
    const target = join(dir, 'secrets')
    mkdirOwnerOnlySync(target, { platform: process.platform, exec: vi.fn() })
    expect(statSync(target).mode & 0o777).toBe(0o700)
  })
})
