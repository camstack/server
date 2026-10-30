import { afterEach, describe, expect, it } from 'vitest'
import { probeKlfGateway } from '../klf-probe.js'
import { buildVeluxConnectionTestProvider } from '../velux-connection-test.js'
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

/** A probe that trusts the scripted gateway's certificate. */
function trustingProbe(certPem: string) {
  return (input: { host: string; password: string }) =>
    probeKlfGateway({
      ...input,
      tls: { ca: [certPem], checkServerIdentity: () => undefined },
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
