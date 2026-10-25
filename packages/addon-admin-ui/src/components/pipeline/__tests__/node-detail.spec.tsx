/// <reference types="@testing-library/jest-dom" />
/**
 * Pipeline → node page:
 *
 *   - it shows only what is stored PER NODE: runner tuning and the audio
 *     backend are cluster values and live on Cluster → Settings (audit B7);
 *   - the decoder's settings share the engine tab ("Engine & decoder"), and an
 *     old `?ntab=decoder` link lands on it;
 *   - the tab is in the URL; the padding shrinks on a phone.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

interface Captured {
  fieldScope?: string
  tabAliases?: Readonly<Record<string, string>>
  tabLabelOverrides?: Readonly<Record<string, string>>
  activeTab?: string | null
  schemaTabExtras?: ReadonlyArray<{ tabId: string; placement?: string }>
}
const captured: Captured = {}

vi.mock('../../settings/NodeAddonsSettingsPanel', () => ({
  NodeAddonsSettingsPanel: (props: Captured) => {
    Object.assign(captured, props)
    return <div data-testid="panel" />
  },
}))
vi.mock('../NodeDetailHeader', () => ({ NodeDetailHeader: () => null }))
vi.mock('@camstack/ui-library', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@camstack/ui-library')),
  useClusterNodes: () => ({ nodes: [] }),
}))

import { NodeDetail } from '../NodeDetail'

function mount(url: string): HTMLElement {
  const { container } = render(
    <MemoryRouter initialEntries={[url]}>
      <NodeDetail nodeId="hub" refreshToken={0} />
    </MemoryRouter>,
  )
  return container
}

describe('NodeDetail', () => {
  it('renders the per-node population only', () => {
    mount('/system/pipeline?node=hub')
    expect(captured.fieldScope).toBe('perNode')
  })

  it('shows the decoder on the engine tab, and an old ?ntab=decoder lands there', () => {
    mount('/system/pipeline?node=hub&ntab=decoder')
    expect(captured.tabAliases).toEqual({ decoder: 'engine' })
    expect(captured.tabLabelOverrides?.engine).toBe('Engine & decoder')
    expect(captured.activeTab).toBe('engine')
  })

  it('does not mount a parallel decode-limits card (schema owns Engine tab)', () => {
    mount('/system/pipeline?node=hub')
    expect(captured.schemaTabExtras).toBeUndefined()
  })

  it('keeps the requested tab otherwise', () => {
    mount('/system/pipeline?node=hub&ntab=scheduler')
    expect(captured.activeTab).toBe('scheduler')
  })

  it('pads less on a phone', () => {
    const container = mount('/system/pipeline?node=hub')
    const scroller = container.querySelector('.overflow-y-auto')
    expect(scroller?.className).toMatch(/\bp-4\b/)
    expect(scroller?.className).toMatch(/\bsm:p-6\b/)
  })
})
