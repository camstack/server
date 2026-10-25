import { describe, expect, it } from 'vitest'
import {
  assertBrowsablePath,
  assertWithinAllowedRoots,
  isWithinAllowedRoots,
} from '../path-guard.js'

describe('path-guard', () => {
  const roots = ['/mnt', '/Volumes']

  it('accepts a path inside an allowed root', () => {
    expect(isWithinAllowedRoots('/mnt/nas/recordings', roots)).toBe(true)
    expect(isWithinAllowedRoots('/mnt', roots)).toBe(true)
  })

  it('rejects a path outside every allowed root', () => {
    expect(isWithinAllowedRoots('/etc/passwd', roots)).toBe(false)
    expect(isWithinAllowedRoots('/mntfoo', roots)).toBe(false) // prefix-but-not-subdir
  })

  it('rejects traversal escapes', () => {
    expect(isWithinAllowedRoots('/mnt/../etc', roots)).toBe(false)
  })

  it('assertWithinAllowedRoots throws on a bad path', () => {
    expect(() => assertWithinAllowedRoots('/etc', roots)).toThrow(/not within an allowed root/)
    expect(() => assertWithinAllowedRoots('/mnt/ok', roots)).not.toThrow()
  })

  // Browsing is READ-ONLY discovery and is deliberately NOT confined to the
  // write roots (D115): the operator could not even browse to the directories
  // their own storage locations already live in. Only writes stay contained.
  it('assertBrowsablePath accepts any absolute path, including outside the write roots', () => {
    expect(() => assertBrowsablePath('/')).not.toThrow()
    expect(() => assertBrowsablePath('/recordings-high')).not.toThrow()
    expect(() => assertBrowsablePath('/etc')).not.toThrow()
  })

  it('assertBrowsablePath rejects a relative path', () => {
    expect(() => assertBrowsablePath('recordings')).toThrow(/absolute/)
    expect(() => assertBrowsablePath('../etc')).toThrow(/absolute/)
  })
})
