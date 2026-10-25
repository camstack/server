/**
 * A forked addon logs ABOUT a node (`tags: { nodeId: 'mac-mini' }`) from its
 * own process (`hub/pipeline-orchestrator`). The hub ingest used to stamp the
 * emitter's node id over the caller's tag, so every line about a target node
 * read as the emitter's — an in-process logger honours the caller's tag, a
 * forked one did not. The caller's `nodeId` wins; `agentId` stays the
 * emitter's slot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as yaml from 'js-yaml'
import type { ILogDestination, LogEntry } from '@camstack/types'
import { ConfigService } from '../../config/config.service'
import { LoggingService } from '../logging.service'

describe('LoggingService.writeFromWorker — tag precedence', () => {
  let tmpDir: string
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-log-worker-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function capture(): { service: LoggingService; lines: LogEntry[] } {
    const configPath = path.join(tmpDir, 'config.yaml')
    fs.writeFileSync(configPath, yaml.dump({ server: { port: 4443 } }), 'utf-8')
    const service = new LoggingService(new ConfigService(configPath))
    const lines: LogEntry[] = []
    const dest: ILogDestination = {
      initialize: async () => undefined,
      shutdown: async () => undefined,
      write: (e: LogEntry) => void lines.push(e),
    }
    service.addDestination(dest, { addonId: 'test-sink' })
    return { service, lines }
  }

  it("keeps the caller's nodeId tag and the emitter's agentId", () => {
    const { service, lines } = capture()
    service.writeFromWorker({
      addonId: 'pipeline-orchestrator',
      nodeId: 'hub/pipeline-orchestrator',
      level: 'info',
      message: 'auto benchmark: started',
      tags: { nodeId: 'mac-mini', deviceId: 7 },
    })
    const tags = lines.find((l) => l.message === 'auto benchmark: started')?.tags
    expect(tags?.nodeId).toBe('mac-mini')
    expect(tags?.agentId).toBe('hub')
    expect(tags?.addonId).toBe('pipeline-orchestrator')
    expect(tags?.deviceId).toBe(7)
  })

  it('stamps the emitting node when the caller set none', () => {
    const { service, lines } = capture()
    service.writeFromWorker({
      addonId: 'pipeline-orchestrator',
      nodeId: 'hub/pipeline-orchestrator',
      level: 'info',
      message: 'plain line',
    })
    expect(lines.find((l) => l.message === 'plain line')?.tags?.nodeId).toBe(
      'hub/pipeline-orchestrator',
    )
  })
})
