/** The real {@link ScanIo}: node `dgram`, `http` and `https`. Not unit-tested; the engine is. */
import { createSocket } from 'node:dgram'
import * as http from 'node:http'
import * as https from 'node:https'
import {
  type HttpProbeOutcome,
  type HttpProbeRequest,
  MAX_HIT_BODY_BYTES,
  type ScanIo,
  type UdpExchangeRequest,
  type UdpReply,
} from './scan-io.js'

function udpExchange(request: UdpExchangeRequest): Promise<readonly UdpReply[]> {
  return new Promise((resolve, reject) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    const replies: UdpReply[] = []
    let settled = false
    const finish = (error: Error | null): void => {
      if (settled) return
      settled = true
      try {
        socket.close()
      } catch {
        // already closed
      }
      if (error !== null) reject(error)
      else resolve(replies)
    }
    socket.on('error', (err) => finish(err))
    socket.on('message', (data, rinfo) => {
      replies.push({ host: rinfo.address, port: rinfo.port, data })
    })
    socket.bind(request.bindPort ?? 0, request.localAddress ?? undefined, () => {
      try {
        if (request.broadcast === true) socket.setBroadcast(true)
        if (request.localAddress !== undefined) socket.setMulticastInterface(request.localAddress)
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)))
        return
      }
      const burst = (): void => {
        if (settled) return
        for (const target of request.targets) {
          socket.send(request.payload, target.port, target.host, () => {
            // A single unreachable target is not a failed scan.
          })
        }
      }
      burst()
      for (const offset of request.resendAtMs ?? []) setTimeout(burst, offset)
      setTimeout(() => finish(null), request.listenMs)
    })
  })
}

function httpProbe(request: HttpProbeRequest): Promise<HttpProbeOutcome> {
  return new Promise((resolve) => {
    const transport = request.tls ? https : http
    let settled = false
    const done = (outcome: HttpProbeOutcome): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    const body = request.bodyText
    const req = transport.request(
      {
        host: request.host,
        port: request.port,
        path: request.path,
        method: request.method,
        timeout: request.timeoutMs,
        // LAN devices ship self-signed certificates; a probe only asks "who answers".
        ...(request.tls ? { rejectUnauthorized: false } : {}),
        headers: {
          ...(request.contentType !== undefined ? { 'content-type': request.contentType } : {}),
          ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        const finish = (): void => {
          const headers: Record<string, string> = {}
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headers[k.toLowerCase()] = v
            else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ')
          }
          done({
            kind: 'response',
            status: res.statusCode ?? 0,
            headers,
            bodyText: Buffer.concat(chunks).toString('utf8'),
          })
        }
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk.subarray(0, MAX_HIT_BODY_BYTES - size))
          size += chunk.length
          if (size >= MAX_HIT_BODY_BYTES) {
            finish()
            req.destroy()
          }
        })
        res.on('end', finish)
        res.on('error', () => done({ kind: 'unreachable' }))
      },
    )
    req.on('timeout', () => {
      done({ kind: 'timeout' })
      req.destroy()
    })
    req.on('error', () => done({ kind: 'unreachable' }))
    if (body !== undefined) req.write(body)
    req.end()
  })
}

export const nodeScanIo: ScanIo = { udpExchange, httpProbe }
