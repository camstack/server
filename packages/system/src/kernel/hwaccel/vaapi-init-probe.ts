/**
 * Can libva initialise the VA driver on this node's render node? (D926)
 *
 * Measured 2026-10-23 (intel-1.2.509, hub + agent-a): Intel's iHD 25.2.4
 * exports only `__vaDriverInit_1_22`, the container's Ubuntu libva 2.20 looks
 * for `_1_20`, and `vaInitialize` failed — while the resolver kept offering
 * `qsv, vaapi`. Every session tried, failed and fell back to software: 722
 * `hwaccel 'vaapi' failed` lines a day and nothing that named the cause.
 *
 * One `vainfo --display drm --device <node>` per process answers it. A failure
 * reads the driver's exported `__vaDriverInit_1_N` so the verdict names the gap
 * (`driver iHD needs VA-API >= 1.22, libva has 1.20`). No `vainfo` on the host
 * (a bare install) is `unknown` — the resolver then behaves as it always did.
 */
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { basename } from 'node:path'

export type VaapiInitState = 'ok' | 'init-failed' | 'unknown'

export interface VaapiInitStatus {
  readonly state: VaapiInitState
  /** One line for logs and the resolver rationale, e.g. `vaapi: init-failed (…)`. */
  readonly summary: string
  /** The VA-API version libva speaks (`1.20`), when vainfo said so. */
  readonly vaApiVersion: string | null
  /** The driver libva tried to open, when vainfo said so. */
  readonly driverPath: string | null
  /** The newest VA-API the driver's exported init symbol asks for (`1.22`). */
  readonly driverNeedsVaApi: string | null
}

export interface VainfoRun {
  readonly exitCode: number | null
  readonly output: string
  /** Set when vainfo could not be run at all (ENOENT, timeout). */
  readonly spawnError: string | null
}

const VAINFO_TIMEOUT_MS = 10_000
const INIT_SYMBOL = /__vaDriverInit_(\d+)_(\d+)/g
const VA_API_VERSION = /VA-API version:? (\d+)\.(\d+)/
const DRIVER_OPEN = /Trying to open (\S+_drv_video\.so)/g

interface Version {
  readonly major: number
  readonly minor: number
}

function newestInitVersion(symbols: readonly string[]): Version | null {
  let best: Version | null = null
  for (const symbol of symbols) {
    for (const m of symbol.matchAll(INIT_SYMBOL)) {
      const v: Version = { major: Number(m[1]), minor: Number(m[2]) }
      if (!best || v.major > best.major || (v.major === best.major && v.minor > best.minor))
        best = v
    }
  }
  return best
}

function lastMatch(text: string, re: RegExp): string | null {
  let last: string | null = null
  for (const m of text.matchAll(re)) last = m[1] ?? null
  return last
}

function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  return lines[lines.length - 1] ?? 'no output'
}

function driverName(driverPath: string | null): string {
  if (!driverPath) return 'unknown'
  return basename(driverPath).replace(/_drv_video\.so$/, '')
}

/** Classify one vainfo run plus the driver's exported init symbols. Pure. */
export function classifyVainfo(run: VainfoRun, driverSymbols: readonly string[]): VaapiInitStatus {
  const va = VA_API_VERSION.exec(run.output)
  const vaApiVersion = va ? `${va[1]}.${va[2]}` : null
  const driverPath = lastMatch(run.output, DRIVER_OPEN)
  const needs = newestInitVersion(driverSymbols)
  const driverNeedsVaApi = needs ? `${needs.major}.${needs.minor}` : null
  const base = { vaApiVersion, driverPath, driverNeedsVaApi }
  if (run.spawnError !== null) {
    return {
      ...base,
      state: 'unknown',
      summary: `vaapi: unknown (vainfo not run: ${run.spawnError})`,
    }
  }
  if (run.exitCode === 0) {
    return {
      ...base,
      state: 'ok',
      summary: `vaapi: ok (VA-API ${vaApiVersion ?? '?'}, driver ${driverName(driverPath)})`,
    }
  }
  const abiGap =
    needs !== null &&
    va !== null &&
    (needs.major > Number(va[1]) || (needs.major === Number(va[1]) && needs.minor > Number(va[2])))
  const reason = abiGap
    ? `driver ${driverName(driverPath)} needs VA-API >= ${driverNeedsVaApi}, libva has ${vaApiVersion}`
    : lastLine(run.output)
  return { ...base, state: 'init-failed', summary: `vaapi: init-failed (${reason})` }
}

/** Run `vainfo` against one render node; never throws. */
export function runVainfo(renderNode: string): Promise<VainfoRun> {
  return new Promise((resolve) => {
    execFile(
      'vainfo',
      ['--display', 'drm', '--device', renderNode],
      { timeout: VAINFO_TIMEOUT_MS, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`
        if (err === null) {
          resolve({ exitCode: 0, output, spawnError: null })
          return
        }
        const code = err.code
        if (typeof code === 'number') {
          resolve({ exitCode: code, output, spawnError: null })
          return
        }
        // ENOENT (no vainfo) or killed by the timeout: not an answer about VA.
        resolve({
          exitCode: null,
          output,
          spawnError: code ?? (err.killed ? 'timeout' : err.message),
        })
      },
    )
  })
}

/**
 * The `__vaDriverInit_N_M` names in a driver file, streamed (iHD is ~43 MB),
 * with an overlap so a name split across two chunks is still found.
 */
export function readDriverInitSymbols(driverPath: string): Promise<readonly string[]> {
  return new Promise((resolve) => {
    const found = new Set<string>()
    let carry = ''
    const stream = createReadStream(driverPath, { encoding: 'latin1', highWaterMark: 64 * 1024 })
    stream.on('data', (chunk) => {
      const text = carry + String(chunk)
      for (const m of text.matchAll(INIT_SYMBOL)) {
        // A match touching the chunk end may be cut mid-digit: the carry re-reads it.
        if (m.index + m[0].length < text.length) found.add(m[0])
      }
      carry = text.slice(-32)
    })
    stream.on('error', () => resolve([]))
    stream.on('end', () => {
      for (const m of carry.matchAll(INIT_SYMBOL)) found.add(m[0])
      resolve([...found].sort())
    })
  })
}

/** Probe one render node: vainfo, and on failure the driver's init symbols. */
export async function probeVaapiInit(renderNode: string): Promise<VaapiInitStatus> {
  const run = await runVainfo(renderNode)
  if (run.spawnError !== null || run.exitCode === 0) return classifyVainfo(run, [])
  const driverPath = lastMatch(run.output, DRIVER_OPEN)
  const symbols = driverPath ? await readDriverInitSymbols(driverPath) : []
  return classifyVainfo(run, symbols)
}
