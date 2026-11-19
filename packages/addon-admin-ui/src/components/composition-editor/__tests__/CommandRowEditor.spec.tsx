import {
  ALL_CAPABILITY_DEFINITIONS,
  type CompositionFieldsFeature,
  mediaPlayerExtensionCommands,
} from '@camstack/types'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { devicePath } from '../../../lib/customization-routes'
import { commandRows } from '../command-model'
import { CommandRowEditor } from '../CommandRowEditor'

const def = ALL_CAPABILITY_DEFINITIONS.find((d) => d.name === 'media-player')
const feature: CompositionFieldsFeature = {
  kind: 'fields',
  cap: 'media-player',
  fields: {},
  commands: mediaPlayerExtensionCommands(),
}

function renderRow(remoteHref: string | null) {
  if (def === undefined) throw new Error('media-player cap missing')
  const row = commandRows(def, feature)[0]
  if (row === undefined) throw new Error('no command rows')
  render(
    <MemoryRouter>
      <CommandRowEditor
        def={def}
        feature={feature}
        featureIndex={0}
        row={row}
        itemLabel={null}
        fleet={{ kind: 'known', value: [] }}
        names={new Map()}
        candidates={{ kind: 'known', value: [] }}
        room={null}
        saving={false}
        remoteHref={remoteHref}
        onApply={vi.fn()}
      />
    </MemoryRouter>,
  )
  return row
}

describe('a command row served by the device remote', () => {
  it('keeps the label and links to the device page, the one place the remote is edited', () => {
    const row = renderRow(devicePath(42))
    expect(screen.getByText(/Served by this device's remote/)).toBeTruthy()
    expect(screen.getByTestId(`command-remote-link-${row.id}`).getAttribute('href')).toBe(
      devicePath(42),
    )
    expect(screen.queryByText('Edit remote')).toBeNull()
  })

  it('shows no link before the device exists', () => {
    const row = renderRow(null)
    expect(screen.getByText(/Served by this device's remote/)).toBeTruthy()
    expect(screen.queryByTestId(`command-remote-link-${row.id}`)).toBeNull()
  })
})
