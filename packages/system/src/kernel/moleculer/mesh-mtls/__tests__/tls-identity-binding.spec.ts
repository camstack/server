/**
 * TLS identity binding + handshake refusal specs (Release A).
 *
 *  - forged sender ≠ peer CN is dropped
 *  - node without a CA-issued certificate cannot complete an authorized handshake
 *  - revoked certificate is refused (CRL stub)
 */
import { createServer as createNetServer } from 'node:net'
import * as tls from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import { generateMeshCa, issueMeshLeafForNode } from '../mesh-ca.js'
import { MeshCrl } from '../mesh-crl.js'
import { TlsTcpTransporter } from '../tls-tcp-transporter.js'

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      if (addr === null || typeof addr === 'string') {
        s.close(() => reject(new Error('no port')))
        return
      }
      const { port } = addr
      s.close(() => resolve(port))
    })
  })
}

describe('mesh mTLS handshake', () => {
  const stops: Array<() => void> = []
  afterEach(() => {
    for (const s of stops.splice(0)) s()
  })

  it('refuses a client whose certificate is not issued by the hub CA', async () => {
    const hubCa = await generateMeshCa()
    const otherCa = await generateMeshCa()
    const hub = await issueMeshLeafForNode(hubCa, 'hub')
    const impostor = await issueMeshLeafForNode(otherCa, 'impostor')
    const tlsPort = await freePort()

    const outcome = await new Promise<string>((resolve) => {
      const server = tls.createServer(
        {
          key: hub.keyPem,
          cert: hub.certPem,
          ca: [hubCa.certPem],
          requestCert: true,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.3',
        },
        (socket) => {
          resolve(`unexpected authorized=${String(socket.authorized)}`)
          socket.destroy()
          server.close()
        },
      )
      stops.push(() => server.close())
      server.on('tlsClientError', (err) => {
        resolve(`tlsClientError:${err.message}`)
        server.close()
      })
      server.listen(tlsPort, '127.0.0.1', () => {
        const socket = tls.connect({
          host: '127.0.0.1',
          port: tlsPort,
          key: impostor.keyPem,
          cert: impostor.certPem,
          ca: [hubCa.certPem],
          rejectUnauthorized: false,
          minVersion: 'TLSv1.3',
          servername: 'hub',
          checkServerIdentity: () => undefined,
        })
        socket.on('error', (err) => {
          resolve(`clientError:${err.message}`)
          server.close()
        })
        socket.on('secureConnect', () => {
          // Server may still kill us; give it a tick.
          setTimeout(() => {
            if (socket.destroyed) resolve('client destroyed after secureConnect')
            else {
              resolve('client stayed up')
              socket.destroy()
              server.close()
            }
          }, 50)
        })
      })
    })
    expect(outcome).toMatch(/tlsClientError|clientError|destroyed|alert/i)
  })

  it('accepts a client with a CA-issued certificate (mutual)', async () => {
    const ca = await generateMeshCa()
    const hub = await issueMeshLeafForNode(ca, 'hub')
    const agent = await issueMeshLeafForNode(ca, 'agent-a')
    const tlsPort = await freePort()

    const peerCn = await new Promise<string | null>((resolve, reject) => {
      const server = tls.createServer(
        {
          key: hub.keyPem,
          cert: hub.certPem,
          ca: [ca.certPem],
          requestCert: true,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.3',
        },
        (socket) => {
          const cert = socket.getPeerCertificate()
          const cn =
            typeof cert.subject === 'object' && cert.subject !== null && 'CN' in cert.subject
              ? String((cert.subject as { CN?: string }).CN ?? '')
              : null
          resolve(socket.authorized ? cn : null)
          socket.end()
          server.close()
        },
      )
      stops.push(() => server.close())
      server.on('tlsClientError', (err) => reject(err))
      server.listen(tlsPort, '127.0.0.1', () => {
        const socket = tls.connect(
          {
            host: '127.0.0.1',
            port: tlsPort,
            key: agent.keyPem,
            cert: agent.certPem,
            ca: [ca.certPem],
            rejectUnauthorized: true,
            minVersion: 'TLSv1.3',
            servername: 'hub',
            checkServerIdentity: () => undefined,
          },
          () => {
            socket.end()
          },
        )
        socket.on('error', reject)
      })
    })
    expect(peerCn).toBe('agent-a')
  })

  it('drops a forged sender that does not match the peer CN', () => {
    const crl = new MeshCrl()
    const tx = new TlsTcpTransporter({ crl, tlsPort: 0 })
    const dropped: string[] = []
    tx.logger = {
      info: () => {},
      warn: (msg: string) => {
        dropped.push(msg)
      },
      debug: () => {},
      error: () => {},
    }

    const fakeSocket = {
      encrypted: true,
      meshPeerCn: 'honest',
      meshPeerSerial: '01',
      getPeerCertificate: () => ({
        raw: Buffer.from('not-used'),
        subject: { CN: 'honest' },
        serialNumber: '01',
      }),
      destroy: () => {},
    }

    const original = tx.deserialize.bind(tx)
    tx.deserialize = () => ({ payload: { sender: 'forged' } })
    try {
      tx.onIncomingMessage('REQ', Buffer.from('x'), fakeSocket as never)
    } finally {
      tx.deserialize = original
    }
    expect(dropped.some((m) => /forged/i.test(m))).toBe(true)
  })

  it('CRL refuses a revoked serial at the next check', async () => {
    const ca = await generateMeshCa()
    const leaf = await issueMeshLeafForNode(ca, 'rogue')
    const crl = new MeshCrl()
    crl.revoke(leaf.serialNumber)
    expect(crl.isRevoked(leaf.serialNumber)).toBe(true)
  })
})
