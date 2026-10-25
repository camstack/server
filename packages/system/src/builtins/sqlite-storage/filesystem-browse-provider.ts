/**
 * Per-node filesystem-browse provider. Backs the `filesystem-browse` cap so the
 * admin UI can pick a node + path for a node-local storage location.
 *
 * The two halves are guarded differently (D115): `browse` is read-only
 * discovery and sees the whole filesystem from `/` down, while `createDir`
 * stays contained to the operator's allowed roots. Containing discovery too
 * meant the picker could not list `/`, and therefore could not show the mounts
 * this node's own storage locations already live on.
 */
import { mkdir, readdir, realpath, statfs } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { IFilesystemBrowseProvider } from '@camstack/types'
import { assertBrowsablePath, assertWithinAllowedRoots } from './path-guard.js'

export class FilesystemBrowseProvider implements IFilesystemBrowseProvider {
  /** allowedRoots is injected (read from addon config) so it stays per-node + testable. */
  constructor(private readonly allowedRoots: () => readonly string[]) {}

  async listAllowedRoots(): Promise<readonly string[]> {
    return [...this.allowedRoots()]
  }

  async browse({ path }: { path: string }): Promise<{
    path: string
    entries: readonly { name: string; path: string }[]
    freeBytes: number
    totalBytes: number
  }> {
    // Read-only discovery: the only gate is "absolute", checked on the RAW
    // input so a relative path can never be resolved against the runner's cwd
    // and silently become an absolute one.
    assertBrowsablePath(path)
    const real = await realpath(path).catch(() => path)
    const dirents = await readdir(real, { withFileTypes: true })
    const entries = dirents
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, path: join(real, d.name) }))
    const fs = await statfs(real)
    const totalBytes = fs.blocks * fs.bsize
    const freeBytes = fs.bavail * fs.bsize
    return { path: real, entries, freeBytes, totalBytes }
  }

  async createDir({ path }: { path: string }): Promise<{ path: string }> {
    // The target may not exist yet, so resolve its existing parent for the
    // symlink-safe guard while still returning/creating the requested path.
    const parent = dirname(path)
    const realParent = await realpath(parent).catch(() => parent)
    const guardTarget = join(realParent, basename(path))
    assertWithinAllowedRoots(guardTarget, await this.resolvedRoots())
    await mkdir(path, { recursive: true })
    return { path }
  }

  /** Allowed roots with symlinks resolved (falls back to the raw root if it does not exist). */
  private async resolvedRoots(): Promise<readonly string[]> {
    return Promise.all(this.allowedRoots().map((r) => realpath(r).catch(() => r)))
  }
}
