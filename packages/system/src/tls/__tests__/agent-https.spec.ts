import { X509Certificate } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acceptAgentSans,
  AgentHttpsInstallError,
  agentHttpsPaths,
  certificateNames,
  collectAgentNames,
  createAgentHttpsRequest,
  describeHttpsLeaf,
  installAgentHttps,
  isContainerBridgeAddress,
  isLocalOnlyHostname,
  isPrivateAddress,
  issueAgentHttpsLeaf,
  loadAgentHttps,
  pinnedHttpsCaFingerprint,
} from '../agent-https.js'
import { ensureTlsCert } from '../cert-manager.js'

let hubDir: string
let agentDir: string

beforeEach(() => {
  hubDir = mkdtempSync(join(tmpdir(), 'hub-tls-'))
  agentDir = mkdtempSync(join(tmpdir(), 'agent-tls-'))
})
afterEach(() => {
  rmSync(hubDir, { recursive: true, force: true })
  rmSync(agentDir, { recursive: true, force: true })
})

const facts = {
  hostname: 'agent-a',
  networkInterfaces: {
    eth0: [{ address: '192.168.1.20', internal: false }],
  },
}

describe('what the hub will certify for an agent', () => {
  it('SECURITY: only the node id and the address of the LIVE mesh socket - nothing the agent reports', () => {
    const sans = acceptAgentSans({
      nodeId: 'agent-1',
      observedAddress: '::ffff:192.168.1.20',
      reported: ['bank.example.com', '10.9.9.9', 'agent-1.local'],
    })
    expect(sans.identity.dnsNames).toEqual(['agent-1'])
    expect(sans.identity.ipAddresses).toEqual(['192.168.1.20'])
    expect(sans.rejected.join(' ')).toContain('bank.example.com (self-reported, not certified)')
    expect(sans.rejected.join(' ')).toContain('10.9.9.9 (self-reported, not certified)')
  })

  it('SECURITY: a name the hub holds, or another node already has, is never signed; a public observed address is not', () => {
    const taken = new Set(['192.0.2.10', 'agent-1', '192.0.2.20'])
    const a = acceptAgentSans({
      nodeId: 'agent-1',
      observedAddress: '192.0.2.10',
      excluded: taken,
    })
    expect(a.accepted).toEqual([])
    const behindNat = acceptAgentSans({
      nodeId: 'agent-2',
      observedAddress: '192.0.2.20',
      excluded: taken,
    })
    expect(behindNat.accepted).toEqual(['agent-2'])
    const publicIp = acceptAgentSans({ nodeId: 'agent-3', observedAddress: '8.8.8.8' })
    expect(publicIp.identity.ipAddresses).toEqual([])
    const impersonatesHub = acceptAgentSans({ nodeId: 'hub', observedAddress: '192.168.1.60' })
    expect(impersonatesHub.identity.dnsNames).toEqual([])
    expect(isPrivateAddress('100.64.0.9')).toBe(true)
    expect(isPrivateAddress('1.1.1.1')).toBe(false)
    expect(isLocalOnlyHostname('printer')).toBe(true)
    expect(isLocalOnlyHostname('x.example.org')).toBe(false)
  })
})

