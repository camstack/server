import { describe, expect, it, vi } from 'vitest'
import { extractArchive, tarExecutable } from '../archive-extract.js'

function deps(platform: NodeJS.Platform) {
  return {
    platform,
    systemRoot: 'C:\\Windows',
    exec: vi.fn(),
    extractZip: vi.fn(),
  }
}

describe('extractArchive', () => {
  it('unpacks a zip on Windows in-process — no unzip, no tar', () => {
    const d = deps('win32')
    extractArchive('a.zip', 'zip', 'out', d)
    expect(d.extractZip).toHaveBeenCalledWith('a.zip', 'out')
    expect(d.exec).not.toHaveBeenCalled()
  })

  it('uses unzip on POSIX, and tar when unzip is missing', () => {
    const d = deps('linux')
    extractArchive('a.zip', 'zip', 'out', d)
    expect(d.exec).toHaveBeenCalledWith('unzip', ['-o', '-q', 'a.zip', '-d', 'out'])
    expect(d.extractZip).not.toHaveBeenCalled()

    const fallback = deps('darwin')
    fallback.exec.mockImplementationOnce(() => {
      throw new Error('ENOENT')
    })
    extractArchive('a.zip', 'zip', 'out', fallback)
    expect(fallback.exec).toHaveBeenLastCalledWith('tar', ['-xf', 'a.zip', '-C', 'out'])
  })

  it('picks the tar flag by format', () => {
    const d = deps('linux')
    extractArchive('a.tar.xz', 'tar.xz', 'out', d)
    extractArchive('a.tar.gz', 'tar.gz', 'out', d)
    expect(d.exec).toHaveBeenNthCalledWith(1, 'tar', ['-xJf', 'a.tar.xz', '-C', 'out'])
    expect(d.exec).toHaveBeenNthCalledWith(2, 'tar', ['-xzf', 'a.tar.gz', '-C', 'out'])
  })

  it('runs the System32 tar on Windows, not whatever is first on PATH', () => {
    expect(tarExecutable('win32', 'C:\\Windows')).toMatch(/System32.tar\.exe$/)
    expect(tarExecutable('linux', undefined)).toBe('tar')
  })
})
