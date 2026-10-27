import * as fs from 'node:fs/promises'
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { AlexaSpeakSettings } from '../config.js'
import { AlexaSpeakController, type SpeakBrokerRef } from '../speak/controller.js'
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

interface Harness {
  readonly controller: AlexaSpeakController
  readonly logins: LoginSeen[]
  readonly spawned: string[]
  readonly sessions: ReturnType<typeof memorySessions>
  readonly written: AlexaSpeakSettings[]
  readonly cleared: { count: number }
}

const REFRESH: Record<string, string> = {
  alexa_001: 'refresh-token-one',
  alexa_002: 'refresh-token-two',
}

function harness(options: {
  readonly brokers: readonly SpeakBrokerRef[]
  readonly speak?: Partial<AlexaSpeakSettings>
  readonly sessions?: Record<string, string>
  readonly seeds?: Record<string, string | null>
}): Harness {
  const sessions = memorySessions(options.sessions)
  const logins: LoginSeen[] = []
  const spawned: string[] = []
  const written: AlexaSpeakSettings[] = []
  const cleared = { count: 0 }
  const seeds = options.seeds ?? REFRESH
  const controller = new AlexaSpeakController({
    logger: logger(),
    readConfig: () => ({ speak: options.speak ?? {} }),
    writeSpeak: async (next) => {
      written.push(next)
    },
    listBrokers: () => options.brokers,
    readSeed: async (brokerId) => {
      const token = seeds[brokerId]
      return token === undefined || token === null
        ? null
        : { refreshToken: token, deviceAppName: `app-${brokerId}` }
    },
    sessions,
    clearLegacySecrets: async () => {
      cleared.count += 1
    },
    ensurePython: async () => '/py',
    startWorker: (brokerId): AlexaWorker => {
      spawned.push(brokerId)
      return {
        failed: false,
        crashesInWindow: 0,
        noteSecrets() {},
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
  return { controller, logins, spawned, sessions, written, cleared }
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
    const status = await h.controller.handlers().speakStatus({})
    expect(status.brokers.map((row) => [row.id, row.state, row.devices.map((d) => d.id)])).toEqual([
      ['alexa_001', 'ready', ['echo-of-alexa_001']],
      ['alexa_002', 'ready', ['echo-of-alexa_002']],
    ])
    h.controller.stop()
  })

  it('does not prompt for a login when the broker has none: it names the state', async () => {
    const h = harness({ brokers: ONE, seeds: { alexa_001: null } })
    await h.controller.start()
    expect(h.logins).toHaveLength(0)
    const status = await h.controller.handlers().speakStatus({})
    expect(status.brokers[0]?.state).toBe('broker-not-signed-in')
    h.controller.stop()
  })

  it('starts a session for an account added later and drops the one removed', async () => {
    let brokers: readonly SpeakBrokerRef[] = ONE
    const h = harness({ brokers: ONE })
    const controller = new AlexaSpeakController({
      logger: logger(),
      readConfig: () => ({ speak: {} }),
      writeSpeak: async () => {},
      listBrokers: () => brokers,
      readSeed: async (id) => ({ refreshToken: `t-${id}`, deviceAppName: 'a' }),
      sessions: h.sessions,
      clearLegacySecrets: async () => {},
      ensurePython: async () => '/py',
      startWorker: (id) => {
        h.spawned.push(`late-${id}`)
        return {
          failed: false,
          crashesInWindow: 0,
          noteSecrets() {},
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

const LEGACY: Partial<AlexaSpeakSettings> = {
  email: 'ada@example.com',
  password: 'old-password',
  session: Buffer.from('legacy-jar').toString('base64'),
  targets: [
    {
      id: 't-kitchen',
      name: 'Kitchen',
      enabled: false,
      brokerId: '',
      echoId: 'echo-k',
      mode: 'announce',
      volume: 63,
      respectDnd: false,
    },
  ],
}

describe('the old standalone login migrates onto the single broker', () => {
  it('with exactly one broker: the jar and every target move onto it, and the old secrets are gone', async () => {
    const h = harness({ brokers: ONE, speak: LEGACY, seeds: { alexa_001: null } })
    await h.controller.start()
    // the broker has no refresh token, so the attached jar is what signs in
    expect(h.logins[0]?.storedSession).toBe('legacy-jar')
    const saved = h.written[0]
    expect(saved?.email).toBe('')
    expect(saved?.password).toBe('')
    expect(saved?.session).toBe('')
    // every marked field of the target survived, and it now names the broker
    expect(saved?.targets[0]).toMatchObject({
      id: 't-kitchen',
      enabled: false,
      brokerId: 'alexa_001',
      mode: 'announce',
      volume: 63,
      respectDnd: false,
    })
    expect(h.cleared.count).toBe(1)
    const status = await h.controller.handlers().speakStatus({})
    expect(status.notice).toBe('')
    expect(status.unassignedTargets).toBe(0)
    h.controller.stop()
  })

  it('with several brokers: nothing is attached, the jar is dropped and the state is named', async () => {
    const h = harness({ brokers: TWO, speak: LEGACY })
    await h.controller.start()
    expect(h.sessions.rows.get('alexa_001')).not.toBe(Buffer.from('legacy-jar').toString('base64'))
    expect([...h.sessions.rows.values()]).not.toContain(
      Buffer.from('legacy-jar').toString('base64'),
    )
    expect(h.written[0]?.session).toBe('')
    expect(h.written[0]?.targets[0]?.brokerId).toBe('')
    expect(h.cleared.count).toBe(1)
    const status = await h.controller.handlers().speakStatus({})
    expect(status.notice).toBe('choose-broker')
    expect(status.unassignedTargets).toBe(1)
    h.controller.stop()
  })

  it('with no broker: the targets wait and the state asks for an account', async () => {
    const h = harness({ brokers: [], speak: LEGACY })
    await h.controller.start()
    expect(h.spawned).toHaveLength(0)
    const status = await h.controller.handlers().speakStatus({})
    expect(status.notice).toBe('no-broker')
    expect(status.unassignedTargets).toBe(1)
    h.controller.stop()
  })

  it('does nothing when there is no old login', async () => {
    const h = harness({ brokers: ONE })
    await h.controller.start()
    expect(h.written).toHaveLength(0)
    expect(h.cleared.count).toBe(0)
    h.controller.stop()
  })
})
