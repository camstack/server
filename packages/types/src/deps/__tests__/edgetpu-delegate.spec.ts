/**
 * Which libedgetpu a node loads, and what the deps downloader stages per OS.
 * The desktop's data directory is not `/data`, so a delegate found only at
 * the hub's historical path is a delegate the desktop never finds.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '../../interfaces/logging.js'
import {
  chooseEdgetpuDelegate,
  declaresEdgetpuDelegate,
  EDGETPU_DELEGATE_DIRECTIVE,
  ensureEdgetpuDelegate,
  getEdgetpuDelegateArtifact,
  LEGACY_EDGETPU_LIB,
} from '../edgetpu-delegate.js'

function present(...paths: string[]): (p: string) => boolean {
  return (p) => paths.includes(p)
}

describe('chooseEdgetpuDelegate', () => {
  it('finds the copy staged under the node data root (the desktop case)', () => {
    const staged = '/Users/me/Library/CamStack/data/deps/edgetpu/lib/libedgetpu.1.dylib'
    expect(
      chooseEdgetpuDelegate({
        platform: 'darwin',
        dataDir: '/Users/me/Library/CamStack/data',
        override: undefined,
        exists: present(staged),
      }),
    ).toEqual({ path: staged, origin: 'staged' })
  })

  it('on the hub image the staged path IS the historical one', () => {
    expect(
      chooseEdgetpuDelegate({
        platform: 'linux',
        dataDir: '/data',
        override: undefined,
        exists: present(LEGACY_EDGETPU_LIB),
      }),
    ).toEqual({ path: LEGACY_EDGETPU_LIB, origin: 'staged' })
  })

  it('keeps the historical path for a Linux node whose data root is elsewhere', () => {
    expect(
      chooseEdgetpuDelegate({
        platform: 'linux',
        dataDir: '/srv/camstack',
        override: undefined,
        exists: present(LEGACY_EDGETPU_LIB),
      }),
    ).toEqual({ path: LEGACY_EDGETPU_LIB, origin: 'legacy' })
  })

  it('an override wins, and one naming a missing file is not silently replaced', () => {
    const staged = '/d/deps/edgetpu/lib/libedgetpu.so.1'
    const look = { platform: 'linux' as const, dataDir: '/d' }
    expect(
      chooseEdgetpuDelegate({
        ...look,
        override: '/opt/x.so',
        exists: present('/opt/x.so', staged),
      }),
    ).toEqual({ path: '/opt/x.so', origin: 'override' })
    expect(
      chooseEdgetpuDelegate({
        ...look,
        override: '/opt/x.so',
        exists: present(staged),
      }),
    ).toBeNull()
  })

  it('answers null when nothing is installed', () => {
    expect(
      chooseEdgetpuDelegate({
        platform: 'linux',
        dataDir: '/d',
        override: undefined,
        exists: present(),
      }),
    ).toBeNull()
  })
})

describe('getEdgetpuDelegateArtifact', () => {
  it('pins the delegate + libusb debs on Linux, verified by SHA-256', () => {
    for (const arch of ['x64', 'arm64']) {
      const a = getEdgetpuDelegateArtifact('linux', arch)
      if (!a.supported) throw new Error(a.reason)
      expect(a.files.map((f) => f.installAs)).toEqual(['libedgetpu.so.1', 'libusb-1.0.so.0'])
      expect(a.files.every((f) => f.container === 'deb' && /^[0-9a-f]{64}$/.test(f.sha256))).toBe(
        true,
      )
      expect(a.files[0]?.url).toContain('/16.0TF2.17.1-1/libedgetpu1-std_')
    }
  })

  it('pins the Apple Silicon zip and stages it under the name the pool loads', () => {
    const a = getEdgetpuDelegateArtifact('darwin', 'arm64')
    if (!a.supported) throw new Error(a.reason)
    expect(a.files).toHaveLength(1)
    expect(a.files[0]?.container).toBe('zip')
    expect(a.files[0]?.installAs).toBe('libedgetpu.1.dylib')
  })

  it('refuses Windows and Intel macOS BY NAME', () => {
    const win = getEdgetpuDelegateArtifact('win32', 'x64')
    const intel = getEdgetpuDelegateArtifact('darwin', 'x64')
    expect(win.supported).toBe(false)
    expect(intel.supported).toBe(false)
    if (!win.supported) expect(win.reason).toMatch(/Windows/)
    if (!intel.supported) expect(intel.reason).toMatch(/x86_64 wheel/)
  })
})

describe('declaresEdgetpuDelegate', () => {
  it('reads the directive line, and nothing that merely mentions the library', () => {
    expect(declaresEdgetpuDelegate(`ai-edge-litert==2.1.6\n${EDGETPU_DELEGATE_DIRECTIVE}\n`)).toBe(
      true,
    )
    expect(declaresEdgetpuDelegate('# libedgetpu.so.1 is a system library\nai-edge-litert')).toBe(
      false,
    )
  })
})

function logger(): IScopedLogger & { lines: string[] } {
  const lines: string[] = []
  const record = (msg: string): void => {
    lines.push(msg)
  }
  const self: IScopedLogger & { lines: string[] } = {
    lines,
    debug: record,
    info: record,
    warn: record,
    error: record,
    child: () => self,
    withTags: () => self,
  }
  return self
}

describe('ensureEdgetpuDelegate', () => {
  let dataDir: string
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'edgetpu-delegate-'))
  })
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('a staged delegate is reported and nothing is fetched', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const lib = join(dataDir, 'deps', 'edgetpu', 'lib')
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(lib, 'libedgetpu.so.1'), 'elf')
    const r = await ensureEdgetpuDelegate(dataDir, logger(), {
      env: {},
      platform: 'linux',
      arch: 'x64',
    })
    expect(r).toEqual({
      kind: 'ready',
      path: join(lib, 'libedgetpu.so.1'),
      origin: 'staged',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('Windows answers unavailable with the reason, never throws, never fetches', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const r = await ensureEdgetpuDelegate(dataDir, logger(), {
      env: {},
      platform: 'win32',
      arch: 'x64',
    })
    expect(r.kind).toBe('unavailable')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a download that is not the pinned artifact is refused and nothing is staged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(Buffer.from('not the pinned deb'), { status: 200 })),
    )
    await expect(
      ensureEdgetpuDelegate(dataDir, logger(), {
        env: {},
        platform: 'linux',
        arch: 'x64',
      }),
    ).rejects.toThrow(/does not match its pinned checksum/)
    expect(
      chooseEdgetpuDelegate({
        platform: 'linux',
        dataDir,
        override: undefined,
        exists: existsSync,
      }),
    ).toBeNull()
    expect(readdirSync(join(dataDir, 'deps', 'edgetpu', 'lib'))).toEqual([])
  })
})
