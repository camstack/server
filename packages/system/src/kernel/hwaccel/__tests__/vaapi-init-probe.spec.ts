/**
 * A VA driver libva cannot initialise is reported ONCE, by name, and leaves the
 * decode preference list — instead of every session trying it and failing.
 *
 * Measured 2026-10-23 (intel-1.2.509, hub + agent-a): Intel's iHD 25.2.4
 * exports only `__vaDriverInit_1_22`, the container's Ubuntu libva is 2.20, so
 * `vaInitialize` failed — and the resolver still offered `qsv, vaapi`, which
 * produced 722 `hwaccel 'vaapi' failed` lines a day while every frame was
 * decoded in software (N100 load 13.9).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IScopedLogger, LogExtras } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createKernelHwAccel,
  type PlatformSignals,
  pickBackendsForPlatform,
} from '../hwaccel-resolver.js'
import {
  classifyVainfo,
  readDriverInitSymbols,
  type VaapiInitStatus,
  type VainfoRun,
} from '../vaapi-init-probe.js'

/** What `vainfo --display drm` printed on the measured nodes (libva 2.20 + iHD 25.2.4). */
const FAILED_OUTPUT = [
  'libva info: VA-API version 1.20.0',
  "libva info: User environment variable requested driver 'iHD'",
  'libva info: Trying to open /usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so',
  'libva error: /usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so has no function __vaDriverInit_1_0',
  'libva info: va_openDriver() returns -1',
  'vaInitialize failed with error code -1 (unknown libva error),exit',
].join('\n')

const OK_OUTPUT = [
  'libva info: VA-API version 1.22.0',
  'libva info: Trying to open /usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so',
  'libva info: Found init function __vaDriverInit_1_22',
  'libva info: va_openDriver() returns 0',
  'vainfo: VA-API version: 1.22 (libva 2.22.0)',
  'vainfo: Driver version: Intel iHD driver for Intel(R) Gen Graphics - 25.2.4 ()',
].join('\n')

const INTEL_LINUX: PlatformSignals = {
  platform: 'linux',
  arch: 'x64',
  hasNvidiaGpu: false,
  hasAmdGpu: false,
  hasIntelGpu: true,
  hasRenderNode: true,
  hasIntelNpu: false,
  coral: null,
}

const INIT_FAILED: VaapiInitStatus = classifyVainfo(
  { exitCode: 1, output: FAILED_OUTPUT, spawnError: null },
  ['__vaDriverInit_1_22'],
)

describe('classifyVainfo', () => {
  it('names the ABI gap: the driver needs VA-API 1.22, libva has 1.20', () => {
    expect(INIT_FAILED.state).toBe('init-failed')
    expect(INIT_FAILED.summary).toBe(
      'vaapi: init-failed (driver iHD needs VA-API >= 1.22, libva has 1.20)',
    )
    expect(INIT_FAILED.vaApiVersion).toBe('1.20')
    expect(INIT_FAILED.driverNeedsVaApi).toBe('1.22')
    expect(INIT_FAILED.driverPath).toBe('/usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so')
  })

  it('a failure without an ABI explanation still says init-failed, with libva last words', () => {
    const run: VainfoRun = {
      exitCode: 1,
      output:
        'libva info: VA-API version 1.20.0\nvaInitialize failed with error code 1 (operation failed),exit',
      spawnError: null,
    }
    const res = classifyVainfo(run, [])
    expect(res.state).toBe('init-failed')
    expect(res.summary).toContain('vaapi: init-failed')
    expect(res.summary).toContain('vaInitialize failed with error code 1')
  })

  it('exit 0 is ok', () => {
    const res = classifyVainfo({ exitCode: 0, output: OK_OUTPUT, spawnError: null }, [])
    expect(res.state).toBe('ok')
    expect(res.vaApiVersion).toBe('1.22')
  })

  it('no vainfo binary (a bare host) is unknown, never a failure', () => {
    const res = classifyVainfo({ exitCode: null, output: '', spawnError: 'ENOENT' }, [])
    expect(res.state).toBe('unknown')
  })
})

