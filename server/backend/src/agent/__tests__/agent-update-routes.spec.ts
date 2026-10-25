/**
 * The agent UI's update surface.
 *
 * The load-bearing claims:
 *   - a REFUSAL from the update engine reaches the operator verbatim
 *     ("Refused: another operation is in flight (staging).") — the whole point
 *     of the card is that a button that did nothing can be explained,
 *   - a failed registry check is remembered and surfaced; a null
 *     `latestVersion` with no error would read as "up to date",
 *   - the apply route NEVER installs a caller-supplied version.
 */
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { ServerPackageStatus, ServerUpdateActionResult } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentServerUpdateResponse, ServerUpdateEngine } from '../agent-update-routes.js'
import {
  APPLY_ALREADY_RUNNING_MESSAGE,
  SERVER_UPDATE_UNAVAILABLE_REASON,
  createAgentServerUpdateControls,
  registerAgentUpdateRoutes,
} from '../agent-update-routes.js'

const REFUSAL = 'Refused: another operation is in flight (staging).'

function status(overrides: Partial<ServerPackageStatus> = {}): ServerPackageStatus {
  return {
    packageName: '@camstack/server',
    runningVersion: '1.2.78',
    nodeRuntimeVersion: '24.0.0',
    activeVersion: '1.2.78',
    previousVersion: null,
    seedVersion: '1.2.70',
    latestVersion: null,
    updateAvailable: false,
    bootMode: 'data-root',
    updateState: 'idle',
    pendingVersion: null,
    rolledBack: null,
    stateFileCorrupt: false,
    lastCheckedAtMs: null,
    ...overrides,
  }
}

function refusal(message: string): ServerUpdateActionResult {
  return { accepted: false, targetVersion: null, restarting: false, message }
}

