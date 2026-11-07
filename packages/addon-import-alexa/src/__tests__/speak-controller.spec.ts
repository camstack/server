import * as fs from 'node:fs/promises'
import { type IScopedLogger, makeInMemoryRecords, type Target } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  AlexaSpeakController,
  type AlexaSpeakHost,
  type SpeakBrokerRef,
} from '../speak/controller.js'
import { alexaNotifyRecordKinds, echoTargetStoreOver } from '../speak/echo-store.js'
import type { SpeakSessionStore } from '../speak/session-store.js'
import type { AlexaWorker } from '../speak/worker-client.js'
import type { WorkerRequest } from '../speak/worker-protocol.js'

function logger(): IScopedLogger {
  const value: IScopedLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return value
    },
    withTags() {
      return value
    },
  }
  return value
}

function memorySessions(initial: Record<string, string> = {}): SpeakSessionStore & {
  readonly rows: Map<string, string>
} {
  const rows = new Map(Object.entries(initial))
  return {
    rows,
    async get(id) {
      return rows.get(id) ?? ''
    },
    async put(id, value) {
      rows.set(id, value)
    },
    async delete(id) {
      rows.delete(id)
    },
  }
}

interface LoginSeen {
  readonly brokerId: string
  readonly label: string
  readonly refreshToken: string
  readonly storedSession: string
  readonly deviceAppName: string
}

type AlexaTargetPorts = Pick<AlexaSpeakHost, 'readTargets'>

function mapTargets(initial: readonly Target[]): AlexaTargetPorts {
  const rows = new Map(initial.map((target) => [target.id, target]))
  return {
    readTargets: async () => [...rows.values()],
  }
}

/** The ports over the real records, the way the addon wires them. */
async function recordTargets(): Promise<{
  readonly ports: AlexaTargetPorts
  readonly store: ReturnType<typeof echoTargetStoreOver>
}> {
  const memory = makeInMemoryRecords('import-alexa')
  await memory.records.declare(alexaNotifyRecordKinds)
  const store = echoTargetStoreOver(memory.records)
  return {
    store,
    ports: { readTargets: () => store.list() },
  }
}

function echoTarget(id: string, enabled: boolean): Target {
  return {
    id,
    name: id,
    kind: 'alexa-echo',
    addonId: 'import-alexa',
    enabled,
    config: { brokerId: 'alexa_001', echoId: 'echo-of-alexa_001', respectDnd: false },
  }
}

interface Harness {
  readonly controller: AlexaSpeakController
  readonly logins: LoginSeen[]
  readonly spawned: string[]
  readonly spoken: string[]
  readonly sessions: ReturnType<typeof memorySessions>
}

const REFRESH: Record<string, string> = {
  alexa_001: 'refresh-token-one',
  alexa_002: 'refresh-token-two',
}

function harness(options: {
  readonly brokers: readonly SpeakBrokerRef[]
  readonly targets?: AlexaTargetPorts
  readonly sessions?: Record<string, string>
  readonly seeds?: Record<string, string | null>
}): Harness {
  const sessions = memorySessions(options.sessions)
  const logins: LoginSeen[] = []
  const spawned: string[] = []
  const spoken: string[] = []
  const targets = options.targets ?? mapTargets([])
  const seeds = options.seeds ?? REFRESH
  const controller = new AlexaSpeakController({
    logger: logger(),
    ...targets,
    listBrokers: () => options.brokers,
    readSeed: async (brokerId) => {
      const token = seeds[brokerId]
      return token === undefined || token === null
        ? null
        : { refreshToken: token, deviceAppName: `app-${brokerId}` }
    },
    sessions,
    ensurePython: async () => '/py',
    startWorker: (brokerId): AlexaWorker => {
      spawned.push(brokerId)
      return {
        failed: false,
        crashesInWindow: 0,
        noteSecrets() {},
        onPush() {},
        stop() {},
        async request(request: WorkerRequest) {
          if (request.op === 'login_broker') {
            const refreshToken =
              request.refreshTokenPath === ''
                ? ''
                : (await fs.readFile(request.refreshTokenPath, 'utf8')).trim()
            const storedSession = (await fs.readFile(request.sessionPath)).toString('utf8')
            logins.push({
              brokerId,
              label: request.label,
              refreshToken,
              storedSession,
              deviceAppName: request.deviceAppName,
            })
            await fs.writeFile(request.sessionPath, `jar-written-for-${brokerId}`)
            return { status: 'ok' }
          }
          if (request.op === 'speak' || request.op === 'announce') {
            spoken.push(request.targets.join(','))
            return { outcomes: request.targets.map((targetId) => ({ targetId, ok: true })) }
          }
          if (request.op === 'devices') {
            return {
              devices: [
                {
                  id: `echo-of-${brokerId}`,
                  name: `Echo ${brokerId}`,
                  family: 'ECHO',
                  online: true,
                  kind: 'device',
                  dnd: false,
                  deviceType: 'T',
                },
              ],
            }
          }
          return { loggedIn: true, ageSec: 1, lastSuccessAt: 1 }
        },
      }
    },
  })
  return { controller, logins, spawned, spoken, sessions }
}

