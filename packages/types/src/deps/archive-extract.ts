/**
 * The one place an archive a node downloaded is unpacked.
 *
 * POSIX hosts keep their native tools (`unzip` restores modes and symlinks,
 * which the portable Python relies on). Windows has neither a guaranteed
 * `unzip` nor a guaranteed zip-capable `tar` on PATH, so a zip is unpacked by
 * the in-process extractor, and a tarball by the `tar.exe` Windows ships in
 * System32 (bsdtar) — addressed by absolute path so a GNU tar that Git for
 * Windows put earlier on PATH cannot shadow it.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { extractZipArchive } from './zip-extract.js'

/** `tar` = an uncompressed tarball (a `.deb` payload this module already decompressed). */
export type ArchiveFormat = 'zip' | 'tar.gz' | 'tar.xz' | 'tar'

export type ExecFile = (file: string, args: readonly string[]) => unknown

export interface ExtractDeps {
  readonly platform: NodeJS.Platform
  readonly systemRoot: string | undefined
  readonly exec: ExecFile
  readonly extractZip: (archivePath: string, destDir: string) => void
}

const defaultDeps: ExtractDeps = {
  platform: process.platform,
  systemRoot: process.env['SystemRoot'],
  exec: (file, args) => execFileSync(file, [...args], { stdio: 'pipe' }),
  extractZip: extractZipArchive,
}

/** The tar to run: Windows' own bsdtar by absolute path, `tar` elsewhere. */
export function tarExecutable(platform: NodeJS.Platform, systemRoot: string | undefined): string {
  if (platform !== 'win32') return 'tar'
  return join(systemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
}

export function extractArchive(
  archivePath: string,
  format: ArchiveFormat,
  destDir: string,
  overrides: Partial<ExtractDeps> = {},
): void {
  const deps: ExtractDeps = { ...defaultDeps, ...overrides }
  const tar = tarExecutable(deps.platform, deps.systemRoot)
  if (format === 'zip') {
    if (deps.platform === 'win32') {
      deps.extractZip(archivePath, destDir)
      return
    }
    try {
      deps.exec('unzip', ['-o', '-q', archivePath, '-d', destDir])
    } catch {
      deps.exec(tar, ['-xf', archivePath, '-C', destDir])
    }
    return
  }
  const flags = format === 'tar.xz' ? '-xJf' : format === 'tar' ? '-xf' : '-xzf'
  deps.exec(tar, [flags, archivePath, '-C', destDir])
}
