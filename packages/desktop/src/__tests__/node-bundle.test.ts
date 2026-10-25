/**
 * `node-bundle.mjs` — which Node archive the desktop build stages per platform,
 * and the checksum gate in front of it. The Windows shape (a .zip with
 * `node.exe` at the root) is the one that silently fell back to
 * Electron-as-Node when the stager only knew `bin/node` in a tarball.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  extractArgs,
  nodeArchiveSpec,
  nodeAvSiblingName,
  parseShasums,
  tarCommand,
  verifyNodeArchive,
} from '../../scripts/node-bundle.mjs'
import { bundledNodeSegments, resolveBundledNode } from '../process-manager'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'node-bundle-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('nodeArchiveSpec', () => {
  it('is a tar.gz with bin/node on darwin and linux', () => {
    const mac = nodeArchiveSpec({ platform: 'darwin', arch: 'arm64', version: 'v24.1.0' })
    expect(mac.fileName).toBe('node-v24.1.0-darwin-arm64.tar.gz')
    expect(mac.binaryRelPath).toBe('bin/node')
    expect(mac.format).toBe('tar.gz')
    const linux = nodeArchiveSpec({ platform: 'linux', arch: 'x64', version: 'v24.1.0' })
    expect(linux.url).toBe('https://nodejs.org/dist/v24.1.0/node-v24.1.0-linux-x64.tar.gz')
  })

  it('is a zip with node.exe at the root on Windows, in the "win" dist dir', () => {
    const win = nodeArchiveSpec({ platform: 'win32', arch: 'x64', version: 'v24.1.0' })
    expect(win.fileName).toBe('node-v24.1.0-win-x64.zip')
    expect(win.url).toBe('https://nodejs.org/dist/v24.1.0/node-v24.1.0-win-x64.zip')
    expect(win.format).toBe('zip')
    expect(win.binaryRelPath).toBe('node.exe')
    expect(win.stagedRelPath).toBe('node.exe')
    expect(win.shasumsUrl).toBe('https://nodejs.org/dist/v24.1.0/SHASUMS256.txt')
  })
})

describe('extraction', () => {
  it('extracts the single executable, stripping the archive top dir', () => {
    const win = nodeArchiveSpec({ platform: 'win32', arch: 'x64', version: 'v24.1.0' })
    expect(extractArgs(win, 'n.zip', 'out')).toEqual([
      '-xf',
      'n.zip',
      '-C',
      'out',
      '--strip-components=1',
      'node-v24.1.0-win-x64/node.exe',
    ])
    const linux = nodeArchiveSpec({ platform: 'linux', arch: 'x64', version: 'v24.1.0' })
    expect(extractArgs(linux, 'n.tgz', 'out')[0]).toBe('-xzf')
    expect(extractArgs(linux, 'n.tgz', 'out').at(-1)).toBe('node-v24.1.0-linux-x64/bin/node')
  })

  it('uses the System32 bsdtar on Windows (a zip needs it), plain tar elsewhere', () => {
    expect(tarCommand('win32', 'C:\\Windows')).toMatch(/System32.tar\.exe$/)
    expect(tarCommand('darwin')).toBe('tar')
  })
})

describe('verifyNodeArchive', () => {
  const body = Buffer.from('pretend this is node.zip')
  const digest = createHash('sha256').update(body).digest('hex')
  const shasums = `${digest}  node-v24.1.0-win-x64.zip\n${'a'.repeat(64)}  node-v24.1.0-linux-x64.tar.gz\n`

  it('accepts the archive whose sha256 SHASUMS256.txt lists', () => {
    const file = path.join(tmp, 'n.zip')
    fs.writeFileSync(file, body)
    expect(() => verifyNodeArchive(file, 'node-v24.1.0-win-x64.zip', shasums)).not.toThrow()
  })

  it('refuses an archive whose bytes are not the listed ones', () => {
    const file = path.join(tmp, 'n.zip')
    fs.writeFileSync(file, 'tampered')
    expect(() => verifyNodeArchive(file, 'node-v24.1.0-win-x64.zip', shasums)).toThrow(
      /does not match/,
    )
  })

  it('refuses an archive the release does not list at all', () => {
    const file = path.join(tmp, 'n.zip')
    fs.writeFileSync(file, body)
    expect(() => verifyNodeArchive(file, 'node-v24.1.0-win-arm64.zip', shasums)).toThrow(
      /lists no entry/,
    )
  })

  it('parses the file format nodejs.org publishes', () => {
    expect(parseShasums(shasums)['node-v24.1.0-linux-x64.tar.gz']).toBe('a'.repeat(64))
  })
})

describe('nodeAvSiblingName', () => {
  it('is the msvc build on Windows — there is no bare win32-x64 package', () => {
    expect(nodeAvSiblingName('win32', 'x64')).toBe('@seydx/node-av-win32-x64-msvc')
    expect(nodeAvSiblingName('darwin', 'arm64')).toBe('@seydx/node-av-darwin-arm64')
    expect(nodeAvSiblingName('linux', 'x64')).toBe('@seydx/node-av-linux-x64')
  })
})

describe('resolveBundledNode', () => {
  it('finds node.exe at the staged root on Windows, and ignores a POSIX layout there', () => {
    expect(bundledNodeSegments('win32')).toEqual(['node.exe'])
    expect(bundledNodeSegments('linux')).toEqual(['bin', 'node'])

    const nodeDir = path.join(tmp, 'node')
    fs.mkdirSync(path.join(nodeDir, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(nodeDir, 'bin', 'node'), '')
    expect(resolveBundledNode(tmp, 'win32')).toBeNull()
    expect(resolveBundledNode(tmp, 'linux')).toBe(path.join(nodeDir, 'bin', 'node'))

    fs.writeFileSync(path.join(nodeDir, 'node.exe'), '')
    expect(resolveBundledNode(tmp, 'win32')).toBe(path.join(nodeDir, 'node.exe'))
    expect(resolveBundledNode(null, 'win32')).toBeNull()
  })
})
