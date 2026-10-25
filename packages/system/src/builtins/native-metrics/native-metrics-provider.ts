import { execFile, execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import type {
  CpuBreakdown,
  DiskIoSnapshot,
  DiskSpaceInfo,
  MemoryInfo,
  MetricsGpuInfo,
  NetworkIoSnapshot,
  PidResourceStats,
  PressureInfo,
  ProcessResourceInfo,
  SystemResourceSnapshot,
} from '@camstack/types'
import { findOnPath, readNvidiaGpu } from './gpu-probe.js'

const IS_DARWIN = os.platform() === 'darwin'
const IS_LINUX = os.platform() === 'linux'

// Node.js internal API — no public type declarations exist.
// _getActiveHandles and _getActiveRequests are undocumented but stable across all LTS versions.
interface NodeProcessInternals {
  _getActiveHandles?: () => unknown[]
  _getActiveRequests?: () => unknown[]
}

// ===========================================================================
// NativeMetricsProvider — implements the metrics-provider capability using
// OS-level APIs. Zero external dependencies. Works on macOS and Linux.
//
// Lifecycle methods (startSampling/stopSampling) and the `id` field are
// NOT part of the capability contract — they live on the class for addon
// lifecycle use. Only the async methods declared on IMetricsProvider cross
// the tRPC/Moleculer boundary.
// ===========================================================================

interface SamplingDiagnostics {
  warn(message: string, meta?: Record<string, unknown>): void
}

export class NativeMetricsProvider {
  readonly id = 'native'

  private cachedSnapshot: SystemResourceSnapshot | null = null
  private samplingTimer: ReturnType<typeof setInterval> | null = null
  private macMemTimer: ReturnType<typeof setInterval> | null = null
  private prevCpu: CpuTimes
  private diagnostics: SamplingDiagnostics | null = null
  private consecutiveSampleErrors = 0

  constructor() {
    this.prevCpu = aggregateCpuTimes()
  }

  /**
   * Optional diagnostics sink for sampling errors. The first failure and
   * every Nth failure thereafter are reported so a permanently-broken
   * collector doesn't spam logs but is still observable.
   */
  setDiagnostics(diag: SamplingDiagnostics): void {
    this.diagnostics = diag
  }

  // ─── Lifecycle (not on the cap contract) ────────────────────────────

  startSampling(intervalMs: number): void {
    // Seed macOS vm_stat cache immediately
    if (IS_DARWIN) {
      sampleMacMemory(this)
      this.macMemTimer = setInterval(() => sampleMacMemory(this), 5000)
      if (this.macMemTimer.unref) this.macMemTimer.unref()
    }

    // First sample immediately
    this.collectSnapshot()
      .then((s) => {
        this.cachedSnapshot = s
        this.consecutiveSampleErrors = 0
      })
      .catch((err: unknown) => this.reportSampleError(err))

    this.samplingTimer = setInterval(() => {
      this.collectSnapshot()
        .then((s) => {
          this.cachedSnapshot = s
          this.consecutiveSampleErrors = 0
        })
        .catch((err: unknown) => this.reportSampleError(err))
    }, intervalMs)
    if (this.samplingTimer.unref) this.samplingTimer.unref()
  }

  private reportSampleError(err: unknown): void {
    this.consecutiveSampleErrors++
    if (!this.diagnostics) return
    // First failure + every 60th sample (~1/min at 1s interval)
    const shouldLog = this.consecutiveSampleErrors === 1 || this.consecutiveSampleErrors % 60 === 0
    if (!shouldLog) return
    this.diagnostics.warn('metrics-provider sample failed', {
      consecutiveErrors: this.consecutiveSampleErrors,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  stopSampling(): void {
    if (this.samplingTimer) {
      clearInterval(this.samplingTimer)
      this.samplingTimer = null
    }
    if (this.macMemTimer) {
      clearInterval(this.macMemTimer)
      this.macMemTimer = null
    }
  }

  // ─── Cap contract — async methods ───────────────────────────────────

  async collectSnapshot(): Promise<SystemResourceSnapshot> {
    const cpu = this.sampleCpu()
    const memory = this.getMemoryInfo()
    const processInfo = getProcessResources()

    const [gpu, network, disk, cpuTemp] = await Promise.all([
      getGpuInfoInternal().catch(() => null),
      takeNetworkIoSnapshot(),
      takeDiskIoSnapshot(),
      getCpuTemperatureInternal().catch(() => null),
    ])

    const snapshot: SystemResourceSnapshot = {
      cpu,
      memory,
      gpu,
      network,
      disk,
      pressure: {
        cpu: getPressure('cpu'),
        memory: getPressure('memory'),
        io: getPressure('io'),
      },
      process: processInfo,
      cpuTemperature: cpuTemp,
      timestampMs: Date.now(),
    }

    this.cachedSnapshot = snapshot
    return snapshot
  }

  async getCached(): Promise<SystemResourceSnapshot | null> {
    return this.cachedSnapshot
  }

  async getCurrent(): Promise<{
    cpuPercent: number
    memoryPercent: number
    memoryUsedMB: number
    memoryTotalMB: number
    diskPercent?: number
    temperature?: number
    gpuPercent?: number
    gpuMemoryPercent?: number
  }> {
    const s = this.cachedSnapshot ?? (await this.collectSnapshot())
    const mb = (bytes: number) => Math.round(bytes / 1024 / 1024)
    return {
      cpuPercent: s.cpu.total,
      memoryPercent: s.memory.percent,
      memoryUsedMB: mb(s.memory.usedBytes),
      memoryTotalMB: mb(s.memory.totalBytes),
      temperature: s.cpuTemperature ?? undefined,
      gpuPercent: s.gpu?.utilization,
      gpuMemoryPercent:
        s.gpu && s.gpu.memoryTotalBytes > 0
          ? Math.round((s.gpu.memoryUsedBytes / s.gpu.memoryTotalBytes) * 1000) / 10
          : undefined,
    }
  }

  async getDiskSpace(input: { dirPath: string }): Promise<DiskSpaceInfo> {
    return getDiskSpaceInternal(input.dirPath)
  }

  async getGpuInfo(): Promise<MetricsGpuInfo | null> {
    return getGpuInfoInternal()
  }

  async getCpuTemperature(): Promise<number | null> {
    return getCpuTemperatureInternal()
  }

  async getProcessStats(input: { pids: number[] }): Promise<PidResourceStats[]> {
    const { getPidStats } = await import('../../process/resource-monitor.js')
    const raw = await getPidStats(input.pids)
    const result: PidResourceStats[] = []
    for (const [pid, s] of raw) {
      result.push({
        pid,
        cpu: s.cpu,
        memory: s.memory,
        privateBytes: s.privateBytes,
        sharedBytes: s.sharedBytes,
      })
    }
    return result
  }

  // ─── Internal: CPU sampling ─────────────────────────────────────────

  private sampleCpu(): CpuBreakdown {
    const curr = aggregateCpuTimes()
    const prev = this.prevCpu
    this.prevCpu = curr

    const dUser = curr.user - prev.user
    const dNice = curr.nice - prev.nice
    const dSys = curr.sys - prev.sys
    const dIrq = curr.irq - prev.irq
    const dIdle = curr.idle - prev.idle
    const dTotal = dUser + dNice + dSys + dIrq + dIdle

    const pct = (v: number) => (dTotal === 0 ? 0 : Math.round((v / dTotal) * 1000) / 10)

    return {
      total: pct(dUser + dNice + dSys + dIrq),
      user: pct(dUser),
      system: pct(dSys),
      irq: pct(dIrq),
      nice: pct(dNice),
      loadAvg: os.loadavg() as [number, number, number],
      cores: os.cpus().length,
    }
  }

  // ─── Internal: Memory ───────────────────────────────────────────────

  /** Cached macOS memory (set by sampleMacMemory timer). */
  _cachedMacMem: MemoryInfo | null = null

  private getMemoryInfo(): MemoryInfo {
    const total = os.totalmem()
    if (total === 0) {
      return {
        percent: 0,
        totalBytes: 0,
        usedBytes: 0,
        availableBytes: 0,
        swapUsedBytes: 0,
        swapTotalBytes: 0,
      }
    }

    if (IS_DARWIN && this._cachedMacMem !== null) {
      return this._cachedMacMem
    }

    const free = os.freemem()
    const used = total - free
    let swapUsedBytes = 0
    let swapTotalBytes = 0

    if (IS_LINUX) {
      try {
        const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8')
        const swapTotal = parseInt(meminfo.match(/SwapTotal:\s+(\d+)/)?.[1] ?? '0', 10) * 1024
        const swapFree = parseInt(meminfo.match(/SwapFree:\s+(\d+)/)?.[1] ?? '0', 10) * 1024
        swapTotalBytes = swapTotal
        swapUsedBytes = swapTotal - swapFree
      } catch {
        /* ignore */
      }
    }

    return {
      percent: Math.round(((total - free) / total) * 1000) / 10,
      totalBytes: total,
      usedBytes: used,
      availableBytes: free,
      swapUsedBytes,
      swapTotalBytes,
    }
  }
}

// ===========================================================================
// Internal helpers (module-private, no side effects at import time)
// ===========================================================================

interface CpuTimes {
  user: number
  nice: number
  sys: number
  irq: number
  idle: number
}

function aggregateCpuTimes(): CpuTimes {
  const cpus = os.cpus()
  let user = 0,
    nice = 0,
    sys = 0,
    irq = 0,
    idle = 0
  for (const cpu of cpus) {
    user += cpu.times.user
    nice += cpu.times.nice
    sys += cpu.times.sys
    irq += cpu.times.irq
    idle += cpu.times.idle
  }
  return { user, nice, sys, irq, idle }
}

// ─── macOS vm_stat memory sampling ─────────────────────────────────────────

function sampleMacMemory(provider: NativeMetricsProvider): void {
  try {
    const output = execFileSync('vm_stat', { timeout: 2000, encoding: 'utf-8' })
    const pageSize = 16384 // macOS ARM64
    const parse = (label: string): number => {
      const match = output.match(new RegExp(`${label}:\\s+(\\d+)`))
      return match ? parseInt(match[1]!, 10) * pageSize : 0
    }

    const free = parse('Pages free')
    const inactive = parse('Pages inactive')
    const purgeable = parse('Pages purgeable')
    const speculative = parse('Pages speculative')
    const available = free + inactive + purgeable + speculative
    const total = os.totalmem()
    const used = total - available

    let swapUsedBytes = 0
    let swapTotalBytes = 0
    try {
      const swapOut = execFileSync('sysctl', ['-n', 'vm.swapusage'], {
        timeout: 2000,
        encoding: 'utf-8',
      })
      const totalMatch = swapOut.match(/total\s*=\s*([\d.]+)M/)
      const usedMatch = swapOut.match(/used\s*=\s*([\d.]+)M/)
      if (totalMatch) swapTotalBytes = parseFloat(totalMatch[1]!) * 1024 * 1024
      if (usedMatch) swapUsedBytes = parseFloat(usedMatch[1]!) * 1024 * 1024
    } catch {
      /* ignore */
    }

    provider._cachedMacMem = {
      percent: Math.round((used / total) * 1000) / 10,
      totalBytes: total,
      usedBytes: used,
      availableBytes: available,
      swapUsedBytes,
      swapTotalBytes,
    }
  } catch {
    provider._cachedMacMem = null
  }
}

// ─── Disk space ────────────────────────────────────────────────────────────

function getDiskSpaceInternal(dirPath: string): Promise<DiskSpaceInfo> {
  return new Promise((resolve, reject) => {
    fs.statfs(dirPath, (err, stats) => {
      if (err) return reject(err)
      const totalBytes = stats.blocks * stats.bsize
      const availableBytes = stats.bavail * stats.bsize
      const usedBytes = totalBytes - stats.bfree * stats.bsize
      resolve({
        path: dirPath,
        totalBytes,
        usedBytes,
        availableBytes,
        percent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
      })
    })
  })
}

// ─── Disk I/O ──────────────────────────────────────────────────────────────

async function takeDiskIoSnapshot(): Promise<DiskIoSnapshot> {
  const now = Date.now()

  if (IS_LINUX) {
    try {
      const data = fs.readFileSync('/proc/diskstats', 'utf-8')
      let readOps = 0,
        readBytes = 0,
        writeOps = 0,
        writeBytes = 0
      for (const line of data.split('\n')) {
        const parts = line.trim().split(/\s+/)
        if (parts.length < 14) continue
        const devName = parts[2]!
        if (/\d+$/.test(devName) && !/^nvme\d+n\d+$/.test(devName)) continue
        readOps += parseInt(parts[3]!, 10) || 0
        readBytes += (parseInt(parts[5]!, 10) || 0) * 512
        writeOps += parseInt(parts[7]!, 10) || 0
        writeBytes += (parseInt(parts[9]!, 10) || 0) * 512
      }
      return { readBytes, writeBytes, readOps, writeOps, timestampMs: now }
    } catch {
      /* fallback */
    }
  }

  return { readBytes: 0, writeBytes: 0, readOps: 0, writeOps: 0, timestampMs: now }
}

// ─── Network I/O ───────────────────────────────────────────────────────────

async function takeNetworkIoSnapshot(): Promise<NetworkIoSnapshot> {
  const now = Date.now()

  if (IS_LINUX) {
    try {
      const data = fs.readFileSync('/proc/net/dev', 'utf-8')
      let rxBytes = 0,
        txBytes = 0,
        rxPackets = 0,
        txPackets = 0,
        rxErrors = 0,
        txErrors = 0
      for (const line of data.split('\n')) {
        const match = line.match(/^\s*(\w+):\s+(.+)$/)
        if (!match) continue
        if (match[1] === 'lo') continue
        const cols = match[2]!.trim().split(/\s+/)
        rxBytes += parseInt(cols[0]!, 10) || 0
        rxPackets += parseInt(cols[1]!, 10) || 0
        rxErrors += parseInt(cols[2]!, 10) || 0
        txBytes += parseInt(cols[8]!, 10) || 0
        txPackets += parseInt(cols[9]!, 10) || 0
        txErrors += parseInt(cols[10]!, 10) || 0
      }
      return { rxBytes, txBytes, rxPackets, txPackets, rxErrors, txErrors, timestampMs: now }
    } catch {
      /* fallback */
    }
  }

  if (IS_DARWIN) {
    try {
      const stdout = await execAsync('netstat', ['-ib'])
      let rxBytes = 0,
        txBytes = 0,
        rxPackets = 0,
        txPackets = 0,
        rxErrors = 0,
        txErrors = 0
      for (const line of stdout.split('\n')) {
        const parts = line.trim().split(/\s+/)
        if (parts.length < 11) continue
        if (parts[0] === 'lo0' || parts[0] === 'Name') continue
        if (!parts[2]?.startsWith('Link#')) continue
        rxPackets += parseInt(parts[4]!, 10) || 0
        rxErrors += parseInt(parts[5]!, 10) || 0
        rxBytes += parseInt(parts[6]!, 10) || 0
        txPackets += parseInt(parts[7]!, 10) || 0
        txErrors += parseInt(parts[8]!, 10) || 0
        txBytes += parseInt(parts[9]!, 10) || 0
      }
      return { rxBytes, txBytes, rxPackets, txPackets, rxErrors, txErrors, timestampMs: now }
    } catch {
      /* fallback */
    }
  }

  return {
    rxBytes: 0,
    txBytes: 0,
    rxPackets: 0,
    txPackets: 0,
    rxErrors: 0,
    txErrors: 0,
    timestampMs: now,
  }
}

// ─── CPU temperature ───────────────────────────────────────────────────────

async function getCpuTemperatureInternal(): Promise<number | null> {
  if (IS_LINUX) {
    const paths = ['/sys/class/thermal/thermal_zone0/temp', '/sys/class/hwmon/hwmon0/temp1_input']
    for (const p of paths) {
      try {
        const raw = fs.readFileSync(p, 'utf-8').trim()
        const millideg = parseInt(raw, 10)
        if (!isNaN(millideg)) return Math.round(millideg / 100) / 10
      } catch {
        continue
      }
    }
  }

  if (IS_DARWIN) {
    try {
      const stdout = await execAsync(
        'sudo',
        ['-n', 'powermetrics', '--samplers', 'smc', '-i', '1', '-n', '1'],
        3000,
      )
      const match = stdout.match(/CPU die temperature:\s+([\d.]+)\s*C/)
      if (match) return Math.round(parseFloat(match[1]!) * 10) / 10
    } catch {
      /* no root */
    }
  }

  return null
}

// ─── GPU info ──────────────────────────────────────────────────────────────

async function getGpuInfoInternal(): Promise<MetricsGpuInfo | null> {
  if (IS_DARWIN) {
    try {
      const stdout = await execAsync('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator'])
      const utilMatch = stdout.match(/"GPU Core Utilization"\s*=\s*(\d+)/)
      const util = utilMatch ? parseInt(utilMatch[1]!, 10) : 0
      const utilPct = util > 1000 ? Math.round(util / 10000000) : util
      return {
        utilization: Math.min(100, utilPct),
        model: 'Apple Silicon GPU',
        memoryUsedBytes: 0,
        memoryTotalBytes: 0,
        temperature: null,
      }
    } catch {
      /* ignore */
    }
  }

  if (IS_LINUX) {
    // Forks ONLY when `nvidia-smi` is on PATH — `gpu-probe.ts` says why.
    return readNvidiaGpu({
      findOnPath: (binary) => findOnPath(binary, process.env['PATH']),
      exec: (command, args) => execAsync(command, [...args]),
    })
  }

  return null
}

// ─── Process resources ─────────────────────────────────────────────────────

function getProcessResources(): ProcessResourceInfo {
  let openFds = 0
  let threadCount = 0

  if (IS_LINUX) {
    try {
      openFds = fs.readdirSync(`/proc/${process.pid}/fd`).length
    } catch {
      /* ignore */
    }
    try {
      const status = fs.readFileSync(`/proc/${process.pid}/status`, 'utf-8')
      const match = status.match(/Threads:\s+(\d+)/)
      if (match) threadCount = parseInt(match[1]!, 10)
    } catch {
      /* ignore */
    }
  }

  const nodeProcess = process as typeof process & NodeProcessInternals
  return {
    openFds,
    threadCount,
    activeHandles: (nodeProcess._getActiveHandles?.() ?? []).length,
    activeRequests: (nodeProcess._getActiveRequests?.() ?? []).length,
  }
}

// ─── Linux PSI ─────────────────────────────────────────────────────────────

function getPressure(resource: 'cpu' | 'memory' | 'io'): PressureInfo | null {
  if (!IS_LINUX) return null
  try {
    const data = fs.readFileSync(`/proc/pressure/${resource}`, 'utf-8')
    const parseLine = (prefix: string) => {
      const match = data.match(
        new RegExp(`${prefix} avg10=(\\d+\\.\\d+) avg60=(\\d+\\.\\d+) avg300=(\\d+\\.\\d+)`),
      )
      if (!match) return null
      return {
        avg10: parseFloat(match[1]!),
        avg60: parseFloat(match[2]!),
        avg300: parseFloat(match[3]!),
      }
    }
    const some = parseLine('some')
    if (!some) return null
    return { some, full: parseLine('full') }
  } catch {
    return null
  }
}

// ─── Util ──────────────────────────────────────────────────────────────────

function execAsync(cmd: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      if (err) return reject(err)
      resolve(stdout)
    })
  })
}
