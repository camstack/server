import { describe, expect, it } from 'vitest'
import { derivePathChips } from '../path-chips'

const entry = (name: string) => ({ name, path: `/${name}` })

describe('derivePathChips', () => {
  it('offers the real directories that exist at the filesystem root', () => {
    const chips = derivePathChips([entry('recordings'), entry('data')])
    expect(chips).toEqual(['/recordings', '/data'])
  })

  it('drops OS plumbing that can never be a storage target', () => {
    const chips = derivePathChips(
      ['proc', 'sys', 'dev', 'run', 'boot', 'lost+found', 'bin', 'usr', 'etc', 'var', 'tmp'].map(
        entry,
      ),
    )
    expect(chips).toEqual([])
  })

  it('drops dot-directories', () => {
    expect(derivePathChips([entry('.cache'), entry('data')])).toEqual(['/data'])
  })

  it('leads with the curated storage-likely names, the rest alphabetical', () => {
    const chips = derivePathChips(
      ['zdata', 'Volumes', 'media', 'mnt', 'data', 'recordings-high', 'recordings', 'home'].map(
        entry,
      ),
    )
    expect(chips).toEqual([
      '/recordings',
      '/recordings-high',
      '/data',
      '/mnt',
      '/media',
      '/Volumes',
      '/home',
      '/zdata',
    ])
  })

  it('keeps the absolute path the node reported, not a re-derived one', () => {
    const chips = derivePathChips([{ name: 'recordings', path: '/srv/recordings' }])
    expect(chips).toEqual(['/srv/recordings'])
  })
})
