/**
 * The guard that keeps a declared addon icon servable: the admin UI requests
 * exactly the manifest's `icon`, so a missing or unshipped file is a 404.
 */
import { describe, expect, it } from 'vitest'

import { iconProblems, shippedByFiles } from '../check-addon-icons-shipped'

const has =
  (...paths: string[]) =>
  (rel: string): boolean =>
    paths.includes(rel)

describe('shippedByFiles', () => {
  it('a folder entry covers what is inside it', () => {
    expect(shippedByFiles(['dist', 'assets'], 'assets/core-blocks/icon.svg')).toBe(true)
    expect(shippedByFiles(['dist', './assets/'], 'assets/icon.svg')).toBe(true)
  })

  it('a package that ships only dist drops assets/', () => {
    expect(shippedByFiles(['dist'], 'assets/icon.svg')).toBe(false)
  })

  it('no files list ships everything', () => {
    expect(shippedByFiles(undefined, 'assets/icon.svg')).toBe(true)
  })
})

describe('iconProblems', () => {
  const addon = (icon: unknown) => ({
    files: ['dist', 'assets'],
    camstack: { addons: [{ id: 'core-blocks', icon }] },
  })

  it('passes a declared icon that exists and ships', () => {
    expect(
      iconProblems(addon('assets/core-blocks/icon.svg'), has('assets/core-blocks/icon.svg')),
    ).toEqual([])
  })

  it('flags a declared icon that is not on disk', () => {
    expect(iconProblems(addon('assets/icon.svg'), has())).toEqual([
      'core-blocks: assets/icon.svg does not exist',
    ])
  })

  it('flags an icon left out of the tarball — the shape @camstack/system had (files: ["dist"])', () => {
    const pkg = { ...addon('assets/icon.svg'), files: ['dist'] }
    expect(iconProblems(pkg, has('assets/icon.svg'))[0]).toMatch(/not covered by "files"/)
  })

  it('flags a glyph name at the addon level — the UI never draws it', () => {
    expect(iconProblems(addon('gauge'), has())[0]).toMatch(/not an asset path/)
  })

  it('checks the bundle-level icon too', () => {
    const pkg = {
      files: ['dist'],
      camstack: { bundle: { displayName: 'X', icon: 'assets/x.svg' } },
    }
    expect(iconProblems(pkg, has())).toEqual(['(bundle): assets/x.svg does not exist'])
  })

  it('an addon without an icon is not an offender', () => {
    expect(iconProblems({ camstack: { addons: [{ id: 'keychain' }] } }, has())).toEqual([])
  })
})
