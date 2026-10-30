import { describe, expect, it } from 'vitest'
import {
  configureAddonsSearch,
  installAddon,
  uninstallAddon,
  updateAddon,
} from '../mcp/configure-addons.js'
import { asProtectedTier, dryRunOf, gatedHub, writes } from './configure-fixtures.js'

const PKG = '@camstack/addon-provider-amcrest'

const packument = {
  peerDependencies: { '@camstack/types': '*' },
  engines: { node: '>=24' },
  camstack: { addons: [{ execution: { placement: 'hub-only' } }] },
}

const answers = (extra: { [path: string]: unknown } = {}): { [path: string]: unknown } => ({
  'addons.searchAvailable': [
    {
      name: PKG,
      version: '0.2.162',
      description: 'Amcrest',
      keywords: [],
      installed: false,
      capabilities: ['device-provider'],
    },
    {
      name: '@camstack/addon-provider-reolink',
      version: '1.2.213',
      description: 'Reolink',
      keywords: [],
      installed: true,
      capabilities: ['device-provider'],
    },
  ],
  'addons.list': [
    {
      manifest: {
        id: 'provider-reolink',
        packageName: '@camstack/addon-provider-reolink',
        packageVersion: '1.2.200',
      },
    },
    {
      manifest: {
        id: 'keychain',
        packageName: '@camstack/system',
        packageVersion: '1.2.523',
        protected: true,
        removable: false,
      },
    },
  ],
  'addons.listUpdates': [
    {
      name: '@camstack/addon-provider-reolink',
      currentVersion: '1.2.200',
      latestVersion: '1.2.213',
      category: 'addon',
      requiresRestart: false,
      isSystem: false,
    },
    {
      name: '@camstack/system',
      currentVersion: '1.2.523',
      latestVersion: '1.2.600',
      category: 'core',
      requiresRestart: true,
      isSystem: true,
    },
  ],
  'addons.listInstallations': { installations: [], unreachable: [] },
  'serverManagement.getServerPackageStatus': { runningVersion: '1.2.523' },
  ...extra,
})

describe('configure_addons_search', () => {
  it('joins the catalog with the installed version, update and compatibility', async () => {
    const { ctx } = gatedHub(answers(), packument)
    const out = await configureAddonsSearch(ctx, {
      capability: 'device-provider',
    })
    if (out.status !== 'ok') throw new Error('expected ok')
    const reolink = out.items?.find((i) => i.name === '@camstack/addon-provider-reolink')
    expect(reolink).toMatchObject({
      installed: true,
      installedVersion: '1.2.200',
      updateTo: '1.2.213',
    })
    const amcrest = out.items?.find((i) => i.name === PKG)
    expect(amcrest).toMatchObject({
      installed: false,
      compatibility: {
        placement: ['hub-only'],
        peerTypesRange: '*',
        node: '>=24',
      },
    })
    expect(out.hubServerVersion).toBe('1.2.523')
  })
})

