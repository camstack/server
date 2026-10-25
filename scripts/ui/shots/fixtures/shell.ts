/**
 * The app frame every page needs: the signed-in admin, the installed addons
 * (every workspace manifest), their pages, the capability list, the node
 * topology and the server version. Loaded after the selected areas, so an
 * area overrides any answer here.
 */
import manifests from 'virtual:ui-shots-manifests'
import { defineFixtures } from './_define'
import { iso, NOW } from './_time'
import {
  bundledCamstack,
  DISPLAY_PRESETS,
} from '../../../../packages/types/src/catalogs/display-palette.ts'

type Manifest = (typeof manifests)[number] & {
  readonly capabilities?: readonly (string | { readonly name: string })[]
  readonly pages?: readonly Record<string, unknown>[]
}
const ALL = manifests as readonly Manifest[]
const capNames = (m: Manifest): string[] =>
  (m.capabilities ?? []).map((c) => (typeof c === 'string' ? c : c.name))

const ADDONS = ALL.map((m) => ({
  manifest: { ...m },
  source: 'installed',
  process: { mode: 'forked', state: 'running', pid: 4200 },
  health: {
    phase: 'healthy',
    retryCount: 0,
    firstFailureAt: null,
    lastAttemptAt: null,
    lastError: null,
    nextRetryAt: null,
    alertEmitted: false,
    retrying: false,
    inGracePeriod: false,
  },
}))

const providersOf = (capName: string) =>
  ALL.filter((m) => capNames(m).includes(capName)).map((m) => ({
    addonId: m.id,
    mode: 'collection',
    isActive: true,
  }))

const CAPABILITIES = [...new Set(ALL.flatMap(capNames))].toSorted().map((name) => {
  const providers = providersOf(name).map((p) => p.addonId)
  return {
    name,
    mode: providers.length === 1 ? 'singleton' : 'collection',
    providers,
    activeProvider: providers.length === 1 ? providers[0] : null,
    disabledProviders: [],
  }
})

const PAGES = ALL.flatMap((m) => (m.pages ?? []).map((page) => ({ addonId: m.id, page })))

const SERVER_VERSION = '1.2.500'
const node = (id: string, isHub: boolean, ip: string, platform: string, cpuModel: string) => ({
  id,
  name: isHub ? 'Hub' : id,
  hostname: id,
  platform,
  arch: platform === 'darwin' ? 'arm64' : 'x64',
  cpuModel,
  cpuCores: 8,
  memoryMB: 16_000,
  engines: [platform === 'darwin' ? 'coreml' : 'openvino'],
  isHub,
  isOnline: true,
  cpuPercent: 18.4,
  memoryPercent: 41.2,
  uptime: 4 * 86_400_000,
  lastSeen: iso(NOW),
  localIps: [ip],
  addons: [],
  processes: [],
  categories: [],
  rootPackage: { name: '@camstack/server', version: SERVER_VERSION },
})

export default defineFixtures({
  area: 'shell',
  description: 'App frame: admin user, every workspace addon installed, capabilities, two nodes',
  handlers: {
    'auth.me': { id: 'u-admin', username: 'admin', isAdmin: true },
    'addonPages.listPages': PAGES,
    'addonWidgets.listWidgets': [],
    'addons.list': ADDONS,
    'addons.listUpdates': [],
    'addons.listCapabilityProviders': (i: { capName: string }) => providersOf(i.capName),
    'alerts.getUnreadCount': 1,
    'alerts.list': [
      {
        id: 'shot-google-broker-critical',
        category: 'google.broker-reconnect',
        severity: 'critical',
        title: 'Google needs a new sign-in',
        message: 'Work Google needs sign-in again',
        read: false,
        status: 'active',
        action: { label: 'Sign in again', href: '/system/integrations' },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    'capabilities.listCapabilities': CAPABILITIES,
    'deviceManager.getRoleDisplayDefaults': {},
    'deviceManager.listAll': [],
    'integrations.list': [],
    'logs.query': {
      entries: [],
      nextBefore: null,
      nextAfter: null,
      scannedBytes: 0,
      done: true,
      source: 'winston-logging',
    },
    'logs.sources': [],
    'nodes.topology': [
      node('hub', true, '192.0.2.2', 'linux', 'Intel(R) Core(TM) i5-12500'),
      node('garage-nuc', false, '192.0.2.21', 'linux', 'Intel(R) N100'),
    ],
    'serverManagement.getServerPackageStatus': {
      packageName: '@camstack/server',
      runningVersion: SERVER_VERSION,
      nodeRuntimeVersion: '24.21.0',
      activeVersion: SERVER_VERSION,
      installedVersion: SERVER_VERSION,
      restartRequired: false,
      previousVersion: null,
      seedVersion: SERVER_VERSION,
      latestVersion: SERVER_VERSION,
      updateAvailable: false,
      bootMode: 'data-root',
      updateState: 'idle',
      pendingVersion: null,
      rolledBack: null,
      stateFileCorrupt: false,
      lastCheckedAtMs: NOW,
    },
    // A NAMED hub (D861): no "Name this server" dialog over every other page's shot.
    // `server-name.ts` overrides it with the unnamed case.
    'system.info': {
      streaming: true,
      notifications: true,
      objectDetection: true,
      remoteAccess: true,
      agentCluster: true,
      smartHome: true,
      recordings: true,
      backup: true,
      repl: false,
      serverName: { name: 'Home hub', isDefault: false },
    },
    'system.getSiteLocation': {
      location: null,
      derivationAttemptedAt: null,
      derivationError: null,
    },
    'addonSettings.getGlobalSettings': null,
    'displayPalette.getPalette': bundledCamstack(),
    'displayPalette.listPresets': DISPLAY_PRESETS.map((row) => ({
      id: row.id,
      name: row.name,
      swatches: row.swatches,
      fallbacks: [...row.fallbacks],
    })),
  },
})