/** A deferred so a test can hold `applyServerUpdate` open. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve: (v: T) => void = () => undefined
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const apps: FastifyInstance[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})

async function buildApp(engine?: ServerUpdateEngine): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  registerAgentUpdateRoutes(app, engine ? { server: createAgentServerUpdateControls(engine) } : {})
  await app.ready()
  apps.push(app)
  return app
}

describe('createAgentServerUpdateControls', () => {
  it('surfaces a REFUSAL verbatim on the next view', async () => {
    const controls = createAgentServerUpdateControls({
      getServerPackageStatus: async () => status(),
      checkServerUpdate: async () => {
        throw new Error('not called')
      },
      applyServerUpdate: async () => refusal(REFUSAL),
    })
    expect(controls.applyLatest()).toEqual({ started: true, message: null })
    await new Promise((r) => setImmediate(r))
    const view = await controls.getView()
    expect(view.applyInFlight).toBe(false)
    expect(view.lastApply?.accepted).toBe(false)
    expect(view.lastApply?.message).toBe(REFUSAL)
  })

  it('remembers a failed registry check so the UI can say WHY', async () => {
    const controls = createAgentServerUpdateControls({
      getServerPackageStatus: async () => status(),
      checkServerUpdate: async () => ({
        packageName: '@camstack/server',
        runningVersion: '1.2.78',
        latestVersion: null,
        updateAvailable: false,
        checkedAtMs: 1,
        error: 'getaddrinfo ENOTFOUND registry.npmjs.org',
      }),
      applyServerUpdate: async () => refusal('unused'),
    })
    expect((await controls.getView()).lastCheckError).toBeNull()
    await controls.check()
    const view = await controls.getView()
    expect(view.lastCheckError).toBe('getaddrinfo ENOTFOUND registry.npmjs.org')
    // The status alone would say `latestVersion: null, updateAvailable: false`
    // — indistinguishable from a healthy "already current".
    expect(view.status.latestVersion).toBeNull()
  })

  it('refuses a SECOND apply while one is in flight, and says so', async () => {
    const gate = deferred<ServerUpdateActionResult>()
    const controls = createAgentServerUpdateControls({
      getServerPackageStatus: async () => status({ updateState: 'staging' }),
      checkServerUpdate: async () => {
        throw new Error('not called')
      },
      applyServerUpdate: () => gate.promise,
    })
    expect(controls.applyLatest().started).toBe(true)
    expect((await controls.getView()).applyInFlight).toBe(true)
    expect(controls.applyLatest()).toEqual({
      started: false,
      message: APPLY_ALREADY_RUNNING_MESSAGE,
    })
    gate.resolve({
      accepted: true,
      targetVersion: '1.2.81',
      restarting: true,
      message: 'Staged @camstack/server@1.2.81 — restarting to apply.',
    })
    await new Promise((r) => setImmediate(r))
    expect((await controls.getView()).applyInFlight).toBe(false)
  })

  it('turns a THROWN staging failure into a rendered message', async () => {
    const controls = createAgentServerUpdateControls({
      getServerPackageStatus: async () => status(),
      checkServerUpdate: async () => {
        throw new Error('not called')
      },
      applyServerUpdate: async () => {
        throw new Error('npm install exited 1')
      },
    })
    controls.applyLatest()
    await new Promise((r) => setImmediate(r))
    const view = await controls.getView()
    expect(view.lastApply?.message).toBe('Update failed: npm install exited 1')
    expect(view.lastApply?.accepted).toBe(false)
  })

  it('reports a refusal to the injected error sink', async () => {
    const seen: string[] = []
    const controls = createAgentServerUpdateControls(
      {
        getServerPackageStatus: async () => status(),
        checkServerUpdate: async () => {
          throw new Error('not called')
        },
        applyServerUpdate: async () => refusal(REFUSAL),
      },
      (message) => seen.push(message),
    )
    controls.applyLatest()
    await new Promise((r) => setImmediate(r))
    // A branch that drops the work silently reads as "never happened".
    expect(seen).toEqual([REFUSAL])
  })
})

describe('registerAgentUpdateRoutes', () => {
  it('never installs a caller-supplied version — apply always means "latest"', async () => {
    const inputs: Array<{ version?: string }> = []
    const app = await buildApp({
      getServerPackageStatus: async () => status(),
      checkServerUpdate: async () => {
        throw new Error('not called')
      },
      applyServerUpdate: async (input) => {
        inputs.push(input)
        return refusal('unused')
      },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/server-update/apply',
      // A caller trying to pin an arbitrary version — the RCE shape.
      payload: { version: '0.0.1-attacker' },
    })
    expect(res.statusCode).toBe(200)
    await new Promise((r) => setImmediate(r))
    expect(inputs).toEqual([{}])
  })

  it('answers with a REASON when no update engine is wired, not a dead 404', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/agent/server-update' })
    expect(res.statusCode).toBe(200)
    const body = res.json<AgentServerUpdateResponse>()
    expect(body).toEqual({ available: false, reason: SERVER_UPDATE_UNAVAILABLE_REASON })
  })

  it('exposes the status + last check error in one poll', async () => {
    const app = await buildApp({
      getServerPackageStatus: async () =>
        status({ latestVersion: '1.2.81', updateAvailable: true, updateState: 'idle' }),
      checkServerUpdate: async () => ({
        packageName: '@camstack/server',
        runningVersion: '1.2.78',
        latestVersion: '1.2.81',
        updateAvailable: true,
        checkedAtMs: 5,
        error: null,
      }),
      applyServerUpdate: async () => refusal('unused'),
    })
    await app.inject({ method: 'POST', url: '/api/agent/server-update/check' })
    const body = (
      await app.inject({ method: 'GET', url: '/api/agent/server-update' })
    ).json<AgentServerUpdateResponse>()
    expect(body.available).toBe(true)
    if (!body.available) throw new Error('unreachable')
    expect(body.status.updateAvailable).toBe(true)
    expect(body.status.latestVersion).toBe('1.2.81')
    expect(body.lastCheckError).toBeNull()
  })
})
