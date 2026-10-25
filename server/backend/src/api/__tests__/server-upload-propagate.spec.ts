/**
 * POST /api/server-upload/propagate
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  writeDevUploadManifest,
  serverRootDir,
  devUploadVersionDir,
} from '../../server-root/index.js'
import { registerServerUploadPropagateRoute } from '../server-upload-propagate'
import type { UploadAuthAddonRegistry, UploadAuthTokenVerifier } from '../upload-auth'

const ADMIN_TOKEN = 'good-admin-jwt'
const VERSION = '1.2.500-dev.1791665601'

const stubVerifier: UploadAuthTokenVerifier = {
  verifyToken: (token) => {
    if (token === ADMIN_TOKEN) return { isAdmin: true }
    throw new Error('invalid token')
  },
  verifyCredentialToken: () => {
    throw new Error('not a minted token')
  },
}

const stubAddonRegistry: UploadAuthAddonRegistry = {
  getCapabilityRegistry: () => ({ getSingleton: () => null }),
}

function silentLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }
}

let tmp: string
let dataDir: string
let app: FastifyInstance

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'server-upload-propagate-'))
  dataDir = path.join(tmp, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  app = Fastify()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function seedHubUpload(): void {
  const versionDir = devUploadVersionDir(serverRootDir(dataDir), VERSION)
  fs.mkdirSync(versionDir, { recursive: true })
  fs.writeFileSync(path.join(versionDir, 'camstack-server.tgz'), Buffer.from('S'))
  writeDevUploadManifest(versionDir, {
    version: VERSION,
    packages: { '@camstack/server': 'camstack-server.tgz' },
  })
}

describe('POST /api/server-upload/propagate', () => {
  it('404 when the hub has no upload for the version', async () => {
    registerServerUploadPropagateRoute(app, {
      authService: stubVerifier,
      addonRegistry: stubAddonRegistry,
      logger: silentLogger(),
      broker: { call: vi.fn() },
      resolveClusterBaseUrl: async () => 'https://hub.example:4443',
      dataDir,
    })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/api/server-upload/propagate',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { version: VERSION, nodeId: 'agent-a' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('calls $agent.stageDevUploads with a hub-http source', async () => {
    seedHubUpload()
    const broker = {
      call: vi.fn(async (_action: string, params: { source?: { sha256?: string } }) => ({
        success: true,
        version: VERSION,
        path: `/data/server-root/dev-uploads/${VERSION}`,
        packageCount: 1,
        appliedSha256: params.source?.sha256,
      })),
    }
    registerServerUploadPropagateRoute(app, {
      authService: stubVerifier,
      addonRegistry: stubAddonRegistry,
      logger: silentLogger(),
      broker,
      resolveClusterBaseUrl: async () => 'https://hub.example:4443',
      dataDir,
    })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/api/server-upload/propagate',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { version: VERSION, nodeId: 'agent-a' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { success: boolean; nodeId: string }
    expect(body.success).toBe(true)
    expect(body.nodeId).toBe('agent-a')
    expect(broker.call).toHaveBeenCalledWith(
      '$agent.stageDevUploads',
      expect.objectContaining({
        version: VERSION,
        source: expect.objectContaining({ kind: 'hub-http' }),
      }),
      expect.objectContaining({ nodeID: 'agent-a' }),
    )
  })

  it('401 without auth', async () => {
    registerServerUploadPropagateRoute(app, {
      authService: stubVerifier,
      addonRegistry: stubAddonRegistry,
      logger: silentLogger(),
      broker: { call: vi.fn() },
      resolveClusterBaseUrl: async () => 'https://hub.example:4443',
      dataDir,
    })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/api/server-upload/propagate',
      payload: { version: VERSION, nodeId: 'x' },
    })
    expect(res.statusCode).toBe(401)
  })
})