describe('readDriverInitSymbols', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('finds an init symbol that straddles a read-chunk boundary', async () => {
    dir = mkdtempSync(join(tmpdir(), 'va-drv-'))
    const path = join(dir, 'iHD_drv_video.so')
    const pad = Buffer.alloc(64 * 1024 - 7, 0)
    writeFileSync(path, Buffer.concat([pad, Buffer.from('__vaDriverInit_1_22\u0000tail')]))
    expect(await readDriverInitSymbols(path)).toEqual(['__vaDriverInit_1_22'])
  })

  it('a name cut between its digits at a chunk boundary is read whole', async () => {
    dir = mkdtempSync(join(tmpdir(), 'va-drv-'))
    const path = join(dir, 'iHD_drv_video.so')
    const name = '__vaDriverInit_1_22'
    // The first 64 KiB chunk ends right after `__vaDriverInit_1_2`.
    const pad = Buffer.alloc(64 * 1024 - (name.length - 1), 0)
    writeFileSync(path, Buffer.concat([pad, Buffer.from(`${name}\u0000`)]))
    expect(await readDriverInitSymbols(path)).toEqual([name])
  })

  it('an unreadable driver yields no symbols', async () => {
    expect(await readDriverInitSymbols('/nonexistent/iHD_drv_video.so')).toEqual([])
  })
})

describe('pickBackendsForPlatform with the VA init verdict', () => {
  it('drops vaapi AND qsv when libva cannot initialise the driver, and says why', () => {
    const res = pickBackendsForPlatform(INTEL_LINUX, INIT_FAILED)
    expect(res.preferred).toEqual([])
    expect(res.rationale).toContain(
      'vaapi: init-failed (driver iHD needs VA-API >= 1.22, libva has 1.20)',
    )
  })

  it('keeps cuda when only VA failed', () => {
    const res = pickBackendsForPlatform({ ...INTEL_LINUX, hasNvidiaGpu: true }, INIT_FAILED)
    expect(res.preferred).toEqual(['cuda', 'nvdec'])
  })

  it('an ok or unknown verdict changes nothing', () => {
    const ok = classifyVainfo({ exitCode: 0, output: OK_OUTPUT, spawnError: null }, [])
    const unknown = classifyVainfo({ exitCode: null, output: '', spawnError: 'ENOENT' }, [])
    expect(pickBackendsForPlatform(INTEL_LINUX, ok).preferred).toEqual(['qsv', 'vaapi'])
    expect(pickBackendsForPlatform(INTEL_LINUX, unknown).preferred).toEqual(['qsv', 'vaapi'])
    expect(pickBackendsForPlatform(INTEL_LINUX, null).preferred).toEqual(['qsv', 'vaapi'])
  })
})

interface LoggedLine {
  readonly level: 'error' | 'warn' | 'info' | 'debug'
  readonly message: string
  readonly extras: LogExtras | undefined
}

function recordingLogger(lines: LoggedLine[]): IScopedLogger {
  const logger: IScopedLogger = {
    debug: (message, extras) => lines.push({ level: 'debug', message, extras }),
    info: (message, extras) => lines.push({ level: 'info', message, extras }),
    warn: (message, extras) => lines.push({ level: 'warn', message, extras }),
    error: (message, extras) => lines.push({ level: 'error', message, extras }),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

describe('createKernelHwAccel', () => {
  it('probes VA once, logs ERROR once with the versions, and stops offering vaapi', async () => {
    const lines: LoggedLine[] = []
    let probes = 0
    const hw = createKernelHwAccel({
      logger: recordingLogger(lines),
      probeSignals: () => INTEL_LINUX,
      probeVaapi: async () => {
        probes += 1
        return INIT_FAILED
      },
      reportOnce: { reported: false },
    })
    const first = await hw.resolve(null)
    const second = await hw.resolve(undefined)
    expect(first.preferred).toEqual([])
    expect(second.preferred).toEqual([])
    expect(probes).toBe(1)
    const errors = lines.filter((l) => l.level === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain(
      'vaapi: init-failed (driver iHD needs VA-API >= 1.22, libva has 1.20)',
    )
  })

  it('an explicit backend override skips the VA probe', async () => {
    let probes = 0
    const hw = createKernelHwAccel({
      probeSignals: () => INTEL_LINUX,
      probeVaapi: async () => {
        probes += 1
        return INIT_FAILED
      },
      reportOnce: { reported: false },
    })
    expect((await hw.resolve('vaapi')).preferred).toEqual(['vaapi'])
    expect(probes).toBe(0)
  })

  it('a host without a render node is never VA-probed', async () => {
    let probes = 0
    const hw = createKernelHwAccel({
      probeSignals: () => ({ ...INTEL_LINUX, hasIntelGpu: false, hasRenderNode: false }),
      probeVaapi: async () => {
        probes += 1
        return INIT_FAILED
      },
      reportOnce: { reported: false },
    })
    await hw.resolve(null)
    expect(probes).toBe(0)
  })
})
