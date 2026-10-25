/**
 * Integration test for the `/api/addons/upload` route.
 *
 * Uses a real Fastify instance to exercise the multipart parser end-to-end
 * with mock dependencies for the AddonBridgeService, AuthService, and
 * MoleculerService. Verifies:
 *
 * 1. Auth enforcement (401 without token, 403 for non-admin)
 * 2. File extension validation (.tgz / .tar.gz only)
 * 3. Hub install path (nodeId = 'hub' or absent → AddonInstaller.installFromTgz)
 * 4. Agent deploy path (nodeId = 'agent-x' → moleculer.broker.call with nodeID)
 * 5. Agent failure → 502 response
 */

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import {
  AUTOMATIC_HUB_ADDRESS_FLAGS,
  type ConnectionEndpoint,
  type IScopedLogger,
  resolveHubAddressRoles,
} from '@camstack/types'
import type { FastifyInstance } from 'fastify'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAddonUploadRoute } from '../api/addon-upload.js'
import { AGENT_DEPLOY_CONTROL_TIMEOUT_MS } from '../api/agent-addon-delivery.js'
import { clusterBaseUrlResolver } from '../api/hub-cluster-url.js'
import type { AddonPackageService } from '../core/addon/addon-package.service.js'
import type { AddonRegistryService } from '../core/addon/addon-registry.service.js'
import type { AddonBridgeService } from '../core/addon-bridge/addon-bridge.service.js'
import type { AuthService } from '../core/auth/auth.service.js'
import type { MoleculerService } from '../core/moleculer/moleculer.service.js'

/**
 * Build a minimal valid addon tarball containing a `package/package.json`
 * with the given name + version. `validateTarball` on the server extracts
 * just that file via `tar -xzO`, so nothing else is needed for the happy
 * path tests. Returns a Buffer.
 */
function buildValidTarball(manifest: { name: string; version: string }): Buffer {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-tarball-'))
  try {
    fs.mkdirSync(path.join(tmpDir, 'package'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'package', 'package.json'), JSON.stringify(manifest))
    const tgz = path.join(tmpDir, 'out.tgz')
    execFileSync('tar', ['-czf', tgz, '-C', tmpDir, 'package'])
    return fs.readFileSync(tgz)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

interface MockAuthPayload {
  readonly isAdmin: boolean
}

interface FormDataLike {
  readonly file: { filename: string; content: Buffer }
  readonly nodeId?: string
  readonly addonId?: string
}

function buildMultipart(boundary: string, body: FormDataLike): Buffer {
  const parts: Buffer[] = []
  const push = (s: string) => parts.push(Buffer.from(s))
  push(`--${boundary}\r\n`)
  push(`Content-Disposition: form-data; name="file"; filename="${body.file.filename}"\r\n`)
  push('Content-Type: application/gzip\r\n\r\n')
  parts.push(body.file.content)
  push('\r\n')
  if (body.nodeId !== undefined) {
    push(`--${boundary}\r\n`)
    push('Content-Disposition: form-data; name="nodeId"\r\n\r\n')
    push(body.nodeId)
    push('\r\n')
  }
  if (body.addonId !== undefined) {
    push(`--${boundary}\r\n`)
    push('Content-Disposition: form-data; name="addonId"\r\n\r\n')
    push(body.addonId)
    push('\r\n')
  }
  push(`--${boundary}--\r\n`)
  return Buffer.concat(parts)
}

function makeAuth(kind: 'admin' | 'non-admin' | 'invalid' = 'admin'): AuthService {
  return {
    verifyToken: vi.fn(() => {
      if (kind === 'invalid') throw new Error('invalid token')
      const payload: MockAuthPayload = { isAdmin: kind === 'admin' }
      return payload
    }),
  } as unknown as AuthService
}

function makeAddonBridge(installed?: { name: string; version: string }): AddonBridgeService {
  return {
    getInstaller: vi.fn(() =>
      installed === undefined
        ? null
        : {
            installFromTgz: vi.fn(async () => installed),
          },
    ),
    reloadPackages: vi.fn(async () => {}),
  } as unknown as AddonBridgeService
}

function makeMoleculer(call: ReturnType<typeof vi.fn>): MoleculerService {
  return {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- test stub: vi.fn isn't typed against the broker's internal call shape, but the runtime contract is what we exercise
    broker: { call } as unknown as MoleculerService['broker'],
  } as unknown as MoleculerService
}

function makeAddonRegistry(): AddonRegistryService {
  return {
    // Returns an empty list — no addons currently tied to any package.
    // `installToHub` uses this to build `preInstallAddonIds`; an empty
    // result means no background `restartAddon` calls are fired.
    listAddons: vi.fn(() => []),
    // Simulates a successful filesystem scan that found no new addons.
    loadNewAddons: vi.fn(async () => ({ loaded: [] as string[], failed: [] as string[] })),
    // Not reached in the default happy-path (preInstallAddonIds is empty),
    // but stubbed for completeness and per-test overrides.
    restartAddon: vi.fn(async (_id: string) => ({ success: true })),
    // Returns a minimal cap-registry stub. `validateScopedTokenViaCap`
    // calls `getSingleton('user-management')` — returning null means no
    // singleton is mounted, so scoped-token auth is skipped. All happy-
    // path tests authenticate via the JWT path (`Bearer t` → isAdmin),
    // so this is the correct safe default.
    getCapabilityRegistry: vi.fn(() => ({
      getSingleton: vi.fn((_name: string) => null),
    })),
  } as unknown as AddonRegistryService
}

function makeAddonPackageService(): AddonPackageService {
  // `restartServer` is exercised only by the framework-package branch; the
  // default happy-path tests deploy a regular addon and never call it.
  return {
    restartServer: vi.fn((_requestedBy?: string) => {}),
  } as unknown as AddonPackageService
}

function makeLogger(): IScopedLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: IScopedLogger) {
      return this
    }),
    withTags: vi.fn(function (this: IScopedLogger) {
      return this
    }),
  } as unknown as IScopedLogger
}

