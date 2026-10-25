/**
 * Auth gate over the agent UI's update routes.
 *
 * `/api/agent/server-update/apply` installs a `@camstack/server` closure and
 * restarts the node — it is a code-execution primitive. It must sit behind the
 * SAME rule as the rest of `/api/` (loopback, or a session redeemed from a hub
 * unlock ticket, D857) and must NOT be part of the pairing surface: an UNPAIRED
 * agent has no CA to verify a ticket against, so a remote caller gets nothing.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { ServiceBroker } from 'moleculer'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentHttpConfig } from '../agent-http.js'
import { createAgentHttpServer } from '../agent-http.js'
import type { ServerPackageStatus } from '@camstack/types'
import { createAgentServerUpdateControls } from '../agent-update-routes.js'
import { unlockSession, writePairedConfig, type PairedFixture } from './helpers/paired-agent.js'

const REMOTE = '192.168.10.50'
const LOOPBACK = '127.0.0.1'

/** Every path the Updates card talks to. */
const UPDATE_ROUTES: ReadonlyArray<{ method: 'GET' | 'POST'; url: string }> = [
  { method: 'GET', url: '/api/agent/server-update' },
  { method: 'POST', url: '/api/agent/server-update/check' },
  { method: 'POST', url: '/api/agent/server-update/apply' },
  { method: 'GET', url: '/api/agent/addon-updates' },
]

function makeStubBroker(): ServiceBroker {
  return {
    nodeID: 'test-agent',
    call: async () => ({ nodeId: 'test-agent', addons: [], localIps: [] }),
    registry: { getNodeList: () => [] },
  } as unknown as ServiceBroker
}

function stubStatus(): ServerPackageStatus {
  return {
    packageName: '@camstack/server',
    runningVersion: '1.2.78',
    nodeRuntimeVersion: '24.0.0',
    activeVersion: '1.2.78',
    previousVersion: null,
    seedVersion: null,
    latestVersion: null,
    updateAvailable: false,
    bootMode: 'data-root',
    updateState: 'idle',
    pendingVersion: null,
    rolledBack: null,
    stateFileCorrupt: false,
    lastCheckedAtMs: null,
  }
}

const cleanups: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const c of cleanups) await c()
})

/** Records whether the engine was ever reached — a 401 must never reach it. */
interface ReachedFlag {
  applied: boolean
}

async function buildApp(options: {
  paired: boolean
}): Promise<{ app: FastifyInstance; reached: ReachedFlag; fixture: PairedFixture | null }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-http-update-auth-'))
  const configPath = path.join(tmpDir, 'agent.json')
  const fixture = options.paired ? await writePairedConfig(configPath, 'test-agent') : null
  const reached: ReachedFlag = { applied: false }
  const config: AgentHttpConfig = {
    port: 0,
    nodeId: 'test-agent',
    dataDir: tmpDir,
    configPath,
    updateControls: {
      server: createAgentServerUpdateControls({
        getServerPackageStatus: async () => stubStatus(),
        checkServerUpdate: async () => ({
          packageName: '@camstack/server',
          runningVersion: '1.2.78',
          latestVersion: '1.2.81',
          updateAvailable: true,
          checkedAtMs: 1,
          error: null,
        }),
        applyServerUpdate: async () => {
          reached.applied = true
          return {
            accepted: false,
            targetVersion: null,
            restarting: false,
            message: 'Refused: @camstack/server@1.2.78 is already running.',
          }
        },
      }),
      addons: {
        getReport: async () => ({
          entries: [],
          checkedAtMs: 0,
          error: null,
          hubReachable: false,
        }),
      },
    },
  }
  const app = await createAgentHttpServer(() => makeStubBroker(), config)
  cleanups.push(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  return { app, reached, fixture }
}

describe('agent update routes — auth gate', () => {
  it.each(UPDATE_ROUTES)('401s an unauthenticated REMOTE caller on $method $url', async (route) => {
    const { app, reached } = await buildApp({ paired: true })
    const res = await app.inject({ method: route.method, url: route.url, remoteAddress: REMOTE })
    expect(res.statusCode).toBe(401)
    expect(reached.applied).toBe(false)
  })

  it.each(
    UPDATE_ROUTES,
  )('is NOT part of the unpaired pairing surface — $method $url', async (route) => {
    // Unpaired: only the pairing protocol is reachable. Installing code never is.
    const { app, reached } = await buildApp({ paired: false })
    const res = await app.inject({ method: route.method, url: route.url, remoteAddress: REMOTE })
    expect(res.statusCode).toBe(401)
    expect(reached.applied).toBe(false)
  })

  it.each(UPDATE_ROUTES)('accepts a hub-unlocked session on $method $url', async (route) => {
    const { app, fixture } = await buildApp({ paired: true })
    if (fixture === null) throw new Error('paired fixture missing')
    const headers = await unlockSession(app, fixture.ca, 'test-agent')
    const res = await app.inject({
      method: route.method,
      url: route.url,
      remoteAddress: REMOTE,
      headers,
    })
    expect(res.statusCode).toBe(200)
  })

  it.each(
    UPDATE_ROUTES,
  )('accepts a loopback caller (Electron renderer) on $method $url', async (route) => {
    const { app } = await buildApp({ paired: true })
    const res = await app.inject({
      method: route.method,
      url: route.url,
      remoteAddress: LOOPBACK,
      headers: { 'content-type': 'application/json' },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
  })

  it('rejects a Bearer that is not a live session', async () => {
    const { app, reached } = await buildApp({ paired: true })
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/server-update/apply',
      remoteAddress: REMOTE,
      headers: { authorization: 'Bearer not-a-session' },
    })
    expect(res.statusCode).toBe(401)
    expect(reached.applied).toBe(false)
  })
})
