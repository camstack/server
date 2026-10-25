#!/usr/bin/env tsx
/**
 * Stream-broker GC regression bench — OPT-IN, never part of `npm test` or the
 * per-push CI (`npm run bench:stream-broker-gc`).
 *
 * Why it exists: on 2026-10-15 the hub's `stream-broker` runner was measured at
 * ~166–232 MAJOR GCs a minute and ZERO scavenges, 45–62 % of a core. The cause
 * was not allocation volume but heap SHAPE: a heavy runner kept V8's 64 MB
 * young generation while the mark-compact's old-space headroom (~0.5× a ~100 MB
 * live set) sat below it, so every scavenge promoted enough to restart marking.
 * The remedy is two flags on the spawn argv — `--max-semi-space-size` and
 * `--initial-old-space-size`, declared by the addon's manifest
 * (`execution.semiSpaceMb` / `execution.initialOldSpaceMb`) and emitted by
 * `runnerHeapFlags` — and this bench is what keeps them doing their job.
 *
 * What it runs: `bench-stream-broker-gc/harness.ts` — the REAL `StreamBroker`
 * end to end (native RTSP reader, depacketizer, access-unit assembler, RTP
 * pre-buffer ring, clip ring, RTSP restreamer + `RtspSession` over TCP) fed by
 * a fake camera fleet in a separate process (`generator.mjs`) at the hub's
 * measured load shape (`profile.json`). The harness is spawned under the flags
 * `runnerHeapFlags` computes for the SHIPPED `stream-broker` manifest — the
 * same function the kernel uses at spawn — so the bench judges the real thing,
 * not a copy of the numbers.
 *
 * Assertion (default): majors/min < 40 AND scavenges/min > 0 over the measured
 * window. `--flags today` runs the heavy-class default instead (what a heavy
 * runner gets with no declaration) and is EXPECTED to fail — that is the
 * disarm proof, run it when you touch the flags.
 *
 * Usage:
 *   tsx scripts/bench-stream-broker-gc.mts                      # manifest flags, 20 brokers, 30 s, asserts
 *   tsx scripts/bench-stream-broker-gc.mts --flags today        # class default: shows the regression
 *   tsx scripts/bench-stream-broker-gc.mts --brokers 47 --duration 60 --no-assert
 *   tsx scripts/bench-stream-broker-gc.mts --tally              # top Buffer allocation sites (MB/s)
 */
import { type ChildProcess, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runnerHeapFlags } from '../packages/system/src/kernel/moleculer/runner-heap-flags.ts'

interface BenchOptions {
  readonly flags: 'manifest' | 'today' | 'none'
  readonly brokers: number
  readonly durationS: number
  readonly warmupS: number
  readonly assert: boolean
  readonly tally: boolean
  readonly genPort: number
  readonly restreamPort: number
}

interface GcResult {
  readonly majorsPerMin: number
  readonly minorsPerMin: number
  readonly incrementalPerMin: number
  readonly gcPauseMsPer5Min: number
  readonly cpuPercent: number
  readonly ingestKbps: number
  readonly picturesPerSecond: number
  readonly rtspClients: number
  readonly tally: readonly string[]
}

/** The gate the bench holds the broker to. */
export const MAX_MAJORS_PER_MIN = 40

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BENCH_DIR = path.join(ROOT, 'scripts', 'bench-stream-broker-gc')

