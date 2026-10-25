/**
 * POST /api/server-upload — dev server-deploy channel upload route.
 *
 * Covers: auth rejection (401/403), dev-version-shape rejection, tgz
 * name/version validation (fail-closed), path-traversal refusal, and the
 * happy path (tarballs + manifest land under
 * `<dataDir>/server-root/dev-uploads/<version>/`).
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  devUploadVersionDir,
  readDevUploadManifest,
  serverRootDir,
} from '../../server-root/index.js'
import { registerServerUploadRoute, validateTarballSet } from '../server-upload'
import type { UploadAuthAddonRegistry, UploadAuthTokenVerifier } from '../upload-auth'

const ADMIN_TOKEN = 'good-admin-jwt'
const DEV_VERSION = '1.1.54-dev.1783970000'

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

function silentLogger(): {
  debug(): void
  info(): void
  warn(): void
  error(): void
} {
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'server-upload-spec-'))
  dataDir = path.join(tmp, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  app = Fastify()
  await app.register(import('@fastify/multipart'), { limits: { fileSize: 50 * 1024 * 1024 } })
  registerServerUploadRoute(app, {
    authService: stubVerifier,
    addonRegistry: stubAddonRegistry,
    logger: silentLogger(),
    dataDir,
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Build a real npm-pack-shaped tgz (package/package.json) via the tar CLI. */
function makeTgz(name: string, version: string): Buffer {
  const dir = fs.mkdtempSync(path.join(tmp, 'tgz-'))
  fs.mkdirSync(path.join(dir, 'package'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package', 'package.json'),
    JSON.stringify({ name, version }),
    'utf-8',
  )
  const out = path.join(dir, 'out.tgz')
  execFileSync('tar', ['-czf', out, '-C', dir, 'package'])
  return fs.readFileSync(out)
}

interface MultipartFilePart {
  readonly filename: string
  readonly buffer: Buffer
}

function buildMultipartBody(
  files: readonly MultipartFilePart[],
  fields: Readonly<Record<string, string>>,
): { readonly body: Buffer; readonly contentType: string } {
  const boundary = '----serveruploadspecboundary'
  const CRLF = '\r\n'
  const parts: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`,
      ),
    )
  }
  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="file"; filename="${file.filename}"${CRLF}` +
          `Content-Type: application/gzip${CRLF}${CRLF}`,
      ),
      file.buffer,
      Buffer.from(CRLF),
    )
  }
  parts.push(Buffer.from(`--${boundary}--${CRLF}`))
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

interface InjectUploadArgs {
  readonly files: readonly MultipartFilePart[]
  readonly fields: Readonly<Record<string, string>>
  readonly token?: string | null
}

async function injectUpload(args: InjectUploadArgs) {
  const { body, contentType } = buildMultipartBody(args.files, args.fields)
  return app.inject({
    method: 'POST',
    url: '/api/server-upload',
    headers: {
      'content-type': contentType,
      ...(args.token === null ? {} : { authorization: `Bearer ${args.token ?? ADMIN_TOKEN}` }),
    },
    payload: body,
  })
}

