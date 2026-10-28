/**
 * The AI page's pure layer: which glyph a kind gets, how kinds group, and what
 * a node's Apple state reads as.
 *
 * The icon assertions are not decoration. The page shipped rendering the cap's
 * emoji inside a table cell built for a 14 px lucide glyph, and "the icons look
 * wrong" is exactly the kind of report that gets fixed by hand in one call site
 * and left in the other three. One map, keyed by icon NAME (never a kind id).
 */

import type { LlmProfileKindDescriptor, LlmRuntimeNode } from '@camstack/types'
import { Bot, Cloud, Cpu, Plug } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import {
  describeAppleNode,
  groupKindsByAddon,
  iconForName,
  runtimeNodeFeatures,
  runtimeStateLabelKey,
  runtimeStateTone,
} from '../ai-page.helpers'

describe('iconForName', () => {
  it('draws the name a descriptor sends — where the model runs, not who sells it', () => {
    expect(iconForName('cloud')).toBe(Cloud)
    expect(iconForName('plug')).toBe(Plug)
    expect(iconForName('cpu')).toBe(Cpu)
  })

  it('an unknown name (a third-party provider’s) draws a neutral glyph, never nothing', () => {
    expect(iconForName('acme-logo')).toBe(Bot)
  })

  it('never answers for a prototype-chain key', () => {
    expect(iconForName('constructor')).toBe(Bot)
    expect(iconForName('__proto__')).toBe(Bot)
  })
})

describe('groupKindsByAddon', () => {
  function kind(over: Partial<LlmProfileKindDescriptor>): LlmProfileKindDescriptor {
    return {
      kind: 'openai',
      label: 'OpenAI',
      icon: 'cloud',
      addonId: 'ai',
      connectionSchema: { sections: [] },
      features: { vision: false, tools: false, streaming: false },
      visionEditable: true,
      modelCatalog: 'none',
      profileFields: [],
      ...over,
    }
  }

  it('keeps each provider’s kinds together, in first-seen order', () => {
    const groups = groupKindsByAddon([
      kind({ addonId: 'ai', kind: 'openai' }),
      kind({ addonId: 'other', kind: 'google' }),
      kind({ addonId: 'ai', kind: 'anthropic' }),
    ])
    expect(groups.map((g) => g.addonId)).toEqual(['ai', 'other'])
    expect(groups[0]?.kinds).toHaveLength(2)
  })
})

describe('describeAppleNode', () => {
  const node = (over: Partial<LlmRuntimeNode>): LlmRuntimeNode => ({
    nodeId: 'mac',
    reachable: true,
    ...over,
  })

  it('only an AVAILABLE node is selectable, and it says what it can do', () => {
    const view = describeAppleNode(
      node({
        apple: {
          state: 'available',
          osVersion: '26.3.1',
          contextSize: 4096,
          languages: ['it-IT'],
          imageInput: false,
        },
      }),
    )
    expect(view).toMatchObject({ selectable: true, tone: 'success' })
    expect(view.detail).toContain('26.3.1')
    expect(view.detail).toContain('text only')
  })

  it('an unavailable node is shown with the reason to act on', () => {
    const view = describeAppleNode(
      node({
        apple: {
          state: 'unavailable',
          reason: 'appleIntelligenceNotEnabled',
          osVersion: '26.3.1',
          detail: 'Apple Intelligence is turned off',
        },
      }),
    )
    expect(view).toMatchObject({
      selectable: false,
      labelDefault: 'Apple Intelligence off',
    })
    expect(view.detail).toBe('Apple Intelligence is turned off')
  })

  it('a node that did not answer is UNKNOWN — never "not available" (D315)', () => {
    expect(describeAppleNode(node({}))).toMatchObject({
      selectable: false,
      labelDefault: 'unknown',
    })
    expect(describeAppleNode(node({ reachable: false, error: 'timeout' }))).toMatchObject({
      selectable: false,
      labelDefault: 'unknown',
      detail: 'timeout',
    })
  })

  it('a Linux node is a known absence, not an unknown', () => {
    expect(
      describeAppleNode(node({ apple: { state: 'unsupported-platform', platform: 'linux' } })),
    ).toMatchObject({ selectable: false, labelDefault: 'not a Mac' })
  })
})

describe('runtimeStateTone', () => {
  const node = (over: Partial<LlmRuntimeNode>): LlmRuntimeNode => ({
    nodeId: 'n',
    reachable: true,
    ...over,
  })
  const status = (state: NonNullable<LlmRuntimeNode['status']>['state']) =>
    node({ status: { nodeId: 'n', state, crashesInWindow: 0 } })

  it('a STOPPED runtime is danger — it serves nothing, it must not read as healthy', () => {
    expect(runtimeStateTone(status('stopped'))).toBe('danger')
    expect(runtimeStateTone(status('crashed'))).toBe('danger')
    expect(runtimeStateTone(status('failed'))).toBe('danger')
  })

  it('a stopped runtime draws the translated Stopped label, not the raw state', () => {
    expect(runtimeStateLabelKey(status('stopped'))).toBe('ai.stateStopped')
    expect(runtimeStateLabelKey(node({ reachable: false }))).toBe('ai.unreachable')
  })

  it('only READY is success; work in progress is info; unreachable is danger', () => {
    expect(runtimeStateTone(status('ready'))).toBe('success')
    expect(runtimeStateTone(status('downloading'))).toBe('info')
    expect(runtimeStateTone(status('starting'))).toBe('info')
    expect(runtimeStateTone(node({ reachable: false }))).toBe('danger')
  })
})

describe('runtimeNodeFeatures', () => {
  const node = (over: Partial<LlmRuntimeNode>): LlmRuntimeNode => ({
    nodeId: 'n',
    reachable: true,
    ...over,
  })

  it('Apple on-device is a feature badge — green when available, with what it can do', () => {
    const badges = runtimeNodeFeatures(
      node({
        apple: {
          state: 'available',
          osVersion: '26.1',
          contextSize: 4096,
          languages: ['en'],
          imageInput: true,
        },
      }),
    )
    expect(badges.map((b) => [b.id, b.tone])).toEqual([
      ['apple', 'success'],
      ['apple-images', 'success'],
    ])
    expect(badges[0]?.detail).toContain('26.1')
  })

  it('an Apple that is there but not usable still shows, in its reason’s tone', () => {
    const [apple] = runtimeNodeFeatures(
      node({
        apple: {
          state: 'unavailable',
          reason: 'appleIntelligenceNotEnabled',
          osVersion: '26.1',
          detail: 'turn it on in Settings',
        },
      }),
    )
    expect(apple).toMatchObject({ id: 'apple', tone: 'warning' })
  })

  it('a GPU in use is a feature; a Linux or silent node claims no Apple', () => {
    const badges = runtimeNodeFeatures(
      node({
        status: {
          nodeId: 'n',
          state: 'ready',
          crashesInWindow: 0,
          vramBytes: 4_000_000_000,
        },
        apple: { state: 'unsupported-platform', platform: 'linux' },
      }),
    )
    expect(badges.map((b) => b.id)).toEqual(['gpu'])
    expect(runtimeNodeFeatures(node({}))).toEqual([])
    expect(runtimeNodeFeatures(node({ reachable: false, error: 'x' }))).toEqual([])
  })
})