function parseArgs(argv: readonly string[]): BenchOptions {
  let flags: BenchOptions['flags'] = 'manifest'
  let brokers = 20
  let durationS = 30
  let warmupS = 15
  let assert = true
  let tally = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${arg} needs a value`)
      return v
    }
    if (arg === '--flags') {
      const v = next()
      if (v !== 'manifest' && v !== 'today' && v !== 'none')
        throw new Error(`--flags ${v}: manifest | today | none`)
      flags = v
    } else if (arg === '--brokers') brokers = Number(next())
    else if (arg === '--duration') durationS = Number(next())
    else if (arg === '--warmup') warmupS = Number(next())
    else if (arg === '--no-assert') assert = false
    else if (arg === '--tally') tally = true
    else throw new Error(`unknown argument ${arg}`)
  }
  return {
    flags,
    brokers,
    durationS,
    warmupS,
    assert,
    tally,
    genPort: Number(process.env['BENCH_GEN_PORT'] ?? 18554),
    restreamPort: Number(process.env['BENCH_RESTREAM_PORT'] ?? 18555),
  }
}

/**
 * The flags the kernel would spawn the broker's runner with. `manifest` reads
 * the SHIPPED `packages/addon-pipeline/package.json` through the kernel's own
 * reader (addonDir points at `dist`, the manifest is one level up — exactly as
 * at spawn). `today` writes a manifest that declares only `heapProfile: heavy`
 * and reads it the same way: the class default a heavy runner gets with no
 * shaping declared.
 */
function flagsFor(mode: BenchOptions['flags']): readonly string[] {
  if (mode === 'none') return []
  if (mode === 'manifest') {
    return runnerHeapFlags([
      { addonId: 'stream-broker', addonDir: path.join(ROOT, 'packages', 'addon-pipeline', 'dist') },
    ])
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-stream-broker-gc-'))
  fs.mkdirSync(path.join(dir, 'dist'))
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      camstack: { addons: [{ id: 'stream-broker', execution: { heapProfile: 'heavy' } }] },
    }),
  )
  return runnerHeapFlags([{ addonId: 'stream-broker', addonDir: path.join(dir, 'dist') }])
}

function parseResult(stdout: string): GcResult {
  const num = (re: RegExp): number => {
    const m = stdout.match(re)
    if (!m) throw new Error(`harness output missing ${re.source}:\n${stdout}`)
    return Number(m[1])
  }
  return {
    majorsPerMin: num(/RESULT maj\/min=([\d.]+)/),
    minorsPerMin: num(/ min\/min=([\d.]+)/),
    incrementalPerMin: num(/ inc\/min=([\d.]+)/),
    gcPauseMsPer5Min: num(/ gcPauseMs\/5min=([\d.]+)/),
    cpuPercent: num(/ cpu=([\d.]+)%/),
    ingestKbps: num(/ ingestKbps=([\d.]+)/),
    picturesPerSecond: num(/ pictures\/s=([\d.]+)/),
    rtspClients: num(/ rtspClients=([\d.]+)/),
    tally: stdout.split('\n').filter((l) => l.startsWith('TALLY')),
  }
}

function spawnGenerator(opts: BenchOptions): ChildProcess {
  const child = spawn(
    process.execPath,
    [path.join(BENCH_DIR, 'generator.mjs'), String(opts.genPort), String(opts.restreamPort)],
    {
      env: { ...process.env, BROKERS: String(opts.brokers) },
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  )
  return child
}

async function runHarness(opts: BenchOptions, flags: readonly string[]): Promise<string> {
  const tsxLoader = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')
  const child = spawn(
    process.execPath,
    [...flags, '--import', tsxLoader, path.join(BENCH_DIR, 'harness.ts')],
    {
      env: {
        ...process.env,
        GEN_PORT: String(opts.genPort),
        RESTREAM_PORT: String(opts.restreamPort),
        BROKERS: String(opts.brokers),
        WARMUP_S: String(opts.warmupS),
        DURATION_S: String(opts.durationS),
        ...(opts.tally ? { TALLY: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  )
  let stdout = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  const code = await new Promise<number>((resolve) => child.on('exit', (c) => resolve(c ?? 1)))
  if (code !== 0) throw new Error(`harness exited ${code}:\n${stdout}`)
  return stdout
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const flags = flagsFor(opts.flags)
  console.log(
    `bench-stream-broker-gc: flags=${opts.flags} [${flags.join(' ')}] brokers=${opts.brokers} warmup=${opts.warmupS}s measure=${opts.durationS}s`,
  )
  const generator = spawnGenerator(opts)
  const stopGenerator = (): void => {
    if (generator.exitCode === null) generator.kill('SIGKILL')
  }
  process.on('SIGINT', () => {
    stopGenerator()
    process.exit(130)
  })
  try {
    await new Promise((r) => setTimeout(r, 1000))
    const result = parseResult(await runHarness(opts, flags))
    console.log(
      [
        '',
        '| flags | majors/min | scavenges/min | incremental/min | GC pause ms / 5 min | CPU | ingest kbps | pictures/s | RTSP clients |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
        `| ${opts.flags} | ${result.majorsPerMin} | ${result.minorsPerMin} | ${result.incrementalPerMin} | ${result.gcPauseMsPer5Min} | ${result.cpuPercent}% | ${result.ingestKbps} | ${result.picturesPerSecond} | ${result.rtspClients} |`,
        '',
      ].join('\n'),
    )
    for (const line of result.tally) console.log(line)
    if (!opts.assert) return
    const failures: string[] = []
    if (!(result.majorsPerMin < MAX_MAJORS_PER_MIN)) {
      failures.push(`majors/min ${result.majorsPerMin} ≥ ${MAX_MAJORS_PER_MIN}`)
    }
    if (!(result.minorsPerMin > 0))
      failures.push('scavenges/min is 0 — the young generation never collects')
    if (failures.length > 0) {
      console.error(`bench-stream-broker-gc RED: ${failures.join('; ')}`)
      process.exitCode = 1
      return
    }
    console.log('bench-stream-broker-gc GREEN')
  } finally {
    stopGenerator()
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
