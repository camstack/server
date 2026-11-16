/**
 * Camera grid and Terminal camera blocks in Build-your-self (planning#580).
 * A grid is created empty and laid out on its block; a Terminal camera names
 * one Terminal, and a Terminal another block already shows is not offered.
 */
import type { CompositionListRead, CoreBlock } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { terminalCameraIndex, terminalChoices } from '../camera-block-model'
import { canSaveDraft, compileDraft, draftForPick, draftFromHelper } from '../helper-form-model'

const T1 = '3f1c2a4e-6b7d-4e8f-9a0b-1c2d3e4f5a6b'
const T2 = '9a0b1c2d-3e4f-4a6b-8c7d-6b7d3f1c2a4e'

function terminalBlock(id: string, name: string, terminalId: string): CoreBlock {
  return {
    id,
    name,
    code: '',
    enabled: true,
    placement: 'hub',
    createdAt: 1,
    updatedAt: 2,
    createdBy: 'test',
    status: 'running',
    lastChangedAt: 1,
    source: {
      kind: 'composition',
      composition: {
        target: { kind: 'new', type: DeviceType.Camera },
        features: [],
        helper: { kind: 'terminal', terminalId },
      },
    },
  }
}

function loaded(...blocks: CoreBlock[]): CompositionListRead {
  return {
    state: 'loaded',
    views: blocks.map((block, index) => ({
      block,
      state: {
        kind: 'answered',
        state: {
          blockId: block.id,
          deviceId: 4600 + index,
          status: 'running',
          fields: [],
        },
      },
    })),
  }
}

describe('the camera drafts', () => {
  it('a new grid saves with only a name, and compiles to an empty grid', () => {
    const draft = draftForPick({ kind: 'grid' })
    expect(draft).toMatchObject({ kind: 'grid', name: '' })
    if (draft === null) return
    expect(canSaveDraft(draft)).toBe(false)
    const named = { ...draft, name: 'Driveway wall' }
    expect(canSaveDraft(named)).toBe(true)
    const compiled = compileDraft(named)
    expect(compiled.ok && compiled.composition.helper).toEqual({
      kind: 'grid',
      fps: 10,
      publishedProfiles: ['mid', 'low'],
      cells: [],
    })
  })

  it('a Terminal camera needs a terminal before it saves', () => {
    const draft = draftForPick({ kind: 'terminal' })
    expect(draft).toMatchObject({ kind: 'terminal', terminalId: null })
    if (draft === null || draft.kind !== 'terminal') return
    const named = { ...draft, name: 'Hub monitor' }
    expect(canSaveDraft(named)).toBe(false)
    expect(compileDraft(named).ok).toBe(false)
    const picked = { ...named, terminalId: T1 }
    expect(canSaveDraft(picked)).toBe(true)
    const compiled = compileDraft(picked)
    expect(compiled.ok && compiled.composition.helper).toEqual({
      kind: 'terminal',
      terminalId: T1,
    })
  })

  it('an engine-hosted block is not edited through the helper wizard', () => {
    expect(draftFromHelper({ kind: 'terminal', terminalId: T1 }, 'x', '')).toBeNull()
  })
})

describe('the Terminal camera picker', () => {
  it('names the block that already shows a terminal, and keeps the one being edited free', () => {
    const index = terminalCameraIndex(loaded(terminalBlock('b1', 'Hub monitor', T1)), false)
    expect(index.kind).toBe('ready')
    if (index.kind !== 'ready') return
    const terminals = [
      { id: T1, name: 'BTM Hub' },
      { id: T2, name: 'Top NUC' },
    ]
    expect(terminalChoices(terminals, index, null)).toEqual([
      { id: T1, name: 'BTM Hub', takenBy: 'Hub monitor' },
      { id: T2, name: 'Top NUC', takenBy: null },
    ])
    expect(terminalChoices(terminals, index, 'b1')[0]?.takenBy).toBeNull()
  })

  it('a camera block is found by its terminal, with its device', () => {
    const index = terminalCameraIndex(loaded(terminalBlock('b1', 'Hub monitor', T1)), false)
    expect(index.kind === 'ready' && index.byTerminal.get(T1)).toEqual({
      blockId: 'b1',
      name: 'Hub monitor',
      deviceId: 4600,
    })
  })

  it('a read that has not answered, failed or is not loaded is never "no camera"', () => {
    expect(terminalCameraIndex(undefined, false).kind).toBe('pending')
    expect(terminalCameraIndex(undefined, true).kind).toBe('unknown')
    expect(terminalCameraIndex({ state: 'not-loaded', reason: 'cold' }, false).kind).toBe('unknown')
  })
})
