/**
 * System → Nodes: the node's General tab for a node running inside the native
 * desktop app, with a downloaded update ready to install.
 */
import { defineFixtures } from './_define'
import { NOW } from './_time'

const VERSION = '1.2.500'

export default defineFixtures({
  area: 'desktop-app',
  description: 'A node whose desktop app has a downloaded update ready to install.',
  handlers: {
    'serverManagement.getServerPackageStatus': {
      packageName: '@camstack/server',
      runningVersion: VERSION,
      nodeRuntimeVersion: '24.21.0',
      activeVersion: VERSION,
      installedVersion: VERSION,
      restartRequired: false,
      previousVersion: null,
      seedVersion: VERSION,
      latestVersion: VERSION,
      updateAvailable: false,
      bootMode: 'data-root',
      updateState: 'idle',
      pendingVersion: null,
      rolledBack: null,
      stateFileCorrupt: false,
      lastCheckedAtMs: NOW,
      desktopApp: {
        version: '1.2.500',
        update: {
          available: true,
          downloaded: true,
          version: '1.2.510',
          checking: false,
          error: null,
        },
        stateAtMs: NOW,
        stale: false,
      },
    },
  },
})
