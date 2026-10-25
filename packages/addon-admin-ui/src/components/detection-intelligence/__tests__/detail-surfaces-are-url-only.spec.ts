/**
 * No admin-UI surface pulls media BYTES over tRPC.
 *
 * ## Why a source guard and not a render test
 *
 * The failure this prevents is not a wrong pixel, it is a payload — and a
 * payload is invisible to a render assertion. `EventDetailPanel` rendered
 * correctly for months while calling `getEventMedia`, whose native-resolution
 * `fullFrameBoxed` measured 2 824 077 B (≈3.8 MB base64) per open, and threw
 * every byte away: its own docblock said the bytes were "never read for
 * rendering". A mounted test would have been green throughout.
 *
 * The track DETAIL modal is the surface most at risk of regressing here,
 * because it is the one that legitimately shows the BIG kinds (`keyFrame`,
 * `fullFrame`, `firstFrame`, `lastFrame`) — which makes "it needs the bytes
 * anyway" a plausible-sounding and wrong argument. It does not: it needs the
 * IMAGES, and an `<img>` off the `event-media` plane gets them cached,
 * parallel, streamable and `immutable`, none of which base64 can do.
 *
 * So the guard is on the CALL, which is the thing that costs.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `packages/addon-admin-ui/src`, found from wherever vitest was started.
 *
 * This suite is run BOTH ways: `npx vitest run packages/addon-admin-ui` from
 * the repo root, and `npm run test -w packages/addon-admin-ui` from the
 * package. A single cwd-relative literal is therefore wrong under one of them
 * — the first version of this file was, and it threw ENOENT instead of
 * failing usefully.
 *
 * `import.meta.url` is not available either: the admin-ui run is a jsdom
 * environment, where it is not a `file:` URL and `fileURLToPath` throws.
 *
 * So: walk up from cwd looking for the package, and try the package's own
 * `src` first for the in-package run. `findSrcRoot` returning null is itself
 * asserted below — an anchor that finds nothing must fail, never pass vacuously.
 */
function findSrcRoot(): string | null {
  let dir = process.cwd()
  for (;;) {
    const inPackage = join(dir, 'src', 'components', 'detection-intelligence')
    if (existsSync(inPackage)) return join(dir, 'src')
    const fromRoot = join(dir, 'packages', 'addon-admin-ui', 'src')
    if (existsSync(fromRoot)) return fromRoot
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const SRC_ROOT = findSrcRoot() ?? resolve(process.cwd(), 'packages/addon-admin-ui/src')

/** The byte-bearing media reads. Each has a manifest twin that answers the
 *  same question without opening a blob. */
const BYTE_BEARING_HOOKS: readonly string[] = [
  'usePipelineAnalyticsGetTrackMedia',
  'usePipelineAnalyticsGetEventMedia',
]

function sourceFiles(dir: string): readonly string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'generated' || entry === 'node_modules') continue
      out.push(...sourceFiles(full))
      continue
    }
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full)
  }
  return out
}

describe('admin UI media reads', () => {
  it('finds the source tree it is guarding', () => {
    // Without this, a bad SRC_ROOT makes every assertion below vacuously true.
    const files = sourceFiles(SRC_ROOT)
    expect(files.length).toBeGreaterThan(50)
    expect(files.some((f) => f.endsWith('EventDetailPanel.tsx'))).toBe(true)
  })

  it('never calls a byte-bearing media hook', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC_ROOT)) {
      const src = readFileSync(file, 'utf8')
      for (const hook of BYTE_BEARING_HOOKS) {
        if (src.includes(hook)) offenders.push(`${file.slice(SRC_ROOT.length)} → ${hook}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the track detail modal reads BOTH halves of its filmstrip as manifests', () => {
    // Named explicitly: this is the heaviest surface and the one whose
    // regression would be argued for.
    const src = readFileSync(
      join(SRC_ROOT, 'components/detection-intelligence/EventDetailPanel.tsx'),
      'utf8',
    )
    expect(src).toContain('usePipelineAnalyticsListTrackMedia')
    expect(src).toContain('usePipelineAnalyticsListEventMedia')
  })
})
