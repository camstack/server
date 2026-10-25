/**
 * The guard for the recursion that made this repo's publish verdicts fiction.
 *
 * `publish` is an npm lifecycle name, so `npm publish` runs it. Forty-two
 * packages defined it as `npm publish --access public`, which made the command
 * invoke itself: one upload wins, the other gets `403 cannot publish over the
 * previously published version`, and the OUTER command exits 1 with the
 * artifact already on the registry.
 */
import { describe, expect, it } from 'vitest'

import {
  recursivePublishScripts,
  PUBLISH_LIFECYCLE_NAMES,
} from '../check-no-publish-lifecycle-script.mjs'

describe('recursivePublishScripts', () => {
  it('catches the exact shape all 42 packages carried', () => {
    expect(
      recursivePublishScripts({ scripts: { publish: 'npm publish --access public' } }),
    ).toEqual(['publish'])
  })

  it('catches it under every publish lifecycle name, not just `publish`', () => {
    for (const name of PUBLISH_LIFECYCLE_NAMES) {
      expect(recursivePublishScripts({ scripts: { [name]: 'npm publish' } })).toEqual([name])
    }
  })

  // The convenience is kept — under a name npm does not treat as a hook.
  it('passes the renamed script', () => {
    expect(
      recursivePublishScripts({ scripts: { 'publish:npm': 'npm publish --access public' } }),
    ).toEqual([])
  })

  // A lifecycle hook that does something else is fine; only publishing recurses.
  it('does not flag a publish hook that builds', () => {
    expect(recursivePublishScripts({ scripts: { prepublishOnly: 'npm run build' } })).toEqual([])
  })

  it('a package with no scripts is not an offender', () => {
    expect(recursivePublishScripts({})).toEqual([])
  })
})
