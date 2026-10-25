/**
 * A `.deb` is unpacked without `dpkg-deb`: the ar container and a zstd payload
 * in-process, an xz payload through the host `tar`. Ubuntu's libusb deb — the
 * one the Coral delegate needs beside it — is `data.tar.zst`; feranick's
 * libedgetpu deb is `data.tar.xz`. Both shapes are built here from a real
 * tarball, with the soname as a SYMLINK to the versioned file exactly as the
 * packages lay it out.
 */
import { execFileSync } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extractArchive, type ArchiveFormat } from '../archive-extract.js'
import { debDataMember, installLibraryFromDeb, readArMembers } from '../deb-extract.js'

/**
 * The real host tar, behind a check that a `tar` it is handed IS a plain
 * tarball (`ustar` at byte 257). macOS bsdtar would sniff a zstd stream on its
 * own; GNU tar without a `zstd` binary cannot — so the decompression must be
 * ours, and only this check can tell on every host.
 */
function plainTarOnly(archivePath: string, format: ArchiveFormat, destDir: string): void {
  if (format === 'tar') {
    expect(readFileSync(archivePath).subarray(257, 262).toString('latin1')).toBe('ustar')
  }
  extractArchive(archivePath, format, destDir)
}

const LIB_BYTES = Buffer.from('ELF-libusb-1.0.so.0.4.0-fixture-bytes')

function arArchive(members: ReadonlyArray<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [Buffer.from('!<arch>\n', 'latin1')]
  for (const m of members) {
    const header =
      m.name.padEnd(16) +
      '0'.padEnd(12) +
      '0'.padEnd(6) +
      '0'.padEnd(6) +
      '100644'.padEnd(8) +
      String(m.data.length).padEnd(10) +
      '`\n'
    parts.push(Buffer.from(header, 'latin1'), m.data)
    if (m.data.length % 2 === 1) parts.push(Buffer.from('\n', 'latin1'))
  }
  return Buffer.concat(parts)
}

let work: string

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'deb-extract-'))
})
afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

/** A package tree with `libusb-1.0.so.0 -> libusb-1.0.so.0.4.0`, tarred by the host tar. */
function packageTar(flags: '-cf' | '-cJf', out: string): Buffer {
  const root = join(work, 'pkg')
  const libDir = join(root, 'usr', 'lib', 'x86_64-linux-gnu')
  mkdirSync(libDir, { recursive: true })
  writeFileSync(join(libDir, 'libusb-1.0.so.0.4.0'), LIB_BYTES)
  symlinkSync('libusb-1.0.so.0.4.0', join(libDir, 'libusb-1.0.so.0'))
  execFileSync('tar', [flags, out, '-C', root, '.'])
  return readFileSync(out)
}

function deb(dataName: string, data: Buffer): string {
  const path = join(work, 'pkg.deb')
  writeFileSync(
    path,
    arArchive([
      { name: 'debian-binary', data: Buffer.from('2.0\n') },
      {
        name: 'control.tar.zst',
        data: zstdCompressSync(Buffer.from('control')),
      },
      { name: dataName, data },
    ]),
  )
  return path
}

describe.skipIf(process.platform === 'win32')('installLibraryFromDeb', () => {
  it('reads a zstd payload (Ubuntu libusb) and installs the soname as the real bytes', () => {
    const tar = packageTar('-cf', join(work, 'data.tar'))
    const target = join(work, 'libusb-1.0.so.0')
    installLibraryFromDeb(
      deb('data.tar.zst', zstdCompressSync(tar)),
      'libusb-1.0.so.0',
      target,
      join(work, 'x'),
      plainTarOnly,
    )
    expect(readFileSync(target)).toEqual(LIB_BYTES)
    expect(lstatSync(target).isSymbolicLink()).toBe(false)
  })

  it('reads an xz payload (feranick libedgetpu) through the host tar', () => {
    const tarXz = packageTar('-cJf', join(work, 'data.tar.xz'))
    const target = join(work, 'out.so')
    installLibraryFromDeb(
      deb('data.tar.xz', tarXz),
      'libusb-1.0.so.0',
      target,
      join(work, 'x'),
      plainTarOnly,
    )
    expect(readFileSync(target)).toEqual(LIB_BYTES)
  })

  it('names the member a package does not carry, and leaves no work dir behind', () => {
    const tar = packageTar('-cf', join(work, 'data.tar'))
    const workDir = join(work, 'x')
    expect(() =>
      installLibraryFromDeb(
        deb('data.tar.zst', zstdCompressSync(tar)),
        'libedgetpu.so.1',
        join(work, 'none'),
        workDir,
      ),
    ).toThrow(/libedgetpu\.so\.1 not found/)
    expect(() => lstatSync(workDir)).toThrow()
  })
})

describe('readArMembers / debDataMember', () => {
  it('keeps members 2-byte aligned and finds the payload by name', () => {
    const odd = Buffer.from('abc') // odd length → one pad byte follows
    const members = readArMembers(
      arArchive([
        { name: 'debian-binary', data: odd },
        { name: 'data.tar.zst', data: Buffer.from('zz') },
      ]),
    )
    expect(members.map((m) => m.name)).toEqual(['debian-binary', 'data.tar.zst'])
    expect(members[0]?.data.toString()).toBe('abc')
    expect(debDataMember(arArchive([{ name: 'data.tar.zst', data: Buffer.from('zz') }]))).toEqual({
      compression: 'zst',
      data: Buffer.from('zz'),
    })
  })

  it('refuses what is not an ar archive and a payload compression it cannot read', () => {
    expect(() => readArMembers(Buffer.from('PK\u0003\u0004 not a deb'))).toThrow(
      /not an ar archive/,
    )
    expect(() =>
      debDataMember(arArchive([{ name: 'data.tar.lzma', data: Buffer.from('x') }])),
    ).toThrow(/does not read/)
  })
})