describe('agent HTTPS issuance (the hub signs a public key; no private key crosses)', () => {
  it('issues a serverAuth leaf under the hub local CA for the node id + observed address only, and the agent installs it', async () => {
    await ensureTlsCert(hubDir)
    const request = await createAgentHttpsRequest(
      agentDir,
      'agent-1',
      collectAgentNames('agent-1', facts),
    )
    expect(request.csrPem).toContain('BEGIN CERTIFICATE REQUEST')
    expect(request.csrPem).not.toContain('PRIVATE KEY')

    const issued = await issueAgentHttpsLeaf({
      hubDataDir: hubDir,
      nodeId: 'agent-1',
      csrPem: request.csrPem,
      reportedNames: [...request.hostnames, ...request.addresses],
      observedAddress: '192.168.1.20',
    })
    const leaf = new X509Certificate(issued.certPem)
    const hubCa = new X509Certificate(readFileSync(join(hubDir, 'tls', 'camstack-ca.crt')))
    expect(leaf.verify(hubCa.publicKey)).toBe(true)
    // The single-label node id is outside the CA's name constraints (D873): only the
    // address is certified, and the refusal is reported.
    expect([...certificateNames(issued.certPem)].toSorted()).toEqual(['192.168.1.20'])
    expect(issued.rejected.join(' ')).toMatch(/agent-1 \(outside the local CA's name constraints\)/)
    // What the agent reported about itself was NOT signed.
    expect(leaf.subjectAltName).not.toContain('agent-a')
    expect(leaf.ca).toBe(false)

    expect(loadAgentHttps(agentDir)).toBeNull()
    const material = installAgentHttps(agentDir, issued)
    expect(material.certPem).toBe(issued.certPem)
    const paths = agentHttpsPaths(agentDir)
    // ONE atomic bundle (key + leaf + pinned CA), owner-only.
    expect(existsSync(paths.bundlePath)).toBe(true)
    if (process.platform !== 'win32') expect(statSync(paths.bundlePath).mode & 0o777).toBe(0o600)
    expect(existsSync(`${paths.bundlePath}.tmp`)).toBe(false)
    expect(loadAgentHttps(agentDir)?.certPem).toBe(issued.certPem)
    expect(describeHttpsLeaf(issued.certPem).sans.join(',')).toContain('192.168.1.20')
  })

  it("never signs the hub's own names, or a name another node holds", async () => {
    await ensureTlsCert(hubDir)
    const hubNames = certificateNames(readFileSync(join(hubDir, 'tls', 'camstack.crt'), 'utf8'))
    const request = await createAgentHttpsRequest(
      agentDir,
      'agent-1.local',
      collectAgentNames('agent-1.local', facts),
    )
    const hubIp = [...hubNames].find((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n))
    if (hubIp !== undefined) {
      const issued = await issueAgentHttpsLeaf({
        hubDataDir: hubDir,
        nodeId: 'agent-1.local',
        csrPem: request.csrPem,
        observedAddress: hubIp,
      })
      expect(issued.accepted).toEqual(['agent-1.local'])
    }
    await expect(
      issueAgentHttpsLeaf({
        hubDataDir: hubDir,
        nodeId: 'agent-1.local',
        csrPem: request.csrPem,
        observedAddress: '192.168.1.20',
        takenByOthers: new Set(['agent-1.local', '192.168.1.20']),
      }),
    ).rejects.toThrow(/no name/)
  })

  it('refuses a leaf for another key, and - once a CA is pinned - a leaf that does not chain to it', async () => {
    await ensureTlsCert(hubDir)
    const first = await createAgentHttpsRequest(
      agentDir,
      'agent-1',
      collectAgentNames('agent-1', facts),
    )
    const issued = await issueAgentHttpsLeaf({
      hubDataDir: hubDir,
      nodeId: 'agent-1',
      csrPem: first.csrPem,
      observedAddress: '192.168.1.20',
    })
    // A second request replaces the pending key: the FIRST leaf no longer fits it.
    await createAgentHttpsRequest(agentDir, 'agent-1', collectAgentNames('agent-1', facts))
    expect(() => installAgentHttps(agentDir, issued)).toThrow(AgentHttpsInstallError)

    // Pin the CA by installing for the current pending key...
    const second = await createAgentHttpsRequest(
      agentDir,
      'agent-1',
      collectAgentNames('agent-1', facts),
    )
    installAgentHttps(
      agentDir,
      await issueAgentHttpsLeaf({
        hubDataDir: hubDir,
        nodeId: 'agent-1',
        csrPem: second.csrPem,
        observedAddress: '192.168.1.20',
      }),
    )
    // ...then a different hub CA (another local CA) cannot be slipped in alongside a leaf.
    const otherHub = mkdtempSync(join(tmpdir(), 'other-hub-'))
    try {
      await ensureTlsCert(otherHub)
      const third = await createAgentHttpsRequest(
        agentDir,
        'agent-1',
        collectAgentNames('agent-1', facts),
      )
      const foreign = await issueAgentHttpsLeaf({
        hubDataDir: otherHub,
        nodeId: 'agent-1',
        csrPem: third.csrPem,
        observedAddress: '192.168.1.20',
      })
      expect(() => installAgentHttps(agentDir, foreign)).toThrow(/pinned/)
      // The pinned material is untouched.
      expect(loadAgentHttps(agentDir)?.caCertPem).toBe(
        readFileSync(join(hubDir, 'tls', 'camstack-ca.crt'), 'utf8'),
      )
    } finally {
      rmSync(otherHub, { recursive: true, force: true })
    }
  })

  it('a corrupt or mismatched bundle is reported and treated as absent - it never throws', async () => {
    const paths = agentHttpsPaths(agentDir)
    await createAgentHttpsRequest(agentDir, 'agent-1', collectAgentNames('agent-1', facts))
    writeFileSync(paths.bundlePath, '{ not json')
    const reasons: string[] = []
    expect(loadAgentHttps(agentDir, (r) => reasons.push(r))).toBeNull()
    expect(reasons).toHaveLength(1)

    await ensureTlsCert(hubDir)
    const request = await createAgentHttpsRequest(
      agentDir,
      'agent-1',
      collectAgentNames('agent-1', facts),
    )
    const issued = await issueAgentHttpsLeaf({
      hubDataDir: hubDir,
      nodeId: 'agent-1',
      csrPem: request.csrPem,
      observedAddress: '192.168.1.20',
    })
    const other = await createAgentHttpsRequest(
      agentDir,
      'agent-1',
      collectAgentNames('agent-1', facts),
    )
    expect(other.csrPem).not.toBe(request.csrPem)
    // key from a DIFFERENT request next to this leaf: the pair does not belong together.
    writeFileSync(
      paths.bundlePath,
      JSON.stringify({
        keyPem: readFileSync(paths.pendingKeyPath, 'utf8'),
        certPem: issued.certPem,
        caCertPem: issued.caCertPem,
      }),
    )
    const mismatch: string[] = []
    expect(loadAgentHttps(agentDir, (r) => mismatch.push(r))).toBeNull()
    expect(mismatch[0]).toMatch(/does not match/)
  })

  it('SECURITY: after the hub rotates its local CA, the hub signals it and the agent re-pins; without the signal the new CA is refused', async () => {
    await ensureTlsCert(hubDir)
    const first = await createAgentHttpsRequest(
      agentDir,
      'agent-1',
      collectAgentNames('agent-1', facts),
    )
    installAgentHttps(
      agentDir,
      await issueAgentHttpsLeaf({
        hubDataDir: hubDir,
        nodeId: 'agent-1',
        csrPem: first.csrPem,
        observedAddress: '192.168.1.20',
      }),
    )
    const oldPin = pinnedHttpsCaFingerprint(agentDir)
    expect(oldPin).not.toBeNull()

    // D227: the hub's local root is rotated - a different CA now signs the leaves.
    const rotatedHub = mkdtempSync(join(tmpdir(), 'rotated-hub-'))
    try {
      await ensureTlsCert(rotatedHub)
      const second = await createAgentHttpsRequest(
        agentDir,
        'agent-1',
        collectAgentNames('agent-1', facts),
      )
      const issued = await issueAgentHttpsLeaf({
        hubDataDir: rotatedHub,
        nodeId: 'agent-1',
        csrPem: second.csrPem,
        observedAddress: '192.168.1.20',
      })
      expect(() => installAgentHttps(agentDir, issued)).toThrow(/pinned/)
      expect(pinnedHttpsCaFingerprint(agentDir)).toBe(oldPin) // nothing changed

      // With the hub's signal the leaf is still verified against the CA it came with - then re-pinned.
      installAgentHttps(agentDir, { ...issued, caRotation: true })
      expect(pinnedHttpsCaFingerprint(agentDir)).not.toBe(oldPin)
      expect(loadAgentHttps(agentDir)?.certPem).toBe(issued.certPem)
      // A signalled rotation still refuses a leaf that does not chain to the CA beside it.
      const third = await createAgentHttpsRequest(
        agentDir,
        'agent-1',
        collectAgentNames('agent-1', facts),
      )
      const mismatched = await issueAgentHttpsLeaf({
        hubDataDir: hubDir,
        nodeId: 'agent-1',
        csrPem: third.csrPem,
        observedAddress: '192.168.1.20',
      })
      expect(() =>
        installAgentHttps(agentDir, {
          ...mismatched,
          caCertPem: issued.caCertPem,
          caRotation: true,
        }),
      ).toThrow(/not signed by the CA/)
    } finally {
      rmSync(rotatedHub, { recursive: true, force: true })
    }
  })

  it('a docker bridge or zone-scoped observed address is not certified: the node id alone is, and the reason is reported', () => {
    const bridge = acceptAgentSans({ nodeId: 'agent-1', observedAddress: '172.17.0.5' })
    expect(bridge.accepted).toEqual(['agent-1'])
    expect(bridge.rejected.join(' ')).toContain(
      'container bridge address, only the node id is certified',
    )
    const zoned = acceptAgentSans({ nodeId: 'agent-1', observedAddress: 'fe80::1%eth0' })
    expect(zoned.accepted).toEqual(['agent-1'])
    expect(zoned.rejected.join(' ')).toContain('zone-scoped')
    expect(isContainerBridgeAddress('172.17.4.9')).toBe(true)
    expect(isContainerBridgeAddress('172.18.0.2')).toBe(false)
  })
})