describe('POST /api/server-upload — auth', () => {
  it('401s without an authorization header', async () => {
    const res = await injectUpload({
      files: [
        { filename: 'camstack-server.tgz', buffer: makeTgz('@camstack/server', DEV_VERSION) },
      ],
      fields: { version: DEV_VERSION },
      token: null,
    })
    expect(res.statusCode).toBe(401)
  })

  it('401s a token that authenticates nobody (an unknown bearer is unauthenticated, not forbidden)', async () => {
    const res = await injectUpload({
      files: [
        { filename: 'camstack-server.tgz', buffer: makeTgz('@camstack/server', DEV_VERSION) },
      ],
      fields: { version: DEV_VERSION },
      token: 'not-a-real-token',
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('POST /api/server-upload — validation (fail-closed)', () => {
  it('rejects a version that is not dev-channel shaped', async () => {
    for (const bad of ['1.1.54', '1.1.54-rc.1', '1.1.54-dev.abc', 'latest']) {
      const res = await injectUpload({
        files: [{ filename: 'camstack-server.tgz', buffer: makeTgz('@camstack/server', bad) }],
        fields: { version: bad },
      })
      expect(res.statusCode, `version ${bad}`).toBe(400)
    }
  })

  it('rejects a version containing path separators', async () => {
    const bad = '../1.1.54-dev.1'
    const res = await injectUpload({
      files: [{ filename: 'camstack-server.tgz', buffer: makeTgz('@camstack/server', bad) }],
      fields: { version: bad },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects when the version field is missing', async () => {
    const res = await injectUpload({
      files: [
        { filename: 'camstack-server.tgz', buffer: makeTgz('@camstack/server', DEV_VERSION) },
      ],
      fields: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects when no tarballs are attached', async () => {
    const res = await injectUpload({ files: [], fields: { version: DEV_VERSION } })
    expect(res.statusCode).toBe(400)
  })

  it('refuses path-traversal filenames (validator guard, defense-in-depth)', () => {
    // @fastify/multipart normalises uploaded filenames to their basename, so a
    // traversal path never reaches the route through HTTP — the validator
    // guard is exercised directly.
    for (const evil of ['../../evil.tgz', 'a/b.tgz', 'a\\b.tgz', '..evil..tgz/../x.tgz']) {
      const result = validateTarballSet(
        [{ filename: evil, buffer: makeTgz('@camstack/server', DEV_VERSION) }],
        DEV_VERSION,
      )
      expect('error' in result, evil).toBe(true)
    }
  })

  it('never lets a traversal-attempt filename escape the dev-uploads dir over HTTP', async () => {
    const res = await injectUpload({
      files: [{ filename: '../../evil.tgz', buffer: makeTgz('@camstack/server', DEV_VERSION) }],
      fields: { version: DEV_VERSION },
    })
    // The multipart layer reduces the name to `evil.tgz`; the stored filename
    // is derived from the PACKAGE name server-side. Whatever the status, no
    // file may land outside dev-uploads/<version>/.
    expect(fs.existsSync(path.join(tmp, 'evil.tgz'))).toBe(false)
    expect(fs.existsSync(path.join(dataDir, 'evil.tgz'))).toBe(false)
    if (res.statusCode === 200) {
      const dir = devUploadVersionDir(serverRootDir(dataDir), DEV_VERSION)
      const entries = fs.readdirSync(dir).sort()
      expect(entries).toEqual(['camstack-server.tgz', 'manifest.json'])
    }
  })

  it('rejects a tarball whose package name is not @camstack-scoped', async () => {
    const res = await injectUpload({
      files: [
        { filename: 'camstack-server.tgz', buffer: makeTgz('@camstack/server', DEV_VERSION) },
        { filename: 'left-pad.tgz', buffer: makeTgz('left-pad', DEV_VERSION) },
      ],
      fields: { version: DEV_VERSION },
    })
    expect(res.statusCode).toBe(400)
    // Fail-closed: NOTHING lands on disk, not even the valid tarball.
    expect(fs.existsSync(devUploadVersionDir(serverRootDir(dataDir), DEV_VERSION))).toBe(false)
  })

  it('rejects a tarball whose version differs from the declared dev version', async () => {
    const res = await injectUpload({
      files: [{ filename: 'camstack-server.tgz', buffer: makeTgz('@camstack/server', '1.1.54') }],
      fields: { version: DEV_VERSION },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a malformed archive', async () => {
    const res = await injectUpload({
      files: [{ filename: 'camstack-server.tgz', buffer: Buffer.from('not a tgz') }],
      fields: { version: DEV_VERSION },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/server-upload — happy path', () => {
  it('stores every tarball + manifest under dev-uploads/<version>/', async () => {
    const res = await injectUpload({
      files: [
        { filename: 'camstack-server.tgz', buffer: makeTgz('@camstack/server', DEV_VERSION) },
        { filename: 'camstack-types.tgz', buffer: makeTgz('@camstack/types', DEV_VERSION) },
      ],
      fields: { version: DEV_VERSION },
    })
    expect(res.statusCode, res.payload).toBe(200)
    const parsed: unknown = JSON.parse(res.payload)
    expect(parsed).toMatchObject({ success: true, version: DEV_VERSION })

    const dir = devUploadVersionDir(serverRootDir(dataDir), DEV_VERSION)
    const manifest = readDevUploadManifest(dir)
    expect(manifest).not.toBeNull()
    expect(manifest?.version).toBe(DEV_VERSION)
    const packages = manifest?.packages ?? {}
    expect(Object.keys(packages).sort()).toEqual(['@camstack/server', '@camstack/types'])
    for (const filename of Object.values(packages)) {
      expect(fs.existsSync(path.join(dir, filename))).toBe(true)
    }
  })
})
