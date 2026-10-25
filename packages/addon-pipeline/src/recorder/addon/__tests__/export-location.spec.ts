import { describe, it, expect } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ARTIFACTS_MEDIA_LOCATION, exportOutPathFor, upsertExport } from '../export-store.js'
import { sweepExpiredExports } from '../export-janitor.js'
import { makeExportsState } from './exports-state-fixture.js'

/**
 * Exports live in the shared `artifacts` storage class (singleton, D341 —
 * operator 2026-09-04: one generic class, not one per producer),
 * DEVICE-FIRST like the notification shelf — `<root>/<deviceId>/exports/…`
 * beside `<root>/<deviceId>/nc-artifacts/…` — so one directory answers "what
 * does this camera hold" and per-device occupancy is uniform across tenants. 8.4 GB of operator-exported clips were riding
 * `addons-data/recorder/exports` — inside every system backup, invisible to
 * occupancy, on the constrained appdata disk.
 *
 * Invariants pinned here:
 * 1. The out-path derivation REFUSES a null root — an unresolved location
 *    must never fall back to the addon data dir.
 * 2. The manifest declaration is a media-rooted SINGLETON: `cardinality:
 *    'single'` is what arms `upsertLocation`'s refusal of a second location
 *    and the admin UI's multi-only "Add". Rows store no path — the file is
 *    derived from (root, deviceId, id) — so a plurality of roots is
 *    unrepresentable without a schema change; the declaration must say so.
 * 3. Both declaring addons agree on cardinality — the registry THROWS at
 *    kernel boot on a conflict, so the agreement is pinned where a PR can
 *    see it instead.
 */
describe('exportOutPathFor', () => {
  it("derives <root>/<deviceId>/exports/<id>.mp4 — the tenant's subtree inside the camera bucket", () => {
    expect(exportOutPathFor('/media/artifacts', 102, 'abc-123')).toBe(
      path.join('/media/artifacts', '102', 'exports', 'abc-123.mp4'),
    )
  })

  it('REFUSES a null root — never a fallback to the addon data dir', () => {
    expect(() => exportOutPathFor(null, 102, 'abc-123')).toThrow(/artifacts/)
  })
})

interface ManifestStorageLocation {
  readonly id: string
  readonly cardinality?: string
  readonly defaultRoot?: string
  readonly defaultsTo?: string
}
interface ManifestAddonEntry {
  readonly id: string
  readonly storageLocations?: readonly ManifestStorageLocation[]
}

function declFrom(pkgJsonPath: string, addonId: string): ManifestStorageLocation | undefined {
  const raw: unknown = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  const addons = (raw as { camstack?: { addons?: readonly ManifestAddonEntry[] } }).camstack?.addons
  return addons
    ?.find((a) => a.id === addonId)
    ?.storageLocations?.find((d) => d.id === ARTIFACTS_MEDIA_LOCATION)
}

const OWN_PKG = path.join(__dirname, '..', '..', '..', '..', 'package.json')
const POST_ANALYSIS_PKG = path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'addon-post-analysis',
  'package.json',
)

describe('artifacts declaration', () => {
  it('declares the shared class as a media-rooted SINGLETON on the recorder addon', () => {
    const decl = declFrom(OWN_PKG, 'recorder')
    expect(decl).toBeDefined()
    expect(decl?.cardinality).toBe('single')
    expect(decl?.defaultRoot).toBe('media')
    expect(decl?.defaultsTo).toBeUndefined()
  })

  it('agrees with the other declarer — a cardinality conflict THROWS at kernel boot', () => {
    const ours = declFrom(OWN_PKG, 'recorder')
    const theirs = declFrom(POST_ANALYSIS_PKG, 'pipeline-analytics')
    expect(theirs).toBeDefined()
    expect(ours?.cardinality).toBe(theirs?.cardinality)
  })

  it('is its own type — not recordings, whose sweeps must never reach a deliberate export', () => {
    expect(ARTIFACTS_MEDIA_LOCATION).toBe('artifacts')
    expect(ARTIFACTS_MEDIA_LOCATION).not.toBe('recordings')
  })
})

/**
 * The mirror of the notification shelf's isolation test: the export janitor
 * deletes only DERIVED export paths, so the `nc-artifacts/` sibling inside
 * the same camera bucket is structurally out of its reach. Sharing the
 * location must never become sharing a sweep (D341).
 */
describe('export janitor — tenant isolation', () => {
  it('sweeping an expired export never touches the nc-artifacts sibling', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifacts-root-'))
    try {
      const exportFile = exportOutPathFor(root, 101, 'e1')
      await fs.mkdir(path.dirname(exportFile), { recursive: true })
      await fs.writeFile(exportFile, Buffer.from([1]))
      const ncFile = path.join(root, '101', 'nc-artifacts', 'kept', 'x.jpg')
      await fs.mkdir(path.dirname(ncFile), { recursive: true })
      await fs.writeFile(ncFile, Buffer.from([2]))
      // The THIRD tenant: the enrolled gallery at `<root>/gallery/…` —
      // retention-exempt, and the janitor's derived paths can never name it.
      const galleryFile = path.join(root, 'gallery', '101', 'events', 'identity', 'id1', 'c.jpg')
      await fs.mkdir(path.dirname(galleryFile), { recursive: true })
      await fs.writeFile(galleryFile, Buffer.from([3]))

      const state = await makeExportsState()
      await upsertExport(state, {
        id: 'e1',
        deviceId: 101,
        profile: 'main',
        fromMs: 0,
        toMs: 10_000,
        options: { speed: 1, includeAudio: true, maxLifeMs: 1, deleteAfterDownload: false },
        state: 'ready',
        progressPct: 100,
        fileBytes: 1,
        expiresAt: 500,
        deleteAfterDownload: false,
        downloadedAt: null,
        createdAt: 1,
        createdBy: 'op',
        error: null,
      })
      const { expired } = await sweepExpiredExports(1000, {
        state,
        outPath: (rec) => exportOutPathFor(root, rec.deviceId, rec.id),
        removeFile: async (p) => {
          await fs.rm(p, { force: true })
        },
      })
      expect(expired).toEqual(['e1'])
      await expect(fs.stat(exportFile)).rejects.toThrow()
      expect(await fs.readFile(ncFile)).toEqual(Buffer.from([2]))
      expect(await fs.readFile(galleryFile)).toEqual(Buffer.from([3]))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
