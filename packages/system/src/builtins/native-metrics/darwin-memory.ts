/**
 * macOS memory accounting, the way Activity Monitor reports "Memory Used":
 * app memory (anonymous pages minus purgeable) + wired + compressed.
 * `os.freemem()` counts only truly free pages on darwin, so total - freemem
 * reads ~94% on a machine Activity Monitor shows at 60%.
 */

export interface VmStatPages {
  readonly pageSize: number
  readonly free: number
  readonly inactive: number
  readonly speculative: number
  readonly wired: number
  readonly purgeable: number
  readonly anonymous: number
  readonly fileBacked: number
  readonly compressor: number
}

export interface DarwinMemory {
  readonly usedBytes: number
  readonly availableBytes: number
  readonly percent: number
}

const PAGE_SIZE_RE = /page size of (\d+) bytes/

function readCounter(output: string, label: string): number | null {
  const match = output.match(new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, 'm'))
  return match ? parseInt(match[1]!, 10) : null
}

/** Parses `vm_stat` output. Returns null when a required counter is missing. */
export function parseVmStat(output: string): VmStatPages | null {
  const pageSize = parseInt(output.match(PAGE_SIZE_RE)?.[1] ?? '', 10)
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null
  const free = readCounter(output, 'Pages free')
  const inactive = readCounter(output, 'Pages inactive')
  const speculative = readCounter(output, 'Pages speculative')
  const wired = readCounter(output, 'Pages wired down')
  const purgeable = readCounter(output, 'Pages purgeable')
  const anonymous = readCounter(output, 'Anonymous pages')
  const fileBacked = readCounter(output, 'File-backed pages')
  const compressor = readCounter(output, 'Pages occupied by compressor')
  if (
    free === null ||
    inactive === null ||
    speculative === null ||
    wired === null ||
    purgeable === null ||
    anonymous === null ||
    fileBacked === null ||
    compressor === null
  ) {
    return null
  }
  return {
    pageSize,
    free,
    inactive,
    speculative,
    wired,
    purgeable,
    anonymous,
    fileBacked,
    compressor,
  }
}

/** used = app + wired + compressed; available = total - used. */
export function computeDarwinMemory(pages: VmStatPages, totalBytes: number): DarwinMemory | null {
  if (totalBytes <= 0) return null
  const app = Math.max(0, pages.anonymous - pages.purgeable)
  const usedBytes = Math.min(totalBytes, (app + pages.wired + pages.compressor) * pages.pageSize)
  return {
    usedBytes,
    availableBytes: totalBytes - usedBytes,
    percent: Math.round((usedBytes / totalBytes) * 1000) / 10,
  }
}
