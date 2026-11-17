/**
 * The addon dialog's cluster settings (#578): what a feature page claims is left
 * out, with a link to that page, and the empty message says where they went.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AddonClusterSettings } from '../AddonClusterSettings'

interface PanelProps {
  readonly omitCapabilities?: readonly string[]
  readonly omitFieldKeys?: readonly string[]
  readonly emptyMessage?: string
  readonly fieldScope?: string
}

vi.mock('../../settings/NodeAddonsSettingsPanel', () => ({
  NodeAddonsSettingsPanel: (props: PanelProps) => (
    <div
      data-testid="panel"
      data-omit-caps={(props.omitCapabilities ?? []).join(',')}
      data-omit-keys={(props.omitFieldKeys ?? []).join(',')}
      data-scope={props.fieldScope}
    >
      {props.emptyMessage}
    </div>
  ),
}))

describe('AddonClusterSettings', () => {
  it('omits the caps and fields a feature page draws, and links to each page', () => {
    const onOpen = vi.fn()
    render(<AddonClusterSettings addonId="pipeline-analytics" onOpen={onOpen} />)
    const panel = screen.getByTestId('panel')
    expect(panel.dataset['omitCaps']).toBe('face-gallery')
    expect(panel.dataset['omitKeys']).toBe('postProcessingNodeId')
    expect(panel.dataset['scope']).toBe('cluster')
    fireEvent.click(screen.getByRole('button', { name: 'Pipeline → Roles & nodes' }))
    expect(onOpen).toHaveBeenCalledWith(
      '/system/pipeline?view=nodes&node=__cluster__&ctab=roles-nodes',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Pipeline → Settings' }))
    expect(onOpen).toHaveBeenLastCalledWith(
      '/system/pipeline?view=nodes&node=__cluster__&ctab=settings',
    )
    expect(panel.textContent).toContain('on the page linked above')
  })

  it('draws everything, with no links, for an addon no feature page claims', () => {
    render(<AddonClusterSettings addonId="model-studio" onOpen={vi.fn()} />)
    const panel = screen.getByTestId('panel')
    expect(panel.dataset['omitCaps']).toBe('')
    expect(panel.dataset['omitKeys']).toBe('')
    expect(screen.queryByRole('button')).toBeNull()
    expect(panel.textContent).toContain('exposes no cluster-wide settings')
  })

  it('links a fully moved addon to its page and says so when nothing is left', () => {
    render(<AddonClusterSettings addonId="device-history" onOpen={vi.fn()} />)
    expect(screen.getByTestId('panel').dataset['omitCaps']).toBe('device-history')
    expect(screen.getByRole('button', { name: 'History' })).toBeTruthy()
  })
})
