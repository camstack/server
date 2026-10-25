import { describe, expect, it } from 'vitest'
import type { ModelCatalogEntry } from '@camstack/types'
// eslint-disable-next-line no-restricted-imports -- the revision rule is the downloader's (build-time dep, as in provider.ts)
import { resolveFormatRevision } from '@camstack/system/addon-utils'
import * as catalogs from '../registry/model-catalogs.js'

// D744 — every artefact on the CamStack mirror carries a revision (the sha256
// of its weight file, generated from the mirror into the downloader's table),
// so ANY in-place replacement reaches the nodes that hold the old bytes. The
// YOLO26 @320/@256 CoreML packages were replaced in place under D742 (a
// batch-flexible export aborted every process that loaded it) before
// revisions existed; these values are the mirror's `lfs.oid` of each
// package's weight.bin after that replacement.
const MIRROR = 'https://huggingface.co/camstack/camstack-models/resolve/main/'

const YOLO26_STATIC_COREML: Readonly<Record<string, string>> = {
  'yolo26n-320': 'b30bb5ced9c127f0a813c7740c451a1766226dde43e277e01eb9d298d44f17cd',
  'yolo26n-256': '1c0565e40b4e04194561df09de4c007ccedd4d5d784adf2341f3af7c97f42cb9',
  'yolo26s-320': '156d8db8d1f2b9d6bc23ce2e123889d6ad79a5ce866dfccc35c0d869df79db64',
  'yolo26s-256': 'e4f3ba3ba99d9a068c4e064fd74427b8a2b56c5e1f56f56979886a493068fbd0',
  'yolo26m-320': '4cf582bf1b14fb7abf87f61a1cf198ad2626fedec32873224bc6f2411e6680b7',
  'yolo26m-256': 'bf1ac4cb5f2a3749815a36dde6d6e57ce0662a005ccefd435283d4e38c21298d',
  'yolo26l-320': 'f0a136258aa69978f5647e07ac4019a4f8c8745dc6d6500c8e3a2876d041f9e5',
  'yolo26l-256': '87968708ab7ee99aac97d1d6644f6b70149b7b2c38b3f2c3c64326c3cc2333e2',
}

function isEntryArray(value: unknown): value is readonly ModelCatalogEntry[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === 'object' && v !== null && 'id' in v && 'formats' in v)
  )
}

const ALL = Object.values(catalogs).filter(isEntryArray).flat()

describe('hosted catalog revisions (D744)', () => {
  it.each(
    Object.keys(YOLO26_STATIC_COREML),
  )('%s CoreML (replaced in place under D742) resolves its static package revision', (id) => {
    const coreml = catalogs.OBJECT_DETECTION_MODELS.find((m) => m.id === id)?.formats.coreml
    expect(coreml?.url).toMatch(
      /\/objectDetection\/yolo26\/coreml\/camstack-yolo26[nsml]-(320|256)\.mlpackage$/,
    )
    expect(coreml === undefined ? undefined : resolveFormatRevision(coreml)).toBe(
      YOLO26_STATIC_COREML[id],
    )
  })

  it('every format hosted on the mirror resolves a sha256 revision, and none sets one inline', () => {
    const hosted = ALL.flatMap((entry) =>
      Object.entries(entry.formats).flatMap(([format, f]) =>
        f !== undefined && f.url.startsWith(MIRROR) ? [{ key: `${entry.id}/${format}`, f }] : [],
      ),
    )
    expect(hosted.length).toBeGreaterThan(100)
    const missing = hosted.filter(({ f }) => !/^[0-9a-f]{64}$/.test(resolveFormatRevision(f) ?? ''))
    expect(missing.map((h) => h.key)).toEqual([])
    expect(hosted.filter(({ f }) => f.revision !== undefined).map((h) => h.key)).toEqual([])
  })
})