const ONE: readonly SpeakBrokerRef[] = [
  { id: 'alexa_001', name: 'Home', amazonDomain: 'amazon.it' },
]
const TWO: readonly SpeakBrokerRef[] = [
  ...ONE,
  { id: 'alexa_002', name: 'Office', amazonDomain: 'amazon.com' },
]

describe('speak is bound to a broker', () => {
  it('runs one worker and one session per broker, each signed in with its own refresh token', async () => {
    const h = harness({ brokers: TWO })
    await h.controller.start()
    expect(h.spawned.sort()).toEqual(['alexa_001', 'alexa_002'])
    expect(
      h.logins.map((row) => [row.brokerId, row.refreshToken, row.deviceAppName]).sort(),
    ).toEqual([
      ['alexa_001', 'refresh-token-one', 'app-alexa_001'],
      ['alexa_002', 'refresh-token-two', 'app-alexa_002'],
    ])
    // each account keeps its own jar, written back under its own broker id
    expect(h.sessions.rows.get('alexa_001')).toBe(
      Buffer.from('jar-written-for-alexa_001').toString('base64'),
    )
    expect(h.sessions.rows.get('alexa_002')).toBe(
      Buffer.from('jar-written-for-alexa_002').toString('base64'),
    )
    const proposed = await h.controller.provider.discoverTargets({ kind: 'alexa-echo' })
    const echoOptions = proposed.map((row) => row.config['echoId'])
    expect(echoOptions.sort()).toEqual(['echo-of-alexa_001', 'echo-of-alexa_002'])
    h.controller.stop()
  })

  it('does not prompt for a login when the broker has none: it names the state', async () => {
    const h = harness({ brokers: ONE, seeds: { alexa_001: null } })
    await h.controller.start()
    expect(h.logins).toHaveLength(0)
    expect(await h.controller.provider.discoverTargets({ kind: 'alexa-echo' })).toEqual([])
    h.controller.stop()
  })

  it('starts a session for an account added later and drops the one removed', async () => {
    let brokers: readonly SpeakBrokerRef[] = ONE
    const h = harness({ brokers: ONE })
    const controller = new AlexaSpeakController({
      logger: logger(),
      ...mapTargets([]),
      listBrokers: () => brokers,
      readSeed: async (id) => ({ refreshToken: `t-${id}`, deviceAppName: 'a' }),
      sessions: h.sessions,
      ensurePython: async () => '/py',
      startWorker: (id) => {
        h.spawned.push(`late-${id}`)
        return {
          failed: false,
          crashesInWindow: 0,
          noteSecrets() {},
          onPush() {},
          stop() {},
          async request(request) {
            if (request.op === 'login_broker') {
              await fs.writeFile(request.sessionPath, `jar-${id}`)
              return { status: 'ok' }
            }
            return { devices: [] }
          },
        }
      },
    })
    await controller.start()
    brokers = TWO
    await controller.brokersChanged()
    expect(h.spawned).toEqual(['late-alexa_001', 'late-alexa_002'])
    brokers = [TWO[1] as SpeakBrokerRef]
    await controller.brokersChanged()
    expect(h.sessions.rows.has('alexa_001')).toBe(false)
    expect(h.sessions.rows.has('alexa_002')).toBe(true)
    controller.stop()
  })
})

describe('stored Echo targets', () => {
  it('are spoken on only while their switch is on', async () => {
    const h = harness({ brokers: ONE, targets: mapTargets([echoTarget('t-kitchen', false)]) })
    const sent = await h.controller.provider.send({
      targetId: 't-kitchen',
      notification: { body: 'hello', title: 'CamStack', format: 'text', priority: 3 },
    })
    expect(sent).toMatchObject({ success: false, error: 'target disabled' })
  })
})

describe('the records are the one source of the Echo targets', () => {
  const NOTIFICATION = { body: 'hello', title: 'CamStack', format: 'text', priority: 3 } as const

  it('sends to a target an instance created after start, without a restart', async () => {
    const { ports, store } = await recordTargets()
    const h = harness({ brokers: ONE, targets: ports })
    await h.controller.start()
    expect(
      await h.controller.provider.send({ targetId: 't-new', notification: NOTIFICATION }),
    ).toMatchObject({ success: false, error: 'target not found: t-new' })
    await store.upsert(echoTarget('t-new', true))
    const sent = await h.controller.provider.send({
      targetId: 't-new',
      notification: NOTIFICATION,
    })
    expect(sent.success).toBe(true)
    expect(h.spoken).toEqual(['echo-of-alexa_001'])
    h.controller.stop()
  })

  it('does not speak on a target an instance switched off', async () => {
    const { ports, store } = await recordTargets()
    await store.upsert(echoTarget('t-off', true))
    const h = harness({ brokers: ONE, targets: ports })
    await h.controller.start()
    await store.setEnabled('t-off', false)
    const sent = await h.controller.provider.send({
      targetId: 't-off',
      notification: NOTIFICATION,
    })
    expect(sent).toMatchObject({ success: false, error: 'target disabled' })
    expect(h.spoken).toEqual([])
    h.controller.stop()
  })
})
