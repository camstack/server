import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeDevUploadManifest, serverRootDir } from '../../server-root/index.js'
import { packDevUploadVersionDir } from '../../api/dev-uploads-bundle.js'
import { applyStageDevUploads } from '../apply-stage-dev-uploads.js'
import { unpackDevUploadVersionBundle } from '../../api/dev-uploads-bundle.js'

const VERSION = '1.2.500-dev.1791665600'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-dev-uploads-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('applyStageDevUploads', () => {
  it('fetches, unpacks, and reports appliedSha256', async () => {
    const hubRoot = path.join(tmp, 'hub')
    const versionDir = path.join(hubRoot, 'dev-uploads', VERSION)
    fs.mkdirSync(versionDir, { recursive: true })
    fs.writeFileSync(path.join(versionDir, 'camstack-server.tgz'), Buffer.from('S'))
    writeDevUploadManifest(versionDir, {
      version: VERSION,
      packages: { '@camstack/server': 'camstack-server.tgz' },
    })
    const bundle = await packDevUploadVersionDir(versionDir)
    const sha = createHash('sha256').update(bundle).digest('hex')
    const dataDir = path.join(tmp, 'agent-data')

    const result = await applyStageDevUploads(
      {
        dataDir,
        fetchBundle: vi.fn(async () => bundle),
        unpack: unpackDevUploadVersionBundle,
      },
      {
        version: VERSION,
        source: {
          kind: 'hub-http',
          url: 'https://hub/b',
          token: 't',
          sha256: sha,
          bytes: bundle.length,
        },
      },
    )

    expect(result.success).toBe(true)
    expect(result.appliedSha256).toBe(sha)
    expect(result.packageCount).toBe(1)
    expect(
      fs.existsSync(path.join(serverRootDir(dataDir), 'dev-uploads', VERSION, 'manifest.json')),
    ).toBe(true)
  })

  it('refuses a non-dev version before fetch', async () => {
    await expect(
      applyStageDevUploads(
        {
          dataDir: tmp,
          fetchBundle: vi.fn(async () => Buffer.from('x')),
          unpack: unpackDevUploadVersionBundle,
        },
        {
          version: '1.2.3',
          source: {
            kind: 'hub-http',
            url: 'https://hub/b',
            token: 't',
            sha256: 'a',
            bytes: 1,
          },
        },
      ),
    ).rejects.toThrow(/dev-channel/)
  })
})
