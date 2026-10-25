/**
 * Streams one hub data-plane path into a local file (the retrain export tar).
 *
 * GET only, bearer from the credential chain, TLS from the shared trust
 * config. The bytes go to `<dest>.part` and are renamed on success, so a cut
 * connection never leaves a plausible-looking truncated archive. A size cap
 * and a timeout bound it; the export is generated on the fly, so there is no
 * resume (the handler sends no `Accept-Ranges` on purpose).
 */
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as https from 'node:https'
import { createHubAgent, type HubTlsConfig } from '@camstack/develop'
import type { HubDownloader } from './hub.js'

export const DOWNLOAD_TIMEOUT_MS: number = 30 * 60_000

export interface DownloaderOptions {
  readonly baseUrl: string
  readonly token: string
  readonly tls: HubTlsConfig
  readonly timeoutMs?: number
}

export function createHubDownloader(options: DownloaderOptions): HubDownloader {
  return (urlPath, destFile, maxBytes) =>
    new Promise((resolve, reject) => {
      const parsed = new URL(urlPath, options.baseUrl)
      const isHttps = parsed.protocol === 'https:'
      const part = `${destFile}.part`
      const out = fs.createWriteStream(part, { mode: 0o600 })
      let bytes = 0
      const fail = (err: Error): void => {
        out.destroy()
        fs.rmSync(part, { force: true })
        reject(err)
      }
      const requestOptions: https.RequestOptions = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${options.token}` },
        timeout: options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
        ...(isHttps ? { agent: createHubAgent(options.tls) } : {}),
      }
      const onResponse = (res: http.IncomingMessage): void => {
        if (res.statusCode !== 200) {
          res.resume()
          fail(new Error(`hub answered HTTP ${res.statusCode ?? 0} for the export download`))
          return
        }
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > maxBytes) {
            res.destroy(new Error(`export larger than ${maxBytes} bytes — narrow the filter`))
            return
          }
          if (!out.write(chunk)) {
            res.pause()
            out.once('drain', () => res.resume())
          }
        })
        res.on('error', fail)
        res.on('end', () => {
          out.end(() => {
            try {
              fs.renameSync(part, destFile)
              resolve({ bytes })
            } catch (err) {
              fail(err instanceof Error ? err : new Error(String(err)))
            }
          })
        })
      }
      const request = isHttps
        ? https.request(requestOptions, onResponse)
        : http.request(requestOptions, onResponse)
      request.on('error', fail)
      request.on('timeout', () => request.destroy(new Error('export download timed out')))
      request.end()
    })
}