describe('configure_addon_install', () => {
  const installations = (nodes: object[]): object => ({
    installations: nodes,
    unreachable: [],
  })

  it('previews, installs on confirm and reports who has it and who will follow', async () => {
    let installed = false
    const hub = gatedHub(
      answers({
        'addons.installPackage': () => {
          installed = true
          return { ok: true }
        },
        'addons.listInstallations': () =>
          installations(
            installed
              ? [
                  {
                    nodeId: 'hub',
                    isHub: true,
                    isOnline: true,
                    version: '0.2.162',
                    source: 'live',
                  },
                  {
                    nodeId: 'agent-1',
                    isHub: false,
                    isOnline: false,
                    version: null,
                    source: 'recorded',
                  },
                ]
              : [],
          ),
      }),
      packument,
    )
    const dry = dryRunOf(await installAddon(hub.ctx, { packageName: PKG }, undefined))
    expect(writes(hub.calls)).toHaveLength(0)
    const done = await installAddon(hub.ctx, { packageName: PKG }, dry.token)
    expect(writes(hub.calls)).toHaveLength(1)
    expect(writes(hub.calls)[0]).toMatchObject({
      path: 'addons.installPackage',
      input: { packageName: PKG },
    })
    expect(done).toMatchObject({
      status: 'executed',
      result: {
        hub: 'present',
        followUp: expect.stringContaining('ops_status'),
      },
    })
  })

  it('refuses a package outside the catalog and one already on the hub', async () => {
    const hub = gatedHub(answers(), packument)
    expect(
      JSON.stringify(await installAddon(hub.ctx, { packageName: '@camstack/nope' }, undefined)),
    ).toContain('not in the addon catalog')
    const already = gatedHub(
      answers({
        'addons.listInstallations': {
          installations: [
            {
              nodeId: 'hub',
              isHub: true,
              isOnline: true,
              version: '1',
              source: 'live',
            },
          ],
          unreachable: [],
        },
      }),
      packument,
    )
    const out = await installAddon(already.ctx, { packageName: PKG }, undefined)
    expect(JSON.stringify(out)).toContain('already installed')
    expect(dryRunOf(out).token).toBeUndefined()
  })

  it('needs an admin session', async () => {
    const hub = gatedHub(answers(), packument)
    expect(
      await installAddon(await asProtectedTier(hub.ctx), { packageName: PKG }, undefined),
    ).toMatchObject({
      status: 'refused',
    })
  })
})

describe('configure_addon_update', () => {
  it('updates an addon with an available update; refuses protected, core and up-to-date ones', async () => {
    const hub = gatedHub(answers({ 'addons.updatePackage': { ok: true } }), packument)
    const reolink = '@camstack/addon-provider-reolink'
    const dry = dryRunOf(await updateAddon(hub.ctx, { packageName: reolink }, undefined))
    expect(JSON.stringify(dry.describe)).toContain('1.2.213')
    await updateAddon(hub.ctx, { packageName: reolink }, dry.token)
    expect(writes(hub.calls)[0]).toMatchObject({
      path: 'addons.updatePackage',
      input: { name: reolink },
    })
    expect(
      JSON.stringify(await updateAddon(hub.ctx, { packageName: '@camstack/system' }, undefined)),
    ).toContain('protected package')
    expect(JSON.stringify(await updateAddon(hub.ctx, { packageName: PKG }, undefined))).toContain(
      'no update available',
    )
  })
})

describe('configure_addon_uninstall', () => {
  it('refuses a protected package in the dry run, with the reason, and never writes', async () => {
    const hub = gatedHub(
      answers({
        'addons.uninstallPackage': {
          success: true,
          packageName: 'x',
          results: [],
        },
      }),
      packument,
    )
    const out = await uninstallAddon(hub.ctx, { packageName: '@camstack/system' }, undefined)
    expect(JSON.stringify(out)).toContain('protected / removable:false')
    expect(dryRunOf(out).token).toBeUndefined()
    expect(writes(hub.calls)).toHaveLength(0)
  })

  it('uninstalls on confirm and reports per node', async () => {
    const hub = gatedHub(
      answers({
        'addons.listInstallations': {
          installations: [
            {
              nodeId: 'hub',
              isHub: true,
              isOnline: true,
              version: '1.2.200',
              source: 'live',
            },
          ],
          unreachable: [],
        },
        'addons.uninstallPackage': {
          success: true,
          packageName: '@camstack/addon-provider-reolink',
          results: [
            {
              nodeId: 'hub',
              outcome: 'uninstalled',
              addonIds: [],
              runnersStopped: [],
              warnings: [],
            },
          ],
        },
      }),
      packument,
    )
    const args = { packageName: '@camstack/addon-provider-reolink' }
    const dry = dryRunOf(await uninstallAddon(hub.ctx, args, undefined))
    const done = await uninstallAddon(hub.ctx, args, dry.token)
    expect(done).toMatchObject({
      status: 'executed',
      result: {
        success: true,
        perNode: [{ nodeId: 'hub', outcome: 'uninstalled' }],
      },
    })
  })
})
