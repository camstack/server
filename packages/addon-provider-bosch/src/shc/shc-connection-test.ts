import { connect } from 'node:net'
import type { IConnectionProbe, IScopedLogger } from '@camstack/types'

/** REST port of a Smart Home Controller. A connect here means the address answers. */
export const SHC_REACHABILITY_PORT = 8444

export interface ShcConnectionTestDeps {
  readonly logger: IScopedLogger
  readonly probe?: (host: string, port: number) => Promise<boolean>
}

export function buildShcConnectionTestProvider(
  deps: ShcConnectionTestDeps,
): IConnectionProbe {
  const { logger, probe = probeTcp } = deps

  return {
    testSettings: async ({ settings }) => {
      const host = readHost(settings)
      if (host === null) {
        return { outcome: 'rejected', error: 'Enter the controller host or IP address.' }
      }
      const startedAt = Date.now()
      const reachable = await probe(host, SHC_REACHABILITY_PORT)
      if (!reachable) {
        logger.warn('Bosch SHC connection test: host unreachable', {
          meta: { host, port: SHC_REACHABILITY_PORT },
        })
        return {
          outcome: 'rejected',
          error: `Could not reach ${host} on port ${SHC_REACHABILITY_PORT}.`,
        }
      }
      return { outcome: 'validated', latencyMs: Date.now() - startedAt }
    },
  }
}

function readHost(settings: unknown): string | null {
  if (settings === null || typeof settings !== 'object') return null
  const host = Reflect.get(settings, 'host')
  if (typeof host !== 'string') return null
  const trimmed = host.trim()
  return trimmed.length > 0 ? trimmed : null
}

function probeTcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const finish = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(4_000, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}
