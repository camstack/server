import { DeviceType, type DiscoveredChildDevice } from '@camstack/types'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { CandidateNameCell } from '../AdoptDevicesModal'

const candidate = (over: Partial<DiscoveredChildDevice>): DiscoveredChildDevice => ({
  childNativeId: 'alexa:G0014D060156024W',
  name: 'Echo Flex Giardino',
  type: DeviceType.MediaPlayer,
  status: 'online',
  metadata: {},
  alreadyAdopted: false,
  adoptedDeviceId: null,
  capabilities: [],
  children: [],
  ...over,
})

function renderCell(c: DiscoveredChildDevice, containerName?: string): void {
  render(
    <CandidateNameCell
      candidate={c}
      depth={0}
      {...(containerName !== undefined ? { containerName } : {})}
      expandable={false}
      expanded={false}
      onToggleExpand={vi.fn()}
      adoptedLabel="Adopted"
      typeLabel="Speaker"
    />,
  )
}

describe('CandidateNameCell', () => {
  it('puts the id tail on its own line under the name, never beside it', () => {
    renderCell(candidate({}))
    const name = screen.getByTestId('candidate-name')
    const subtitle = screen.getByTestId('candidate-subtitle')
    expect(subtitle.textContent).toBe('G0014D060156024W')
    expect(name.parentElement).toBe(subtitle.parentElement)
    expect(name.className).toContain('truncate')
    expect(subtitle.className).toContain('truncate')
    // No flex row shares the name with the subtitle: they stack, each on its own line.
    expect(name.parentElement?.classList.contains('flex')).toBe(false)
    expect(name.tagName).toBe('DIV')
    expect(name.compareDocumentPosition(subtitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders no subtitle when there is nothing to tell the row apart', () => {
    renderCell(candidate({ childNativeId: '' }))
    expect(screen.queryByTestId('candidate-subtitle')).toBeNull()
  })

  it('draws no leading dash, with or without a chevron slot', () => {
    const { container } = render(
      <CandidateNameCell
        candidate={candidate({})}
        depth={0}
        expandable
        expanded={false}
        onToggleExpand={vi.fn()}
        adoptedLabel="Adopted"
        typeLabel="Speaker"
      />,
    )
    expect(container.textContent).not.toMatch(/[—–-]/)
    renderCell(candidate({}))
    expect(screen.getAllByTestId('candidate-name')).toHaveLength(2)
  })

  it('names the container a child sits under on a secondary line', () => {
    renderCell(candidate({}), 'Hue Bridge')
    expect(screen.getByTestId('candidate-container').textContent).toBe('in Hue Bridge')
  })

  it('names no container for a top-level row', () => {
    renderCell(candidate({}))
    expect(screen.queryByTestId('candidate-container')).toBeNull()
  })
})
