/**
 * System → Addons (`/system/addons?capability=…`): the npm catalog answers a
 * capability-filtered search with the packages whose manifest declares it.
 * Tailscale declares `mesh-network` + `network-access`, none of which the shell's
 * installed addons provide for the `mesh-network` link.
 */
import { defineFixtures } from './_define'

const PUBLISHED = [
  {
    name: '@camstack/addon-tailscale',
    version: '1.4.2',
    description: 'Tailnet client and Serve/Funnel ingress for the hub.',
    keywords: ['camstack', 'addon'],
    publishedAt: '2026-10-01T00:00:00.000Z',
    author: 'camstack',
    installed: false,
    capabilities: ['mesh-network', 'network-access'],
  },
  {
    name: '@camstack/addon-static-turn',
    version: '1.0.3',
    description: 'A fixed TURN relay for remote viewers.',
    keywords: ['camstack', 'addon'],
    publishedAt: '2026-09-20T00:00:00.000Z',
    author: 'camstack',
    installed: false,
    capabilities: ['turn-provider'],
  },
]

/**
 * Installed addons with the real runner state (D877): one running, one that
 * REFUSED to start, one whose breaker gave up, one with no runner at all.
 */
function installed(
  id: string,
  name: string,
  process: { pid?: number; mode: string; state: string; reason?: string },
) {
  return {
    manifest: {
      id,
      name,
      version: '1.2.3',
      packageName: `@camstack/addon-${id}`,
      packageVersion: '1.2.3',
      capabilities: [],
    },
    source: 'installed',
    installSource: 'npm',
    process,
    hasBackup: false,
    health: null,
  }
}

const INSTALLED = [
  installed('reolink', 'Reolink', { pid: 4101, mode: 'forked', state: 'running' }),
  installed('auth', 'Authentication', {
    pid: 4102,
    mode: 'forked',
    state: 'refused',
    reason:
      'addon "auth" refuses to start: per-device blobs - the settings it had are still in the per-addon tables.',
  }),
  installed('homematic', 'Homematic', { pid: 4103, mode: 'forked', state: 'failed' }),
  installed('alexa', 'Alexa', { mode: 'forked', state: 'missing' }),
]

export default defineFixtures({
  area: 'addons',
  description: 'npm catalog search filtered by capability',
  handlers: {
    'addons.list': INSTALLED,
    'addons.listInstallations': { installations: [], unreachable: [] },
    'nodes.clusterAddonStatus': {},
    'addons.searchAvailable': (input: { capability?: string; query?: string } | undefined) =>
      PUBLISHED.filter(
        (pkg) =>
          input?.capability === undefined || (pkg.capabilities ?? []).includes(input.capability),
      ),
    'addons.getVersions': () => [
      {
        version: '1.4.2',
        publishedAt: '2026-10-01T00:00:00.000Z',
        distTags: ['latest'],
      },
      {
        version: '1.0.0',
        publishedAt: '2026-01-01T00:00:00.000Z',
        deprecated: 'superseded by 1.4.2',
        distTags: [],
      },
    ],
    'addons.getPackageDocs': (input: { name?: string; version?: string } | undefined) => ({
      name: input?.name ?? '@camstack/addon-tailscale',
      version: input?.version ?? '1.4.2',
      readme: {
        status: 'ok',
        markdown:
          '# Tailscale\n\nConnects the hub to a tailnet.\n\n## Settings\n\nThe auth key is a keychain password.\n\n## Node placement\n\nHub only.\n',
      },
      changelog: {
        status: 'ok',
        markdown: '# Changelog\n\n## 1.4.2\n\n- Documented Serve reload.\n',
      },
    }),
    'addons.getAutoUpdateSettings': {
      channel: 'off',
      intervalSeconds: 21600,
      updateCheckIntervalSeconds: 21600,
    },
    'addons.getAddonAutoUpdate': 'inherit',
    'addons.getLastRestart': null,
    'addons.listJobs': [],
  },
})
