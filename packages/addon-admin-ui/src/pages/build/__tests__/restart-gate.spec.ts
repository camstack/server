/**
 * The one gate that stops a restart from lying.
 *
 * `Restart` runs whatever the SERVER stored. If the editor holds unsaved code,
 * pressing it restarts the previous source while the operator watches the new
 * source on screen — and the process comes up green, so nothing anywhere says
 * the change did not take. That is the failure the Compile → Save → Restart
 * order exists to prevent, and it is the reason this file is not folded into
 * the component.
 */

import type { CoreBlock } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { restartReason } from '../restart-gate'

const block = (over: Partial<CoreBlock> = {}): CoreBlock => ({
  id: 'b1',
  name: 'Block',
  code: 'export default () => () => {}',
  enabled: true,
  placement: 'hub',
  createdAt: 1,
  updatedAt: 1,
  createdBy: 'u',
  status: 'running',
  lastChangedAt: 1,
  ...over,
})

const idle = { saving: false, restarting: false } as const

describe('restartReason', () => {
  it('allows a restart of a saved, enabled block', () => {
    expect(restartReason({ existing: block(), dirty: false, ...idle })).toBeNull()
  })

  it('REFUSES while the editor is dirty, and says why', () => {
    const reason = restartReason({ existing: block(), dirty: true, ...idle })
    expect(reason).not.toBeNull()
    expect(reason).toMatch(/SAVED code/)
  })

  it('refuses before the first save — there is no process yet', () => {
    expect(restartReason({ existing: null, dirty: true, ...idle })).toMatch(/Save the script first/)
  })

  it('refuses on a disabled block rather than pretending', () => {
    // The server refuses it too: a restart would stop nothing and start
    // nothing, so a button that appears to work is worse than one that says so.
    expect(restartReason({ existing: block({ enabled: false }), dirty: false, ...idle })).toMatch(
      /disabled/,
    )
  })

  it('reports the in-flight states rather than looking merely unavailable', () => {
    expect(
      restartReason({ existing: block(), dirty: false, saving: true, restarting: false }),
    ).toBe('Saving…')
    expect(
      restartReason({ existing: block(), dirty: false, saving: false, restarting: true }),
    ).toBe('Restarting…')
  })
})
