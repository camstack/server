import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ARTIFACTS_MEDIA_LOCATION } from '../artifact-store.js'

/**
 * The shared `artifacts` class (notification artifacts + recording exports —
 * operator 2026-09-04: one generic class, not one per producer) is a
 * SINGLETON by declaration, and the declaration is what ARMS the
 * enforcement: `upsertLocation` refuses a second location of a
 * `cardinality: 'single'` type, and the admin UI renders "Add" only for
 * `multi`. A singleton that is only a convention becomes two locations the
 * first time someone clicks twice, and then the shelf is split across roots
 * with no drain to reunite it (D341). This spec pins the manifest so the
 * declaration cannot silently flip or vanish; the recorder's twin spec pins
 * the other declarer and their agreement.
 *
 * `defaultRoot: 'media'` is pinned too: the class must seed under the
 * declared media mount (`CAMSTACK_MEDIA_ROOT`) out of the box — never the
 * addon data dir, and never a path needing a new template mount.
 */
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

function loadDeclarations(): readonly ManifestStorageLocation[] {
  const raw: unknown = JSON.parse(
    readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
  )
  const addons = (raw as { camstack?: { addons?: readonly ManifestAddonEntry[] } }).camstack?.addons
  const analytics = addons?.find((a) => a.id === 'pipeline-analytics')
  return analytics?.storageLocations ?? []
}

describe('artifacts declaration', () => {
  it('declares the shared class as a media-rooted SINGLETON', () => {
    const decl = loadDeclarations().find((d) => d.id === ARTIFACTS_MEDIA_LOCATION)
    expect(decl).toBeDefined()
    expect(decl?.cardinality).toBe('single')
    expect(decl?.defaultRoot).toBe('media')
    expect(decl?.defaultsTo).toBeUndefined()
  })

  it('never shares eventMedia — an eventMedia drain moves rows, and artifacts have none', () => {
    expect(ARTIFACTS_MEDIA_LOCATION).toBe('artifacts')
    expect(ARTIFACTS_MEDIA_LOCATION).not.toBe('eventMedia')
  })
})