const HUB_LAN: ConnectionEndpoint = {
  label: 'LAN — en0',
  baseUrl: 'https://192.0.2.10:4443',
  kind: 'lan-ipv4',
  interfaceKind: 'lan',
  plausible: true,
  plausibleReason: '',
  priority: 0,
}
const HUB_LOOPBACK: ConnectionEndpoint = {
  label: 'Loopback',
  baseUrl: 'https://127.0.0.1:4443',
  kind: 'loopback',
  interfaceKind: 'loopback',
  plausible: false,
  plausibleReason: 'Loopback',
  priority: 1000,
}

async function makeServer(opts: {
  auth: AuthService
  bridge: AddonBridgeService
  moleculer: MoleculerService
  addonRegistry?: AddonRegistryService
  addonPackageService?: AddonPackageService
  logger?: IScopedLogger
  /** What the hub's `local-network` palette advertises. Default: one LAN address. */
  clusterEndpoints?: readonly ConnectionEndpoint[]
}): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false })
  await registerAddonUploadRoute(
    fastify,
    opts.bridge,
    opts.auth,
    opts.moleculer,
    opts.addonRegistry ?? makeAddonRegistry(),
    opts.addonPackageService ?? makeAddonPackageService(),
    opts.logger ?? makeLogger(),
    clusterBaseUrlResolver(() => {
      const endpoints = opts.clusterEndpoints ?? [HUB_LAN]
      const flags = AUTOMATIC_HUB_ADDRESS_FLAGS
      return {
        getAddresses: async () => ({
          rows: [],
          roles: resolveHubAddressRoles(endpoints, endpoints, flags),
          appLinkHub: null,
        }),
      }
    }),
  )
  await fastify.ready()
  return fastify
}

const TGZ_BOUNDARY = '----vitestboundary'
const VALID_TARBALL = buildValidTarball({ name: 'addon-x', version: '1.0.0' })
const INVALID_TARBALL = Buffer.from('fake-not-a-tarball')

