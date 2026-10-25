/**
 * `timedFetch` — the Lambda's only outbound HTTP primitive.
 *
 * Uses https.request with a no-keep-alive Agent. Node's built-in fetch
 * (undici-backed) reuses pooled sockets aggressively; in AWS Lambda the
 * invocation-to-invocation gaps can leave pooled sockets stale, and the next
 * fetch throws DOMException AbortError in <1s. https.request gives us explicit
 * control.
 *
 * NEVER logs request or response bodies, headers or query strings: they carry
 * OAuth codes, LWA tokens and broker credentials. The timing line records only
 * scheme, host, path, status and sub-timings.
 */
'use strict'

const https = require('node:https')
const http = require('node:http')
const { URL } = require('node:url')

const FETCH_TIMEOUT_MS = 6000
const NO_KEEPALIVE_AGENT = new https.Agent({ keepAlive: false })

async function timedFetch(url, init = {}) {
  // Returns a fetch-compatible response object: { ok, status, statusText,
  // text(), json() }. The handler only uses .text() / status.
  //
  // Emits a single structured timing log line on completion (or failure),
  // measuring DNS / TCP / TLS / request-sent / first-byte / last-byte sub-
  // timings. Read these from CloudWatch with:
  //   filter @message like /timedFetch_timing/
  // to see end-to-end where the wall-clock seconds go (DNS hang vs TCP RTT
  // vs TLS handshake vs hub processing time vs body download).
  return new Promise((resolve, reject) => {
    let settled = false
    const parsed = new URL(url)
    const isHttps = parsed.protocol === 'https:'
    const lib = isHttps ? https : http
    const headers = { ...(init.headers || {}), connection: 'close' }
    if (init.body !== undefined && headers['content-length'] === undefined) {
      headers['content-length'] = Buffer.byteLength(init.body)
    }
    const T0 = process.hrtime.bigint()
    const marks = {
      dns: null,
      tcpConnect: null,
      tlsHandshake: null,
      requestSent: null,
      firstByte: null,
      lastByte: null,
    }
    const ms = (a, b) => Number((b - a) / 1_000_000n)
    const logTiming = (status, extras = {}) => {
      const T_end = process.hrtime.bigint()
      const total = ms(T0, T_end)
      const stages = {
        dns: marks.dns ? ms(T0, marks.dns) : null,
        tcp: marks.tcpConnect ? ms(T0, marks.tcpConnect) : null,
        tls: marks.tlsHandshake ? ms(T0, marks.tlsHandshake) : null,
        reqSent: marks.requestSent ? ms(T0, marks.requestSent) : null,
        firstByte: marks.firstByte ? ms(T0, marks.firstByte) : null,
        lastByte: marks.lastByte ? ms(T0, marks.lastByte) : null,
      }
      // Stage durations between marks, easier to read at a glance:
      const between = {
        dns_ms: stages.dns,
        tcp_handshake_ms:
          stages.tcp != null && stages.dns != null ? stages.tcp - stages.dns : stages.tcp,
        tls_handshake_ms: stages.tls != null && stages.tcp != null ? stages.tls - stages.tcp : null,
        request_send_ms:
          stages.reqSent != null && (stages.tls ?? stages.tcp) != null
            ? stages.reqSent - (stages.tls ?? stages.tcp)
            : null,
        wait_first_byte_ms:
          stages.firstByte != null && stages.reqSent != null
            ? stages.firstByte - stages.reqSent
            : null,
        download_ms:
          stages.lastByte != null && stages.firstByte != null
            ? stages.lastByte - stages.firstByte
            : null,
      }
      console.log(
        'timedFetch_timing',
        JSON.stringify({
          url: `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`,
          method: (init.method || 'GET').toUpperCase(),
          status,
          total_ms: total,
          stages_cum_ms: stages,
          between_ms: between,
          ...extras,
        }),
      )
    }
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: (init.method || 'GET').toUpperCase(),
        headers,
        agent: isHttps ? NO_KEEPALIVE_AGENT : undefined,
      },
      (res) => {
        marks.firstByte = process.hrtime.bigint()
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          marks.lastByte = process.hrtime.bigint()
          const body = Buffer.concat(chunks).toString('utf8')
          const headersApi = {
            get: (name) => {
              const v = res.headers[String(name).toLowerCase()]
              if (Array.isArray(v)) return v.join(', ')
              return v == null ? null : String(v)
            },
          }
          logTiming(res.statusCode, { responseBodyBytes: body.length })
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage || '',
            headers: headersApi,
            text: async () => body,
            json: async () => JSON.parse(body),
          })
        })
        res.on('error', (err) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          logTiming('res_error', { error: err && err.message })
          reject(err)
        })
      },
    )
    req.on('socket', (socket) => {
      socket.on('lookup', () => {
        marks.dns = process.hrtime.bigint()
      })
      socket.on('connect', () => {
        marks.tcpConnect = process.hrtime.bigint()
      })
      socket.on('secureConnect', () => {
        marks.tlsHandshake = process.hrtime.bigint()
      })
    })
    req.on('finish', () => {
      marks.requestSent = process.hrtime.bigint()
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      logTiming('req_error', { error: err && err.message, code: err && err.code })
      reject(err)
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      req.destroy(new Error(`timedFetch timeout after ${FETCH_TIMEOUT_MS}ms`))
      logTiming('timeout', { timeout_ms: FETCH_TIMEOUT_MS })
      reject(new Error(`timedFetch timeout after ${FETCH_TIMEOUT_MS}ms`))
    }, FETCH_TIMEOUT_MS)
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}

module.exports = { timedFetch, FETCH_TIMEOUT_MS }
