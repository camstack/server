import { EMPTY_REMOTE_CONFIG, type RemoteConfig } from '@camstack/types'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import '../../../i18n'
import { SourcesPanel } from '../SourcesPanel'

const action = { kind: 'cap' as const, deviceId: 12, cap: 'switch', method: 'turnOn' }
const BOUND: RemoteConfig = {
  ...EMPTY_REMOTE_CONFIG,
  bindings: Object.fromEntries(['input', 'ok', 'digit_1', 'digit_2'].map((r) => [r, { action }])),
}

let latest: RemoteConfig = BOUND

function Harness({ initial }: { initial: RemoteConfig }) {
  const [config, setConfig] = useState(initial)
  latest = config
  return <SourcesPanel config={config} onChange={setConfig} roleLabel={(r) => r} />
}

describe('SourcesPanel', () => {
  it('says so when nothing is declared', () => {
    render(<Harness initial={BOUND} />)
    expect(
      screen.getByText('No sources declared — Alexa and the viewer will show none.'),
    ).toBeTruthy()
  })

  it('adds a channel and shows the schema error inline until it is fixed', () => {
    render(<Harness initial={BOUND} />)
    fireEvent.click(screen.getByTestId('source-add'))
    fireEvent.change(screen.getByTestId('source-name'), { target: { value: 'Rai 1' } })
    fireEvent.change(screen.getByTestId('source-number'), { target: { value: '12x' } })
    fireEvent.click(screen.getByTestId('source-save'))
    expect(screen.getByText('Enter the channel number: 1 to 6 digits.')).toBeTruthy()
    expect(latest.sources).toEqual([])
    fireEvent.change(screen.getByTestId('source-number'), { target: { value: '12' } })
    fireEvent.click(screen.getByTestId('source-save'))
    expect(latest.sources).toEqual([{ id: 'rai-1', kind: 'digits', name: 'Rai 1', number: '12' }])
    expect(screen.getByText('Rai 1')).toBeTruthy()
  })

  it('builds a sequence from bound roles only', () => {
    render(<Harness initial={BOUND} />)
    fireEvent.click(screen.getByTestId('source-add'))
    fireEvent.change(screen.getByTestId('source-kind'), { target: { value: 'sequence' } })
    fireEvent.change(screen.getByTestId('source-name'), { target: { value: 'HDMI' } })
    const offered = within(screen.getByTestId('source-step-pick'))
      .getAllByRole('option')
      .map((o) => o.getAttribute('value'))
    expect(offered).toEqual(['', 'input', 'ok', 'digit_1', 'digit_2'])
    for (const role of ['input', 'ok']) {
      fireEvent.change(screen.getByTestId('source-step-pick'), { target: { value: role } })
      fireEvent.click(screen.getByTestId('source-step-add'))
    }
    fireEvent.click(screen.getByTestId('source-save'))
    expect(latest.sources[0]).toMatchObject({ kind: 'sequence', steps: ['input', 'ok'] })
  })

  it('flags a source whose button was unbound, and a bad step delay', () => {
    const broken: RemoteConfig = {
      ...BOUND,
      stepDelayMs: 50,
      sources: [{ id: 'menu', kind: 'sequence', name: 'Menu', steps: ['menu'] }],
    }
    render(<Harness initial={broken} />)
    expect(screen.getByText(/which is not bound/)).toBeTruthy()
    expect(screen.getByText('Enter a whole number from 100 to 3000.')).toBeTruthy()
  })
})
