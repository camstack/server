import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_KLF_PROBE_TIMEOUTS_MS,
  KlfProbeTimeoutError,
  klfProbeWorstCaseMs,
  probeKlfGateway,
  type KlfProbeTimeoutsMs,
} from '../klf-probe.js'
import {
  DEFAULT_TEST_DEADLINE_MS,
  buildVeluxConnectionTestProvider,
} from '../velux-connection-test.js'
import { FakeKlfGateway, type FakeNode } from './fake-klf-gateway.js'
import { RecordingLogger } from './recording-logger.js'

const PASSWORD = 'correct-horse'
const SHUTTER: FakeNode = {
  nodeId: 0,
  name: 'Tapparella',
  actuatorType: 2,
  actuatorSubType: 0,
  serialHex: '1a1b1c1d1e1f2021',
  positionRaw: 0,
}

let gateway: FakeKlfGateway | null = null

afterEach(async () => {
  await gateway?.stop()
  gateway = null
})

async function startGateway(): Promise<{ certPem: string }> {
  gateway = new FakeKlfGateway(PASSWORD, [SHUTTER])
  return gateway.start()
}

/** Trusts the scripted certificate and sends an SNI name, so the fake can slow the handshake. */
const TRUST = (certPem: string) => ({
  ca: [certPem],
  servername: 'klf200.test',
  checkServerIdentity: () => undefined,
})

/** Probes with the given per-step bounds against the scripted gateway; resolves to the failure or null. */
async function probeFailure(
  certPem: string,
  timeoutsMs: Partial<KlfProbeTimeoutsMs>,
): Promise<unknown> {
  return probeKlfGateway({
    host: '127.0.0.1',
    password: PASSWORD,
    tls: TRUST(certPem),
    timeoutsMs,
  }).then(
    () => null,
    (err: unknown) => err,
  )
}

/** A probe that trusts the scripted gateway's certificate. */
function trustingProbe(certPem: string) {
  return (input: { host: string; password: string }) =>
    probeKlfGateway({
      ...input,
      tls: TRUST(certPem),
    })
}

