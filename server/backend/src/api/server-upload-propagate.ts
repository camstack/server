/**
 * POST /api/server-upload/propagate — deliver an already-uploaded
 * `dev-uploads/<version>/` set from the hub onto one agent, then leave
 * `applyServerUpdate` to the caller (CLI).
 *
 * Mirrors addon fan-out: pack the version dir → stage one-shot hub-http
 * ticket → `$agent.stageDevUploads`. Does NOT promote the closure.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { AddonDeploySource } from '@camstack/system'
import {
  AGENT_DEPLOY_CONTROL_TIMEOUT_MS,
  type AgentDeliveryBroker,
} from './agent-addon-delivery.js'
import { buildHubHttpSource } from './addon-upload.js'
import { isSafeDevUploadVersion, packDevUploadVersionDir } from './dev-uploads-bundle.js'
import type { ClusterBaseUrlResolver } from './hub-cluster-url.js'
import {
  authorizeUploadRequest,
  type UploadAuthAddonRegistry,
  type UploadAuthTokenVerifier,
} from './upload-auth.js'
import { devUploadVersionDir, readDevUploadManifest, serverRootDir } from '../server-root/index.js'

export interface ServerUploadPropagateLogger {
  debug(message: string, context?: { readonly meta?: Record<string, unknown> }): void
  info(message: string, context?: { readonly meta?: Record<string, unknown> }): void
  warn(message: string, context?: { readonly meta?: Record<string, unknown> }): void
  error(message: string, context?: { readonly meta?: Record<string, unknown> }): void
}

export interface ServerUploadPropagateRouteOptions {
  readonly authService: UploadAuthTokenVerifier
  readonly addonRegistry: UploadAuthAddonRegistry
  readonly logger: ServerUploadPropagateLogger
  readonly broker: AgentDeliveryBroker
  readonly resolveClusterBaseUrl: ClusterBaseUrlResolver
  /** Test override — defaults to `$CAMSTACK_DATA` (or `camstack-data`). */
  readonly dataDir?: string
}

interface PropagateBody {
  readonly version?: unknown
  readonly nodeId?: unknown
}

interface StageDevUploadsResponse {
  readonly success: boolean
  readonly version?: string
  readonly path?: string
  readonly packageCount?: number
  readonly appliedSha256?: string
}

function isStageResponse(value: unknown): value is StageDevUploadsResponse {
  if (value === null || typeof value !== 'object') return false
  return typeof (value as StageDevUploadsResponse).success === 'boolean'
}

function readBody(value: unknown): { version: string; nodeId: string } | { error: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'Expected JSON body { version, nodeId }' }
  }
  const body = value as PropagateBody
  if (typeof body.version !== 'string' || body.version.length === 0) {
    return { error: 'Missing "version" field' }
  }
  if (typeof body.nodeId !== 'string' || body.nodeId.length === 0) {
    return { error: 'Missing "nodeId" field' }
  }
  if (body.nodeId === 'hub' || body.nodeId.includes('/')) {
    return {
      error: 'nodeId must be a top-level agent id (not "hub" and not a child runner id)',
    }
  }
  if (!isSafeDevUploadVersion(body.version)) {
    return {
      error:
        `Refused: version "${body.version}" is not a safe dev-channel version ` +
        '(expected `<base>-dev.<epochSeconds>`)',
    }
  }
  return { version: body.version, nodeId: body.nodeId }
}

export function registerServerUploadPropagateRoute(
  fastify: FastifyInstance,
  options: ServerUploadPropagateRouteOptions,
): void {
  const { authService, addonRegistry, logger, broker, resolveClusterBaseUrl } = options

  fastify.post('/api/server-upload/propagate', async (request, reply) => {
    const auth = await authorizeUploadRequest({
      authHeader: request.headers.authorization,
      authService,
      addonRegistry,
    })
    if (!auth.ok) {
      return reply.status(auth.status).send({ error: auth.error })
    }

    const parsed = readBody(request.body)
    if ('error' in parsed) {
      return reply.status(400).send({ error: parsed.error })
    }
    const { version, nodeId } = parsed

    const dataDir = path.resolve(options.dataDir ?? process.env['CAMSTACK_DATA'] ?? 'camstack-data')
    const versionDir = devUploadVersionDir(serverRootDir(dataDir), version)
    if (!fs.existsSync(versionDir)) {
      return reply.status(404).send({
        error:
          `No hub-side upload for ${version} at ${versionDir}. ` +
          'Upload first with `camstack deploy-server` (POST /api/server-upload).',
      })
    }
    const manifest = readDevUploadManifest(versionDir)
    if (manifest === null) {
      return reply.status(400).send({
        error: `Hub upload for ${version} has a missing or invalid manifest.json`,
      })
    }

    let hubBaseUrl: string
    try {
      hubBaseUrl = await resolveClusterBaseUrl()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('server-upload propagate: no hub address agents can reach', {
        meta: { version, nodeId, error: message },
      })
      return reply.status(502).send({ error: `Agent propagate failed: ${message}` })
    }

    let bundle: Buffer
    let source: Extract<AddonDeploySource, { kind: 'hub-http' }>
    try {
      bundle = await packDevUploadVersionDir(versionDir)
      source = buildHubHttpSource(bundle, hubBaseUrl)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('server-upload propagate: pack/stage failed', {
        meta: { version, nodeId, error: message },
      })
      return reply.status(500).send({ error: `Failed to stage upload pack: ${message}` })
    }

    try {
      const raw = await broker.call(
        '$agent.stageDevUploads',
        { version, source },
        { nodeID: nodeId, timeout: AGENT_DEPLOY_CONTROL_TIMEOUT_MS },
      )
      if (!isStageResponse(raw) || raw.success !== true) {
        logger.warn('server-upload propagate: malformed agent response', {
          meta: { version, nodeId },
        })
        return reply.status(502).send({ error: 'Agent returned a malformed stage response' })
      }
      const applied = raw.appliedSha256
      if (applied !== undefined && applied !== source.sha256) {
        logger.error('server-upload propagate: applied hash mismatch', {
          meta: { version, nodeId, expected: source.sha256, applied },
        })
        return reply.status(502).send({
          error: `applied bundle hash mismatch (shipped ${source.sha256}, agent applied ${applied})`,
        })
      }
      logger.info('server-upload propagate: staged on agent', {
        meta: {
          version,
          nodeId,
          path: raw.path,
          packageCount: raw.packageCount,
          verifiedSha256: applied,
        },
      })
      return reply.send({
        success: true,
        version,
        nodeId,
        path: raw.path,
        packageCount: raw.packageCount ?? Object.keys(manifest.packages).length,
        verifiedSha256: applied,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('server-upload propagate: agent call failed', {
        meta: { version, nodeId, error: message },
      })
      return reply.status(502).send({ error: `Agent propagate failed: ${message}` })
    }
  })
}
