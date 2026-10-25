/**
 * D873 vs the cluster: the mesh CA is a SEPARATE CA that name constraints never touch, and
 * the HTTPS leaves of agents (single-label node ids, Tailscale addresses) still validate
 * under the constrained HTTPS CA, proven with real TLS handshakes.
 */
import { readFileSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:tls'
import { X509Certificate as PeculiarCertificate } from '@peculiar/x509'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateMeshCa } from '../../kernel/moleculer/mesh-mtls/mesh-ca.js'
import { createAgentHttpsRequest, installAgentHttps, issueAgentHttpsLeaf } from '../agent-https.js'
import { ensureTlsCert, type HostFacts } from '../cert-manager.js'
import { readNameConstraints } from '../cert-name-constraints.js'

const HOST: HostFacts = {
  hostname: 'spec-host.lan',
  networkInterfaces: { eth0: [{ address: '192.168.10.9', internal: false }] },
}

describe('the mesh CA is separate from the constrained HTTPS CA (D873)', () => {
  it('has no name constraints, and its code never reaches the HTTPS CA generator', async () => {
    const mesh = await generateMeshCa()
    expect(readNameConstraints(new PeculiarCertificate(mesh.certPem))).toBeNull()
    expect(mesh.cert.subject).not.toContain('CamStack Local CA')
    const source = readFileSync(
      join(__dirname, '../../kernel/moleculer/mesh-mtls/mesh-ca.ts'),
      'utf-8',
    )
    const imports = source.split('\n').filter((line) => line.startsWith('import '))
    expect(imports.join('\n')).not.toMatch(/cert-issue|cert-manager|cert-name-constraints/)
    expect(source).not.toContain("'camstack-ca")
  })
})

describe('an agent HTTPS leaf validates under the constrained CA', () => {
  let hubDir: string
  let agentDir: string

  beforeEach(async () => {
    hubDir = mkdtempSync(join(tmpdir(), 'hub-d873-'))
    agentDir = mkdtempSync(join(tmpdir(), 'agent-d873-'))
    await ensureTlsCert(hubDir, { hostFacts: HOST })
  })
  afterEach(() => {
    rmSync(hubDir, { recursive: true, force: true })
    rmSync(agentDir, { recursive: true, force: true })
  })

  /** Issue, install, serve over real TLS and report the verification error (null = trusted). */
  async function handshake(nodeId: string, observedAddress: string): Promise<string | null> {
    const request = await createAgentHttpsRequest(agentDir, nodeId, {
      hostnames: [nodeId],
      addresses: [observedAddress],
    })
    const issued = await issueAgentHttpsLeaf({
      hubDataDir: hubDir,
      nodeId,
      csrPem: request.csrPem,
      observedAddress,
    })
    const material = installAgentHttps(agentDir, issued)
    const server = createHttpsServer({
      cert: `${material.certPem}${material.caCertPem}`,
      key: material.keyPem,
    })
    try {
      const port = await new Promise<number>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
      )
      return await new Promise<string | null>((resolve) => {
        const socket = connect(
          {
            host: '127.0.0.1',
            port,
            ca: readFileSync(join(hubDir, 'tls', 'camstack-ca.crt'), 'utf-8'),
            // Chain verification only: the hub dials agents by address, not by node id.
            checkServerIdentity: () => undefined,
          },
          () => {
            const error: unknown = socket.authorizationError
            socket.end()
            resolve(error ? String(error) : null)
          },
        )
        socket.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message))
      })
    } finally {
      server.close()
    }
  }

  it.each([
    ['agent-a', '10.0.0.30'],
    ['agent-b', '100.64.7.8'],
    ['agent-mac.localdomain', '100.101.102.103'],
  ])('node %s reached at %s validates', async (nodeId, address) => {
    expect(await handshake(nodeId, address)).toBeNull()
  })

  it('a Tailscale address is certified (100.64.0.0/10 is permitted)', async () => {
    const request = await createAgentHttpsRequest(agentDir, 'agent-b', {
      hostnames: [],
      addresses: [],
    })
    const issued = await issueAgentHttpsLeaf({
      hubDataDir: hubDir,
      nodeId: 'agent-b',
      csrPem: request.csrPem,
      observedAddress: '100.64.7.8',
    })
    expect(issued.accepted).toContain('100.64.7.8')
  })

  it('an address outside the ranges is refused, never signed', async () => {
    const request = await createAgentHttpsRequest(agentDir, 'agent-a', {
      hostnames: [],
      addresses: [],
    })
    await expect(
      issueAgentHttpsLeaf({
        hubDataDir: hubDir,
        nodeId: 'agent-a',
        csrPem: request.csrPem,
        observedAddress: '8.8.8.8',
      }),
    ).rejects.toThrow(/no name/)
  })
})
