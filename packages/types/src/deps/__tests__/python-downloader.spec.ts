import { describe, it, expect } from 'vitest'
import {
  getPythonDownloadUrl,
  getPythonSha256,
  pythonInterpreterSegments,
} from '../python-downloader.js'

describe('getPythonDownloadUrl', () => {
  it('returns linux-x64 URL', () => {
    const url = getPythonDownloadUrl('linux', 'x64')
    expect(url).toContain('portable-python')
    expect(url).toContain('headless')
    expect(url).toContain('linux-x86_64')
  })

  it('returns darwin universal2 URL (same for arm64 and x64)', () => {
    const urlArm = getPythonDownloadUrl('darwin', 'arm64')
    const urlX64 = getPythonDownloadUrl('darwin', 'x64')
    expect(urlArm).toContain('darwin-universal2')
    expect(urlArm).toBe(urlX64) // universal2 covers both
  })

  it('returns the Windows x64 headless build from the same upstream release', () => {
    const url = getPythonDownloadUrl('win32', 'x64')
    expect(url).toContain('portable-python')
    expect(url).toContain('headless')
    expect(url).toMatch(/windows-x86_64\.zip$/)
    expect(url.split('/').slice(0, -1)).toEqual(
      getPythonDownloadUrl('linux', 'x64').split('/').slice(0, -1),
    )
  })

  it('refuses Windows on an architecture it has no pinned build for', () => {
    expect(() => getPythonDownloadUrl('win32', 'arm64')).toThrow(/Windows architecture/)
  })

  it('throws for unsupported platform', () => {
    expect(() => getPythonDownloadUrl('freebsd' as never, 'x64')).toThrow('Unsupported')
  })
})

describe('getPythonSha256', () => {
  it('pins a distinct checksum for every supported target', () => {
    const shas = [
      getPythonSha256('linux', 'x64'),
      getPythonSha256('linux', 'arm64'),
      getPythonSha256('darwin', 'arm64'),
      getPythonSha256('win32', 'x64'),
    ]
    for (const sha of shas) expect(sha).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(shas).size).toBe(shas.length)
  })
})

describe('pythonInterpreterSegments', () => {
  it('is bin/python.exe on Windows and bin/python3 elsewhere', () => {
    expect(pythonInterpreterSegments('win32')).toEqual(['bin', 'python.exe'])
    expect(pythonInterpreterSegments('linux')).toEqual(['bin', 'python3'])
    expect(pythonInterpreterSegments('darwin')).toEqual(['bin', 'python3'])
  })
})
