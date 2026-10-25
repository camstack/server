/**
 * D898: the hub's in-memory log buffer is a short TAIL once the rotated files
 * hold history — but every line emitted BEFORE the file destination
 * registered must still reach it through the boot replay, and every line
 * carries the same `id` in the tail, in the replay and live.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as yaml from 'js-yaml'
import type { ILogDestination, LogEntry } from '@camstack/types'
import { ConfigService } from '../../config/config.service'
import {
  HUB_LOG_TAIL_ENTRIES,
  HISTORY_DESTINATION_ADDON_ID,
  LoggingService,
} from '../logging.service'

function collector(): { dest: ILogDestination; lines: LogEntry[] } {
  const lines: LogEntry[] = []
  return {
    dest: {
      initialize: async () => undefined,
      shutdown: async () => undefined,
      write: (e: LogEntry) => void lines.push(e),
    },
    lines,
  }
}

describe('LoggingService — the in-memory tail (D898)', () => {
  let tmpDir: string
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-log-tail-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const createService = (): LoggingService => {
    const configPath = path.join(tmpDir, 'config.yaml')
    fs.writeFileSync(configPath, yaml.dump({ server: { port: 4443 } }), 'utf-8')
    return new LoggingService(new ConfigService(configPath))
  }

  it('replays every boot line to the history destination, then shrinks to the tail', () => {
    const service = createService()
    const boot = service.createLogger('boot')
    const BOOT_LINES = HUB_LOG_TAIL_ENTRIES * 3
    for (let i = 0; i < BOOT_LINES; i += 1) {
      boot.info(`boot ${String(i)}`, { tags: { addonId: `addon-${String(i % 7)}` } })
    }
    const files = collector()
    service.addDestination(files.dest, { addonId: HISTORY_DESTINATION_ADDON_ID })
    // Boot replay: nothing emitted before the file destination is lost.
    expect(files.lines).toHaveLength(BOOT_LINES)
    expect(new Set(files.lines.map((e) => e.message)).size).toBe(BOOT_LINES)

    for (let i = 0; i < 50; i += 1) boot.info(`after ${String(i)}`)
    expect(service.bufferSize()).toBeLessThanOrEqual(HUB_LOG_TAIL_ENTRIES)
    expect(files.lines).toHaveLength(BOOT_LINES + 50)
  })

  it('keeps the large buffer while no history destination is registered', () => {
    const service = createService()
    const log = service.createLogger('x')
    for (let i = 0; i < HUB_LOG_TAIL_ENTRIES * 3; i += 1) log.info(`l ${String(i)}`)
    expect(service.bufferSize()).toBeGreaterThan(HUB_LOG_TAIL_ENTRIES)
  })

  it('stamps one id per line, identical in the tail, the destination and live', () => {
    const service = createService()
    const files = collector()
    service.addDestination(files.dest, { addonId: HISTORY_DESTINATION_ADDON_ID, replay: false })
    const live: LogEntry[] = []
    const off = service.subscribe({}, (e) => live.push(e))
    const log = service.createLogger('x')
    log.info('a')
    log.info('b')
    off()
    const tailIds = service.query({}).map((e) => e.id)
    expect(files.lines.map((e) => e.id)).toEqual(live.map((e) => e.id))
    expect(new Set(tailIds)).toEqual(new Set(live.map((e) => e.id)))
    expect(new Set(live.map((e) => e.id)).size).toBe(2)
    expect(live[0]?.id).toMatch(/^[0-9a-z]+\.\d+$/)
  })
})
