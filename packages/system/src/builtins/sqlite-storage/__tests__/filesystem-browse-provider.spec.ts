import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FilesystemBrowseProvider } from '../filesystem-browse-provider.js'

describe('FilesystemBrowseProvider', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fsb-'))
    mkdirSync(join(root, 'a'))
    mkdirSync(join(root, 'b'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('lists allowed roots', async () => {
    const p = new FilesystemBrowseProvider(() => [root])
    expect(await p.listAllowedRoots()).toEqual([root])
  })

  it('browses subdirectories of an allowed path with free/total bytes', async () => {
    const p = new FilesystemBrowseProvider(() => [root])
    const r = await p.browse({ path: root })
    expect(r.entries.map((e) => e.name).toSorted()).toEqual(['a', 'b'])
    expect(r.totalBytes).toBeGreaterThan(0)
  })

  // D115: browsing is read-only discovery and is NOT confined to the write
  // roots. Before this, the admin UI could not list `/` — so the path chips
  // could never offer the mounts the node's own storage locations live on.
  it('browses a path outside every write root — discovery is unconfined', async () => {
    const p = new FilesystemBrowseProvider(() => [join(root, 'a')])
    const r = await p.browse({ path: root })
    expect(r.entries.map((e) => e.name).toSorted()).toEqual(['a', 'b'])
  })

  it('browses the filesystem root', async () => {
    const p = new FilesystemBrowseProvider(() => [root])
    const r = await p.browse({ path: '/' })
    expect(r.path).toBe('/')
    expect(r.entries.length).toBeGreaterThan(0)
  })

  it('rejects browsing a relative path', async () => {
    const p = new FilesystemBrowseProvider(() => [root])
    await expect(p.browse({ path: 'etc' })).rejects.toThrow(/absolute/)
  })

  it('creates a subdirectory within an allowed root', async () => {
    const p = new FilesystemBrowseProvider(() => [root])
    const out = await p.createDir({ path: join(root, 'c') })
    expect(out.path).toBe(join(root, 'c'))
    expect((await p.browse({ path: root })).entries.map((e) => e.name)).toContain('c')
  })

  it('refuses to create outside an allowed root', async () => {
    const p = new FilesystemBrowseProvider(() => [root])
    await expect(p.createDir({ path: '/etc/evil' })).rejects.toThrow(/allowed root/)
  })

  // The halves of the split guard must not leak into each other: a directory
  // the operator can now LIST is still not a directory they can write into.
  it('refuses to create inside a directory it will happily browse', async () => {
    const p = new FilesystemBrowseProvider(() => [join(root, 'a')])
    await expect(p.browse({ path: root })).resolves.toBeDefined()
    await expect(p.createDir({ path: join(root, 'b', 'evil') })).rejects.toThrow(/allowed root/)
  })
})
