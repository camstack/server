/**
 * `scripts/docker/check-libva-abi.sh` — the image build refuses a VA driver
 * that needs a newer VA-API than the libva beside it.
 *
 * Measured 2026-10-23 (intel-1.2.509, hub + agent-a): Intel's iHD 25.2.4
 * exports only `__vaDriverInit_1_22`, Ubuntu's libva 2.20 looks for `_1_20`,
 * `vaInitialize` fails, and every decode ran in software with 722
 * `hwaccel 'vaapi' failed` lines a day. The image built green.
 *
 * The script is exercised for real: a fake driver file carrying the init
 * symbol, and a `dpkg-query` shim on PATH answering the libva2 version.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = resolve(__dirname, '../docker/check-libva-abi.sh')

interface RunResult {
  readonly status: number | null
  readonly out: string
}

describe('check-libva-abi.sh', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'libva-abi-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function driverExporting(...symbols: readonly string[]): string {
    const path = join(dir, 'iHD_drv_video.so')
    // The symbol names sit in the ELF string table between binary bytes.
    writeFileSync(path, Buffer.concat(symbols.map((s) => Buffer.from(`\u0000\u0007${s}\u0000`))))
    return path
  }

  function run(driver: string, libva2Version: string): RunResult {
    const bin = join(dir, 'bin')
    rmSync(bin, { recursive: true, force: true })
    spawnSync('mkdir', ['-p', bin])
    const shim = join(bin, 'dpkg-query')
    writeFileSync(shim, `#!/bin/sh\nprintf '%s' '${libva2Version}'\n`)
    chmodSync(shim, 0o755)
    const res = spawnSync('sh', [SCRIPT, driver], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, CAMSTACK_LIBVA_ABI_SKIP_DEVICE: '1' },
    })
    return { status: res.status, out: `${res.stdout}${res.stderr}` }
  }

  it('refuses the measured pair: iHD needs VA-API 1.22, Ubuntu libva 2.20 provides 1.20', () => {
    const res = run(driverExporting('__vaDriverInit_1_22'), '2.20.0-2build1')
    expect(res.status).toBe(1)
    expect(res.out).toContain('needs VA-API >= 1.22')
    expect(res.out).toContain('provides 1.20')
  })

  it('accepts the pinned Intel-repo libva beside the same driver', () => {
    const res = run(driverExporting('__vaDriverInit_1_22'), '2.22.0.2-96~u24.04')
    expect(res.status).toBe(0)
    expect(res.out).toContain('VA-API 1.22')
  })

  it('accepts a driver built against an older VA-API than the libva present', () => {
    expect(run(driverExporting('__vaDriverInit_1_20'), '2.22.0.2-96~u24.04').status).toBe(0)
  })

  it('judges by the NEWEST init symbol a driver exports', () => {
    const res = run(driverExporting('__vaDriverInit_1_20', '__vaDriverInit_1_22'), '2.20.0-2build1')
    expect(res.status).toBe(1)
  })

  it('fails loudly on a driver with no init symbol at all', () => {
    const res = run(driverExporting('something_else'), '2.22.0.2-96~u24.04')
    expect(res.status).toBe(1)
    expect(res.out).toContain('no __vaDriverInit')
  })

  it('fails loudly when the driver file is missing', () => {
    const res = run(join(dir, 'absent_drv_video.so'), '2.22.0.2-96~u24.04')
    expect(res.status).toBe(1)
  })
})
