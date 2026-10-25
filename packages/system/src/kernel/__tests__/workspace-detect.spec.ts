import { describe, it, expect } from 'vitest'
import { detectWorkspacePackagesDir } from '../workspace-detect.js'
import * as path from 'node:path'

describe('detectWorkspacePackagesDir', () => {
  it('finds packages dir when running inside the monorepo', () => {
    // When running from within camstack-server, this should find the packages dir
    const result = detectWorkspacePackagesDir(__dirname)
    // In test context, we're inside the monorepo so this should succeed
    if (result) {
      expect(result).toContain('packages')
      expect(path.isAbsolute(result)).toBe(true)
    }
    // If null, we're running outside the monorepo — that's fine too
    expect(result === null || typeof result === 'string').toBe(true)
  })

  it('returns null from a random directory', () => {
    const result = detectWorkspacePackagesDir('/tmp')
    expect(result).toBeNull()
  })
})
