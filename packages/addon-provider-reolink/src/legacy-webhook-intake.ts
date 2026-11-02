import { createServer, type Server } from 'node:http'
import type { DataPlaneHandler, IScopedLogger } from '@camstack/types'
import type { WebhookCamera } from './webhook-plane.js'

/**
 * COMPATIBILITY WINDOW for the retired private webhook listener (D999). A battery camera that
 * sleeps through the upgrade still posts to `http://<hub>:9081/webhook/<stableId>`; it is
 * re-pointed on its next Baichuan contact, and until then this receive-only listener feeds the SAME
 * handler as the data-plane plane (same parse, same 404/413/400 rules, same events).
 *
 * RETIREMENT: remove this file, its wiring in `addon.ts` and its spec after 2026-12-15. The spec
 * `legacy-webhook-intake.spec.ts` fails from that date while this file exists.
 */
export const LEGACY_WEBHOOK_PORT = 9081
export const LEGACY_WEBHOOK_RETIRE_AFTER = '2026-12-15'
const LEGACY_PREFIX = '/webhook/'

export interface LegacyWebhookDeps {
  readonly logger: IScopedLogger
  readonly listCameras: () => readonly WebhookCamera[]
  readonly handler: DataPlaneHandler
  readonly port?: number
}

export interface LegacyWebhookIntake {
  readonly server: Server
  close(): Promise<void>
}

export async function startLegacyWebhookIntake(
  deps: LegacyWebhookDeps,
): Promise<LegacyWebhookIntake> {
  const warned = new Set<string>()
  const server = createServer((req, res) => {
    const url = req.url ?? ''
    if (!url.startsWith(LEGACY_PREFIX)) {
      res.writeHead(404).end()
      return
    }
    const rest = url.slice(LEGACY_PREFIX.length - 1) // keep the leading slash: `/<id>`
    req.url = rest
    const id = decodeURIComponent(rest.replace(/^\//, '').split('?')[0] ?? '')
    const camera = deps.listCameras().find((c) => c.stableId === id)
    if (camera !== undefined && !warned.has(id)) {
      warned.add(id)
      deps.logger.warn('legacy webhook port used — camera will be re-pointed', {
        tags: { deviceId: camera.id },
        meta: { port: deps.port ?? LEGACY_WEBHOOK_PORT },
      })
    }
    void Promise.resolve(deps.handler(req, res)).catch((err: unknown) => {
      deps.logger.error('legacy webhook intake failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(deps.port ?? LEGACY_WEBHOOK_PORT, '0.0.0.0', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return {
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