describe('POST /api/addons/upload', () => {
  let fastify: FastifyInstance | null = null

  afterEach(async () => {
    if (fastify) {
      await fastify.close()
      fastify = null
    }
  })

  describe('auth', () => {
    beforeEach(async () => {
      fastify = await makeServer({
        auth: makeAuth('admin'),
        bridge: makeAddonBridge({ name: 'addon-x', version: '1.0.0' }),
        moleculer: makeMoleculer(vi.fn()),
      })
    })

    it('returns 401 when Authorization header is missing', async () => {
      const res = await fastify!.inject({
        method: 'POST',
        url: '/api/addons/upload',
        headers: { 'content-type': `multipart/form-data; boundary=${TGZ_BOUNDARY}` },
        payload: buildMultipart(TGZ_BOUNDARY, {
          file: { filename: 'addon-x.tgz', content: VALID_TARBALL },
        }),
      })
      expect(res.statusCode).toBe(401)
    })

    it('returns 403 when token is not admin', async () => {
      await fastify!.close()
      fastify = await makeServer({
        auth: makeAuth('non-admin'),
        bridge: makeAddonBridge({ name: 'addon-x', version: '1.0.0' }),
        moleculer: makeMoleculer(vi.fn()),
      })
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/addons/upload',
        headers: {
          'content-type': `multipart/form-data; boundary=${TGZ_BOUNDARY}`,
          authorization: 'Bearer token',
        },
        payload: buildMultipart(TGZ_BOUNDARY, {
          file: { filename: 'addon-x.tgz', content: VALID_TARBALL },
        }),
      })
      expect(res.statusCode).toBe(403)
    })
  })

  it('returns 400 when filename is not a tarball', async () => {
    fastify = await makeServer({
      auth: makeAuth('admin'),
      bridge: makeAddonBridge({ name: 'addon-x', version: '1.0.0' }),
      moleculer: makeMoleculer(vi.fn()),
    })
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/addons/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${TGZ_BOUNDARY}`,
        authorization: 'Bearer t',
      },
      payload: buildMultipart(TGZ_BOUNDARY, {
        file: { filename: 'evil.exe', content: VALID_TARBALL },
      }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('routes to hub installer when nodeId is absent', async () => {
    // Hub install writes a `.install-source` marker into
    // `${CAMSTACK_DATA}/addons/<addonName>/`. Point CAMSTACK_DATA at an
    // isolated temp dir for the test so the side effect doesn't escape.
    const tmpRoot = await import('node:fs/promises').then((fsp) =>
      fsp.mkdtemp('/tmp/camstack-upload-test-'),
    )
    const previous = process.env['CAMSTACK_DATA']
    process.env['CAMSTACK_DATA'] = tmpRoot
    const fsSync = await import('node:fs')
    fsSync.mkdirSync(`${tmpRoot}/addons/addon-x`, { recursive: true })

    try {
      const bridge = makeAddonBridge({ name: 'addon-x', version: '2.0.0' })
      fastify = await makeServer({
        auth: makeAuth('admin'),
        bridge,
        moleculer: makeMoleculer(vi.fn()),
      })
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/addons/upload',
        headers: {
          'content-type': `multipart/form-data; boundary=${TGZ_BOUNDARY}`,
          authorization: 'Bearer t',
        },
        payload: buildMultipart(TGZ_BOUNDARY, {
          file: { filename: 'addon-x.tgz', content: VALID_TARBALL },
        }),
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        success: boolean
        target: string
        packageName: string
        version: string
      }
      expect(body).toMatchObject({
        success: true,
        target: 'hub',
        packageName: 'addon-x',
        version: '2.0.0',
      })
    } finally {
      if (previous === undefined) delete process.env['CAMSTACK_DATA']
      else process.env['CAMSTACK_DATA'] = previous
      fsSync.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('restarts the server (not an in-process reload) when a framework package is deployed', async () => {
    // @camstack/system ships hub builtins that can't hot-reload in place — the
    // upload path must call restartServer() and SKIP the per-addon restartAddon.
    const tmpRoot = await import('node:fs/promises').then((fsp) =>
      fsp.mkdtemp('/tmp/camstack-upload-fw-'),
    )
    const previous = process.env['CAMSTACK_DATA']
    process.env['CAMSTACK_DATA'] = tmpRoot
    const fsSync = await import('node:fs')
    fsSync.mkdirSync(`${tmpRoot}/addons/@camstack/system`, { recursive: true })

    try {
      const restartServer = vi.fn((_requestedBy?: string) => {})
      const restartAddon = vi.fn(async (_id: string) => ({ success: true }))
      const registry = {
        listAddons: vi.fn(() => [
          { manifest: { id: 'sqlite-settings', packageName: '@camstack/system' } },
        ]),
        loadNewAddons: vi.fn(async () => ({ loaded: [] as string[], failed: [] as string[] })),
        restartAddon,
        getCapabilityRegistry: vi.fn(() => ({ getSingleton: vi.fn((_n: string) => null) })),
      } as unknown as AddonRegistryService
      const pkgSvc = { restartServer } as unknown as AddonPackageService

      fastify = await makeServer({
        auth: makeAuth('admin'),
        bridge: makeAddonBridge({ name: '@camstack/system', version: '9.9.9' }),
        moleculer: makeMoleculer(vi.fn()),
        addonRegistry: registry,
        addonPackageService: pkgSvc,
      })
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/addons/upload',
        headers: {
          'content-type': `multipart/form-data; boundary=${TGZ_BOUNDARY}`,
          authorization: 'Bearer t',
        },
        payload: buildMultipart(TGZ_BOUNDARY, {
          file: {
            filename: 'camstack-core-9.9.9.tgz',
            content: buildValidTarball({ name: '@camstack/system', version: '9.9.9' }),
          },
        }),
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ success: true, requiresRestart: true, restarting: true })
      expect(restartServer).toHaveBeenCalledOnce()
      // Critical: the in-process restart that breaks builtins must NOT run.
      expect(restartAddon).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env['CAMSTACK_DATA']
      else process.env['CAMSTACK_DATA'] = previous
      fsSync.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('routes to $agent.deploy when nodeId is provided', async () => {
    const call = vi.fn(async () => ({
      success: true,
      addonId: 'addon-x',
      path: '/agent/addons/addon-x',
    }))
    fastify = await makeServer({
      auth: makeAuth('admin'),
      bridge: makeAddonBridge(),
      moleculer: makeMoleculer(call),
    })
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/addons/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${TGZ_BOUNDARY}`,
        authorization: 'Bearer t',
      },
      payload: buildMultipart(TGZ_BOUNDARY, {
        file: { filename: 'addon-x-1.2.3.tgz', content: VALID_TARBALL },
        nodeId: 'agent-onvif',
        addonId: 'addon-x',
      }),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { success: boolean; target: string; addonId: string; path: string }
    expect(body.target).toBe('agent-onvif')
    expect(body.addonId).toBe('addon-x')

    expect(call).toHaveBeenCalledWith(
      '$agent.deploy',
      expect.objectContaining({
        addonId: 'addon-x',
        source: expect.objectContaining({ kind: 'hub-http', bytes: VALID_TARBALL.length }),
      }),
      // The CONSTANT, not the number. This asserted `30_000` and went red when
      // D464 raised it to 300 s — the literal pinned a value whose whole point
      // was that it was wrong, and said nothing about the behaviour under test.
      { nodeID: 'agent-onvif', timeout: AGENT_DEPLOY_CONTROL_TIMEOUT_MS },
    )
  })

  /**
   * The agent pulls the bundle from the URL in the source descriptor. That URL
   * was `CAMSTACK_HUB_PUBLIC_URL ?? 'https://127.0.0.1:4443'`, so a hub without
   * the variable (every Mac hub) sent the agent to its OWN loopback. It now
   * comes from the `local-network` palette — with the variable absent.
   */
  it('hands the agent the hub LAN address, never loopback', async () => {
    const previous = process.env['CAMSTACK_HUB_PUBLIC_URL']
    delete process.env['CAMSTACK_HUB_PUBLIC_URL']
    try {
      const call = vi.fn(async (action: string, _payload: unknown) =>
        action === '$agent.reload'
          ? { loaded: ['addon-x'] }
          : { success: true, addonId: 'addon-x', path: '/agent/addons/addon-x' },
      )
      fastify = await makeServer({
        auth: makeAuth('admin'),
        bridge: makeAddonBridge(),
        moleculer: makeMoleculer(call),
        clusterEndpoints: [HUB_LOOPBACK, HUB_LAN],
      })
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/addons/upload',
        headers: {
          'content-type': `multipart/form-data; boundary=${TGZ_BOUNDARY}`,
          authorization: 'Bearer t',
        },
        payload: buildMultipart(TGZ_BOUNDARY, {
          file: { filename: 'addon-x-1.2.3.tgz', content: VALID_TARBALL },
          nodeId: 'agent-onvif',
          addonId: 'addon-x',
        }),
      })
      expect(res.statusCode).toBe(200)
      const deploy = call.mock.calls.find(([action]) => action === '$agent.deploy')
      const payload: unknown = deploy?.[1]
      const url =
        typeof payload === 'object' &&
        payload !== null &&
        'source' in payload &&
        typeof payload.source === 'object' &&
        payload.source !== null &&
        'url' in payload.source &&
        typeof payload.source.url === 'string'
          ? payload.source.url
          : ''
      expect(new URL(url).origin).toBe('https://192.0.2.10:4443')
    } finally {
      if (previous !== undefined) process.env['CAMSTACK_HUB_PUBLIC_URL'] = previous
    }
  })

  it('refuses the deploy with a reason when the hub has no address an agent can reach', async () => {
    const call = vi.fn(async () => ({ success: true, addonId: 'addon-x' }))
    fastify = await makeServer({
      auth: makeAuth('admin'),
      bridge: makeAddonBridge(),
      moleculer: makeMoleculer(call),
      clusterEndpoints: [HUB_LOOPBACK],
    })
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/addons/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${TGZ_BOUNDARY}`,
        authorization: 'Bearer t',
      },
      payload: buildMultipart(TGZ_BOUNDARY, {
        file: { filename: 'addon-x-1.2.3.tgz', content: VALID_TARBALL },
        nodeId: 'agent-onvif',
        addonId: 'addon-x',
      }),
    })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({ error: expect.stringMatching(/no reachable LAN address/) })
    expect(call).not.toHaveBeenCalled()
  })

  /**
   * The single-node deploy used to stop at `$agent.deploy`. The bundle landed,
   * the route answered 200, the CLI printed `✓` — and the node went on running
   * the previous dist because nothing ever asked it to load the new one.
   * Confirmed live on agent-a 2026-08-07 (marker file present in `dist/`,
   * zero runner pids recycled). This test fails against that code.
   */
  it('reloads the named agent — a bundle on disk is not a deploy', async () => {
    const call = vi.fn(async (action: string) =>
      action === '$agent.reload'
        ? { loaded: ['pipeline-runner', 'stream-broker'] }
        : { success: true, addonId: 'addon-x', path: '/agent/addons/addon-x' },
    )
    fastify = await makeServer({
      auth: makeAuth('admin'),
      bridge: makeAddonBridge(),
      moleculer: makeMoleculer(call),
    })
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/addons/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${TGZ_BOUNDARY}`,
        authorization: 'Bearer t',
      },
      payload: buildMultipart(TGZ_BOUNDARY, {
        file: { filename: 'addon-x-1.2.3.tgz', content: VALID_TARBALL },
        nodeId: 'agent-onvif',
        addonId: 'addon-x',
      }),
    })

    expect(res.statusCode).toBe(200)
    expect(call).toHaveBeenCalledWith(
      '$agent.reload',
      {},
      { nodeID: 'agent-onvif', timeout: 60_000 },
    )
    // …and the response says what came back up, so the CLI can print evidence.
    const body = res.json() as { reloaded: readonly string[] }
    expect(body.reloaded).toEqual(['pipeline-runner', 'stream-broker'])
  })

  /**
   * The hash gate. An agent that unpacked bytes other than the ones this deploy
   * staged is the "stale cached tarball" failure this defect class was blamed
   * on; it must be an error, never a `✓`.
   */
  it('refuses the deploy when the agent applied a different bundle hash', async () => {
    const call = vi.fn(async (action: string) =>
      action === '$agent.reload'
        ? { loaded: ['x'] }
        : { success: true, addonId: 'addon-x', appliedSha256: 'f'.repeat(64) },
    )
    fastify = await makeServer({
      auth: makeAuth('admin'),
      bridge: makeAddonBridge(),
      moleculer: makeMoleculer(call),
    })
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/addons/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${TGZ_BOUNDARY}`,
        authorization: 'Bearer t',
      },
      payload: buildMultipart(TGZ_BOUNDARY, {
        file: { filename: 'addon-x-1.2.3.tgz', content: VALID_TARBALL },
        nodeId: 'agent-onvif',
      }),
    })

    expect(res.statusCode).toBe(502)
    expect((res.json() as { error: string }).error).toMatch(/hash mismatch/i)
    expect(call).not.toHaveBeenCalledWith('$agent.reload', expect.anything(), expect.anything())
  })

  it('returns 502 when $agent.deploy throws', async () => {
    const call = vi.fn(async () => {
      throw new Error('agent unreachable')
    })
    fastify = await makeServer({
      auth: makeAuth('admin'),
      bridge: makeAddonBridge(),
      moleculer: makeMoleculer(call),
    })
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/addons/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${TGZ_BOUNDARY}`,
        authorization: 'Bearer t',
      },
      payload: buildMultipart(TGZ_BOUNDARY, {
        file: { filename: 'addon-x.tgz', content: VALID_TARBALL },
        nodeId: 'agent-onvif',
      }),
    })
    expect(res.statusCode).toBe(502)
    const body = res.json() as { error: string }
    expect(body.error).toMatch(/agent unreachable/)
  })

  it('uses manifest.name as addonId fallback when client omits the hint', async () => {
    const call = vi.fn(async () => ({ success: true, addonId: 'addon-foo' }))
    const tarball = buildValidTarball({ name: 'addon-foo', version: '1.2.3' })
    fastify = await makeServer({
      auth: makeAuth('admin'),
      bridge: makeAddonBridge(),
      moleculer: makeMoleculer(call),
    })
    await fastify.inject({
      method: 'POST',
      url: '/api/addons/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${TGZ_BOUNDARY}`,
        authorization: 'Bearer t',
      },
      payload: buildMultipart(TGZ_BOUNDARY, {
        // Filename is intentionally different from manifest.name to prove
        // that the server reads the manifest, not the filename.
        file: { filename: 'unrelated-name-9.tgz', content: tarball },
        nodeId: 'agent-onvif',
      }),
    })
    expect(call).toHaveBeenCalledWith(
      '$agent.deploy',
      expect.objectContaining({ addonId: 'addon-foo' }),
      expect.anything(),
    )
  })

  it('returns 400 when the tarball has no valid package.json', async () => {
    fastify = await makeServer({
      auth: makeAuth('admin'),
      bridge: makeAddonBridge(),
      moleculer: makeMoleculer(vi.fn()),
    })
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/addons/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${TGZ_BOUNDARY}`,
        authorization: 'Bearer t',
      },
      payload: buildMultipart(TGZ_BOUNDARY, {
        file: { filename: 'bogus.tgz', content: INVALID_TARBALL },
      }),
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as { error: string }
    expect(body.error).toMatch(/package\.json/)
  })
})

/**
 * The multipart field-order defect, reproduced by CHUNKING the body.
 *
 * `data.fields` is the plugin's live busboy body: a field that trails the file
 * part is not in it when `request.file()` resolves. With `fastify.inject` and a
 * single-buffer payload the whole body is parsed at once, so every existing
 * test passed — and a 4.9 MB `camstack deploy -n agent-a` on the real hub
 * read `nodeId = null`, took the HUB branch and never addressed the agent. It
 * reproduced 4× on 2026-08-07 and was diagnosed as a stale dist on a node that
 * had never been sent anything.
 *
 * Streaming the parts separately is what makes this test able to fail.
 */
describe('POST /api/addons/upload — a nodeId that arrives after the file', () => {
  let streamFastify: FastifyInstance | undefined

  afterEach(async () => {
    await streamFastify?.close()
    streamFastify = undefined
  })

  it('still routes to the named agent (the field is read after the file is drained)', async () => {
    const call = vi.fn(async (action: string) =>
      action === '$agent.reload'
        ? { loaded: ['addon-x'] }
        : { success: true, addonId: 'addon-x', path: '/agent/addons/addon-x' },
    )
    streamFastify = await makeServer({
      auth: makeAuth('admin'),
      bridge: makeAddonBridge(),
      moleculer: makeMoleculer(call),
    })

    const boundary = TGZ_BOUNDARY
    const CRLF = '\r\n'
    const head = Buffer.from(
      `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="file"; filename="addon-x-1.2.3.tgz"${CRLF}` +
        `Content-Type: application/gzip${CRLF}${CRLF}`,
    )
    const tail = Buffer.from(
      `${CRLF}--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="nodeId"${CRLF}${CRLF}agent-onvif${CRLF}` +
        `--${boundary}--${CRLF}`,
    )
    // Deliver the trailing field on a LATER tick, exactly as a real socket does
    // with a multi-megabyte file part in front of it.
    const payload = new Readable({ read() {} })
    payload.push(head)
    payload.push(VALID_TARBALL)
    setTimeout(() => {
      payload.push(tail)
      payload.push(null)
    }, 20)

    const res = await streamFastify.inject({
      method: 'POST',
      url: '/api/addons/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        authorization: 'Bearer t',
      },
      payload,
    })

    expect(res.statusCode).toBe(200)
    expect((res.json() as { target: string }).target).toBe('agent-onvif')
    expect(call).toHaveBeenCalledWith(
      '$agent.deploy',
      expect.anything(),
      expect.objectContaining({ nodeID: 'agent-onvif' }),
    )
  })
})
