import type { ServiceBroker } from 'moleculer'
import type { IAddonProcessManager } from '@camstack/types'

function createScopedProcessManager(broker: ServiceBroker, addonId: string): IAddonProcessManager {
  return {
    async spawn(config) {
      const result = (await broker.call('$process.spawnRunner', {
        runnerId: config.name,
        addons: [{ addonId, addonDir: config.command ?? config.name }],
        env: config.env as Record<string, string> | undefined,
      })) as { pid: number; nodeId: string }
      return {
        pid: result.pid,
        name: config.name,
        getStats: () => ({
          pid: result.pid,
          cpuPercent: 0,
          memoryRss: 0,
          uptimeSeconds: 0,
          restartCount: 0,
          state: 'running' as const,
        }),
        write: () => {},
        stdout: (async function* () {})(),
        stderr: (async function* () {})(),
        kill: () => {
          broker.call('$process.stop', { name: config.name }).catch(() => {})
        },
        wait: () => new Promise(() => {}),
        onExit: () => () => {},
        onError: () => () => {},
      }
    },

    listProcesses() {
      return []
    },

    getWorkerStats() {
      return {
        pid: process.pid,
        cpuPercent: 0,
        memoryRss: process.memoryUsage().rss,
        uptimeSeconds: Math.floor(process.uptime()),
        restartCount: 0,
        state: 'running' as const,
      }
    },
  }
}

export { createScopedProcessManager }
