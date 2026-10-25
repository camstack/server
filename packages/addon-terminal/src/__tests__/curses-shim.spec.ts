import { describe, expect, it } from 'vitest'
import { resolveGlancesCursesShimEnv } from '../curses-shim.js'
import { buildProfiles } from '../profiles.js'

describe('resolveGlancesCursesShimEnv', () => {
  it('injects PYTHONPATH on darwin when the shim directory exists', () => {
    const env = resolveGlancesCursesShimEnv({
      platform: 'darwin',
      shimDir: '/addon/assets/curses-shim/py312',
      shimDirExists: true,
    })
    expect(env).toEqual({ PYTHONPATH: '/addon/assets/curses-shim/py312' })
  })

  it('prepends the shim to an inherited PYTHONPATH instead of clobbering it', () => {
    const env = resolveGlancesCursesShimEnv({
      platform: 'darwin',
      shimDir: '/addon/assets/curses-shim/py312',
      shimDirExists: true,
      existingPythonPath: '/opt/site-packages',
    })
    expect(env).toEqual({
      PYTHONPATH: '/addon/assets/curses-shim/py312:/opt/site-packages',
    })
  })

  it('does nothing off darwin — the shim is a macOS-only repair', () => {
    const env = resolveGlancesCursesShimEnv({
      platform: 'linux',
      shimDir: '/addon/assets/curses-shim/py312',
      shimDirExists: true,
    })
    expect(env).toBeUndefined()
  })

  it('does nothing when the shim directory is missing', () => {
    const env = resolveGlancesCursesShimEnv({
      platform: 'darwin',
      shimDir: '/addon/assets/curses-shim/py312',
      shimDirExists: false,
    })
    expect(env).toBeUndefined()
  })
})

describe('buildProfiles glancesEnv', () => {
  it('applies glancesEnv to the glances profile only', () => {
    const profiles = buildProfiles({
      btmPath: 'btm',
      glancesPythonPath: '/managed/python3',
      allowShell: false,
      shellPath: '/bin/bash',
      glancesEnv: { PYTHONPATH: '/shim' },
    })
    const glances = profiles.find((profile) => profile.profileId === 'glances')
    const monitor = profiles.find((profile) => profile.profileId === 'monitor')
    expect(glances?.env).toEqual({ PYTHONPATH: '/shim' })
    expect(monitor?.env).toBeUndefined()
  })

  it('omits env when glancesEnv is absent', () => {
    const profiles = buildProfiles({
      btmPath: 'btm',
      glancesPythonPath: '/managed/python3',
      allowShell: false,
      shellPath: '/bin/bash',
    })
    const glances = profiles.find((profile) => profile.profileId === 'glances')
    expect(glances?.env).toBeUndefined()
  })
})
