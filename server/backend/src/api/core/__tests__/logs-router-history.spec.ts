/**
 * D898 — `logs.query` routes the read to the source the client picked, maps
 * the LogStream scope onto the read contract, and an aborted request cancels
 * the slice in flight. `logs.sources` lists every hub-local destination with
 * what it can read.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as yaml from 'js-yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ILogDestination, LogReadQuery, LogReadResult } from '@camstack/types'
import { ConfigService } from '../../../core/config/config.service.js'
import { LoggingService } from '../../../core/logging/logging.service.js'
import type { AuthenticatedAgent, TrpcContext } from '../../trpc/trpc.context.js'
import { createLogsRouter, type LogDestinationRegistry } from '../logs.router.js'

const admin: AuthenticatedAgent = {
  id: 'u-admin',
  username: 'admin',
  isAdmin: true,
  permissions: { isAdmin: true, allowedProviders: '*', allowedDevices: {} },
  isApiKey: false,
  interactive: true,
  userDelegated: true,
  scopes: ['*'],
}

const EMPTY: LogReadResult = {
  entries: [],
  nextBefore: null,
  nextAfter: null,
  scannedBytes: 0,
  done: true,
}

interface Recorder {
  readonly dest: ILogDestination
  readonly reads: LogReadQuery[]
  readonly cancels: string[]
}

function reader(answer: (q: LogReadQuery) => Promise<LogReadResult>): Recorder {
  const reads: LogReadQuery[] = []
  const cancels: string[] = []
  return {
    reads,
    cancels,
    dest: {
      initialize: async () => undefined,
      shutdown: async () => undefined,
      write: () => undefined,
      describeRead: async () => ({
        readable: true,
        reason: null,
        retentionDays: 30,
        filters: {
          deviceId: true,
          addonId: true,
          nodeId: true,
          tags: true,
          level: true,
          text: true,
          timeRange: true,
        },
      }),
      read: async (q) => {
        reads.push(q)
        return answer(q)
      },
      cancelRead: async ({ requestId }) => {
        cancels.push(requestId)
        return { cancelled: true }
      },
    },
  }
}

const shipOnly: ILogDestination = {
  initialize: async () => undefined,
  shutdown: async () => undefined,
  write: () => undefined,
}

let tmp: string
let logging: LoggingService
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-logs-router-'))
  const configPath = path.join(tmp, 'config.yaml')
  fs.writeFileSync(configPath, yaml.dump({ server: { port: 4443 } }), 'utf-8')
  logging = new LoggingService(new ConfigService(configPath))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function caller(entries: ReadonlyArray<readonly [string, ILogDestination]>, signal?: AbortSignal) {
  const registry: LogDestinationRegistry = { getCollectionEntries: () => entries }
  const ctx: TrpcContext = { user: admin }
  return createLogsRouter(logging, registry).createCaller(
    ctx,
    signal !== undefined ? { signal } : {},
  )
}

describe('logs.query (D898)', () => {
  it('reads the default source with the scope mapped onto the read contract', async () => {
    const winston = reader(async () => EMPTY)
    await caller([['winston-logging', winston.dest]]).query({
      tags: { deviceId: '101', addonId: 'provider-x', agentId: 'agent-1', streamId: '101/main' },
      level: 'warn',
      text: '  timeout ',
      limit: 50,
    })
    expect(winston.reads[0]).toMatchObject({
      deviceId: 101,
      fromAddonId: 'provider-x',
      fromNodeId: 'agent-1',
      tags: { streamId: '101/main' },
      level: 'warn',
      text: 'timeout',
      limit: 50,
    })
    expect(winston.reads[0]?.requestId).toEqual(expect.any(String))
  })

  it('routes to the source the client names, and never to an agent copy', async () => {
    const winston = reader(async () => EMPTY)
    const loki = reader(async () => EMPTY)
    const agentCopy = reader(async () => EMPTY)
    const page = await caller([
      ['winston-logging', winston.dest],
      ['loki-logging', loki.dest],
      ['winston-logging@agent-1', agentCopy.dest],
    ]).query({ source: 'loki-logging' })
    expect(page.source).toBe('loki-logging')
    expect(loki.reads).toHaveLength(1)
    expect(winston.reads).toHaveLength(0)
    expect(agentCopy.reads).toHaveLength(0)
  })

  it('aborting the request cancels the slice the source is running', async () => {
    let release: (r: LogReadResult) => void = () => undefined
    const winston = reader(() => new Promise((resolve) => (release = resolve)))
    const controller = new AbortController()
    const pending = caller([['winston-logging', winston.dest]], controller.signal).query({
      text: 'x',
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(winston.cancels).toEqual([winston.reads[0]?.requestId])
    release({ ...EMPTY, done: false, cancelled: true })
    await pending.catch(() => undefined)
  })
})

describe('logs.sources (D898)', () => {
  it('lists every hub-local destination, ship-only ones as not readable', async () => {
    const winston = reader(async () => EMPTY)
    const sources = await caller([
      ['winston-logging', winston.dest],
      ['console-logging', shipOnly],
    ]).sources()
    expect(sources).toEqual([
      expect.objectContaining({ addonId: 'winston-logging', readable: true, isDefault: true }),
      expect.objectContaining({ addonId: 'console-logging', readable: false, isDefault: false }),
    ])
  })
})
