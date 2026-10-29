import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  desktopAppStatePath,
  desktopInstallRequestPath,
  readDesktopAppState,
  serverRootDir,
  writeDesktopInstallRequest,
} from '@camstack/node-root'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UpdateState } from '../auto-updater'
import { takeInstallRequest, watchInstallRequests } from '../desktop-install-request'
import { buildDesktopAppState, publishDesktopAppState } from '../desktop-state-file'

const NOW = 1_900_000_000_000

const DOWNLOADED: UpdateState = {
  available: true,
  downloaded: true,
  version: '2.1.0',
  checking: false,
  error: null,
}

let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-channel-'))
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('desktop-app-state.json (app -> node)', () => {
  it('round-trips the updater snapshot through the file the node reads', () => {
    publishDesktopAppState(dataDir, '2.0.0', DOWNLOADED, NOW)
    expect(readDesktopAppState(serverRootDir(dataDir))).toEqual({
      appVersion: '2.0.0',
      available: true,
      downloaded: true,
      version: '2.1.0',
      checking: false,
      error: null,
      updatedAtMs: NOW,
    })
  })

  it('carries an updater error verbatim instead of reading as "no update"', () => {
    const state = buildDesktopAppState(
      '2.0.0',
      { ...DOWNLOADED, available: false, downloaded: false, version: null, error: 'feed 404' },
      NOW,
    )
    expect(state.error).toBe('feed 404')
    expect(state.downloaded).toBe(false)
  })

  it('overwrites the previous state and leaves no tmp file behind', () => {
    publishDesktopAppState(dataDir, '2.0.0', DOWNLOADED, NOW)
    publishDesktopAppState(dataDir, '2.0.0', { ...DOWNLOADED, downloaded: false }, NOW + 1)
    expect(readDesktopAppState(serverRootDir(dataDir))?.downloaded).toBe(false)
    expect(fs.existsSync(`${desktopAppStatePath(serverRootDir(dataDir))}.tmp`)).toBe(false)
  })

  it('reads as null when the file is missing', () => {
    expect(readDesktopAppState(serverRootDir(dataDir))).toBeNull()
  })
})

describe('desktop-install-request.json (node -> app)', () => {
  function request(requestedAtMs: number, nonce = 'n-1'): void {
    writeDesktopInstallRequest(serverRootDir(dataDir), { requestedAtMs, nonce })
  }

  it('installs a fresh request when the update is downloaded', () => {
    request(NOW - 1_000)
    expect(takeInstallRequest(dataDir, true, NOW)).toEqual({ kind: 'install', nonce: 'n-1' })
  })

  it('is consumed once: the same request never fires twice', () => {
    request(NOW - 1_000)
    expect(takeInstallRequest(dataDir, true, NOW).kind).toBe('install')
    expect(takeInstallRequest(dataDir, true, NOW).kind).toBe('none')
    expect(fs.existsSync(desktopInstallRequestPath(serverRootDir(dataDir)))).toBe(false)
  })

  it('ignores a request older than 60 s, and still deletes it', () => {
    request(NOW - 61_000)
    expect(takeInstallRequest(dataDir, true, NOW).kind).toBe('none')
    expect(fs.existsSync(desktopInstallRequestPath(serverRootDir(dataDir)))).toBe(false)
  })

  it('does not install when nothing is downloaded, and consumes the request', () => {
    request(NOW - 1_000)
    expect(takeInstallRequest(dataDir, false, NOW)).toEqual({
      kind: 'not-downloaded',
      nonce: 'n-1',
    })
    expect(takeInstallRequest(dataDir, true, NOW).kind).toBe('none')
  })

  it('is none when no file exists', () => {
    expect(takeInstallRequest(dataDir, true, NOW).kind).toBe('none')
  })

  it('treats a malformed file as none and removes it', () => {
    fs.mkdirSync(serverRootDir(dataDir), { recursive: true })
    const file = desktopInstallRequestPath(serverRootDir(dataDir))
    fs.writeFileSync(file, '{"requestedAtMs":', 'utf-8')
    expect(takeInstallRequest(dataDir, true, NOW).kind).toBe('none')
    expect(fs.existsSync(file)).toBe(false)
  })
})

describe('watchInstallRequests', () => {
  it('ticks when the request file appears and stops after dispose', async () => {
    let ticks = 0
    const dispose = watchInstallRequests({ dataDir, onTick: () => (ticks += 1), pollMs: 20 })
    writeDesktopInstallRequest(serverRootDir(dataDir), { requestedAtMs: Date.now(), nonce: 'w' })
    await new Promise((r) => setTimeout(r, 120))
    dispose()
    const seen = ticks
    expect(seen).toBeGreaterThan(0)
    await new Promise((r) => setTimeout(r, 80))
    expect(ticks).toBe(seen)
  })
})