describe('Velux connection test', () => {
  it('validates a reachable gateway that accepts the password, and closes its session', async () => {
    const { certPem } = await startGateway()
    const provider = buildVeluxConnectionTestProvider({
      logger: new RecordingLogger(),
      probe: trustingProbe(certPem),
    })
    const result = await provider.testSettings({
      settings: { host: '127.0.0.1', password: PASSWORD },
    })
    expect(result.outcome).toBe('validated')
    if (result.outcome === 'validated') expect(result.detail).toContain('0.2.0.0.71.0')
    // The gateway allows two sessions: the test must not keep one.
    const end = Date.now() + 2000
    while ((gateway?.openConnections ?? 0) > 0 && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(gateway?.openConnections).toBe(0)
  })

  it('answers from the live session and opens no second one', async () => {
    let probed = 0
    const provider = buildVeluxConnectionTestProvider({
      logger: new RecordingLogger(),
      liveSession: (host) =>
        host === '10.0.0.5' ? { password: PASSWORD, firmware: '0.2.0.0.71.0' } : null,
      probe: async () => {
        probed += 1
        return { firmware: null }
      },
    })
    const ok = await provider.testSettings({ settings: { host: '10.0.0.5', password: PASSWORD } })
    expect(ok.outcome).toBe('validated')
    if (ok.outcome === 'validated') expect(ok.detail).toContain('0.2.0.0.71.0')
    const wrong = await provider.testSettings({ settings: { host: '10.0.0.5', password: 'nope' } })
    expect(wrong.outcome).toBe('rejected')
    expect(probed).toBe(0)
  })

  it('treats the saved password marker as the saved password, never as text', async () => {
    let probed = 0
    const marker = { $secret: 'secret://velux/int-1/password' }
    const live = buildVeluxConnectionTestProvider({
      logger: new RecordingLogger(),
      liveSession: () => ({ password: PASSWORD, firmware: null }),
      probe: async () => {
        probed += 1
        return { firmware: null }
      },
    })
    const ok = await live.testSettings({ settings: { host: '10.0.0.5', password: marker } })
    expect(ok.outcome).toBe('validated')
    const down = buildVeluxConnectionTestProvider({
      logger: new RecordingLogger(),
      probe: async () => {
        probed += 1
        return { firmware: null }
      },
    })
    const notTested = await down.testSettings({ settings: { host: '10.0.0.5', password: marker } })
    expect(notTested.outcome).toBe('inconclusive')
    expect(probed).toBe(0)
  })

  it('rejects a wrong password, and only that', async () => {
    const { certPem } = await startGateway()
    const provider = buildVeluxConnectionTestProvider({
      logger: new RecordingLogger(),
      probe: trustingProbe(certPem),
    })
    const result = await provider.testSettings({
      settings: { host: '127.0.0.1', password: 'not-the-password' },
    })
    expect(result.outcome).toBe('rejected')
    if (result.outcome === 'rejected') {
      expect(result.error).toMatch(/password/i)
      expect(result.error).not.toContain('not-the-password')
    }
  })

  it('is inconclusive, not rejected, when nothing answers on the gateway port', async () => {
    const provider = buildVeluxConnectionTestProvider({ logger: new RecordingLogger() })
    const result = await provider.testSettings({
      settings: { host: '127.0.0.1', password: PASSWORD },
    })
    expect(result.outcome).toBe('inconclusive')
    if (result.outcome === 'inconclusive') expect(result.error).toMatch(/reach/i)
  })

  it('is inconclusive when the certificate is not the gateway one', async () => {
    await startGateway()
    // No trust seam: the scripted gateway's self-signed certificate is not Velux's.
    const provider = buildVeluxConnectionTestProvider({ logger: new RecordingLogger() })
    const result = await provider.testSettings({
      settings: { host: '127.0.0.1', password: PASSWORD },
    })
    expect(result.outcome).toBe('inconclusive')
    if (result.outcome === 'inconclusive') expect(result.error).toMatch(/secure connection/i)
  })

  it('names the password step when the gateway holds the session but never answers the password', async () => {
    const { certPem } = await startGateway()
    gateway?.mute()
    const started = Date.now()
    const failure = await probeFailure(certPem, { password: 300, logout: 300 })
    expect(failure).toBeInstanceOf(KlfProbeTimeoutError)
    if (failure instanceof KlfProbeTimeoutError) {
      expect(failure.phase).toBe('password')
      expect(failure.message).toMatch(/password/i)
    }
    expect(Date.now() - started).toBeLessThan(3000)
    // The wedged session is not left open: the gateway allows only two.
    const end = Date.now() + 2000
    while ((gateway?.openConnections ?? 0) > 0 && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(gateway?.openConnections).toBe(0)
  })

  it('names the password step for a slow password answer, not the handshake', async () => {
    const { certPem } = await startGateway()
    gateway?.slowPassword(900)
    const failure = await probeFailure(certPem, { tls: 2000, password: 300, logout: 300 })
    expect(failure).toBeInstanceOf(KlfProbeTimeoutError)
    if (failure instanceof KlfProbeTimeoutError) expect(failure.phase).toBe('password')
  })

  it('names the TLS step when the handshake outlasts its bound', async () => {
    const { certPem } = await startGateway()
    gateway?.slowHandshake(1500)
    const failure = await probeFailure(certPem, { tls: 400, password: 3000, logout: 300 })
    expect(failure).toBeInstanceOf(KlfProbeTimeoutError)
    if (failure instanceof KlfProbeTimeoutError) {
      expect(failure.phase).toBe('tls')
      expect(failure.message).toMatch(/TLS handshake/)
    }
  })

  it('accepts a handshake slower than the password bound, as long as it fits the TLS bound', async () => {
    const { certPem } = await startGateway()
    gateway?.slowHandshake(700)
    const failure = await probeFailure(certPem, { tls: 3000, password: 300, logout: 300 })
    expect(failure).toBeNull()
  })

  it('opens exactly one connection to the gateway', async () => {
    const { certPem } = await startGateway()
    expect(await probeFailure(certPem, {})).toBeNull()
    expect(gateway?.tcpConnections).toBe(1)
  })

  it('is validated by a gateway that stalls a connection arriving soon after a close', async () => {
    const { certPem } = await startGateway()
    gateway?.stallAfterClose(1500)
    expect(await probeFailure(certPem, { tls: 600 })).toBeNull()
  })

  it('keeps the connect error code, so a refused connection reads as unreachable', async () => {
    const failure = await probeKlfGateway({ host: '127.0.0.1', password: PASSWORD }).catch(
      (e: unknown) => e,
    )
    expect(Reflect.get(Object(failure), 'code')).toBe('ECONNREFUSED')
  })

  it('defaults: the slow real-gateway handshake (4.2 s measured) fits with margin, and the worst case fits the deadline', () => {
    expect(DEFAULT_KLF_PROBE_TIMEOUTS_MS.tls).toBeGreaterThanOrEqual(2 * 4_249)
    expect(Object.keys(DEFAULT_KLF_PROBE_TIMEOUTS_MS)).not.toContain('tcp')
    expect(klfProbeWorstCaseMs(DEFAULT_KLF_PROBE_TIMEOUTS_MS)).toBeLessThanOrEqual(
      DEFAULT_TEST_DEADLINE_MS,
    )
  })

  it('answers inconclusive with the reason when a probe never finishes, and frees the queue', async () => {
    const logger = new RecordingLogger()
    let calls = 0
    const provider = buildVeluxConnectionTestProvider({
      logger,
      deadlineMs: 80,
      probe: () => {
        calls += 1
        return new Promise(() => undefined)
      },
    })
    const first = await provider.testSettings({
      settings: { host: '10.0.0.7', password: PASSWORD },
    })
    expect(first.outcome).toBe('inconclusive')
    if (first.outcome === 'inconclusive') expect(first.error).toMatch(/did not answer within/i)
    expect(
      logger.lines.some((l) => l.level === 'warn' && /timed out/i.test(JSON.stringify(l.extras))),
    ).toBe(true)
    // The next test for the same host runs; it is not stuck behind the hung one.
    await provider.testSettings({ settings: { host: '10.0.0.7', password: PASSWORD } })
    expect(calls).toBe(2)
  })

  it('asks for a host and a password before touching the network', async () => {
    let probed = 0
    const provider = buildVeluxConnectionTestProvider({
      logger: new RecordingLogger(),
      probe: async () => {
        probed += 1
        return { firmware: null }
      },
    })
    const noHost = await provider.testSettings({ settings: { host: ' ', password: PASSWORD } })
    const noPassword = await provider.testSettings({ settings: { host: '10.0.0.5', password: '' } })
    expect(noHost.outcome).toBe('rejected')
    expect(noPassword.outcome).toBe('rejected')
    expect(probed).toBe(0)
  })

  it('does not open a third session when two are already live on that host', async () => {
    let probed = 0
    const provider = buildVeluxConnectionTestProvider({
      logger: new RecordingLogger(),
      liveSessions: (host) => (host === '10.0.0.5' ? 2 : 0),
      probe: async () => {
        probed += 1
        return { firmware: null }
      },
    })
    const blocked = await provider.testSettings({
      settings: { host: '10.0.0.5', password: PASSWORD },
    })
    expect(blocked.outcome).toBe('inconclusive')
    expect(probed).toBe(0)
    const other = await provider.testSettings({
      settings: { host: '10.0.0.6', password: PASSWORD },
    })
    expect(other.outcome).toBe('validated')
    expect(probed).toBe(1)
  })

  it('runs one test at a time per host', async () => {
    let running = 0
    let peak = 0
    const provider = buildVeluxConnectionTestProvider({
      logger: new RecordingLogger(),
      probe: async () => {
        running += 1
        peak = Math.max(peak, running)
        await new Promise((r) => setTimeout(r, 30))
        running -= 1
        return { firmware: null }
      },
    })
    const settings = { host: '10.0.0.5', password: PASSWORD }
    await Promise.all([
      provider.testSettings({ settings }),
      provider.testSettings({ settings }),
      provider.testSettings({ settings }),
    ])
    expect(peak).toBe(1)
  })
})
