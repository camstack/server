import { selectOption, selectOptionValues } from '@camstack/ui-library/testing'
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
  return (
    <SourcesPanel
      config={config}
      onChange={setConfig}
      roleLabel={(r) => r}
      transmitters={[{ id: 7, label: 'IR board' }]}
    />
  )
}

describe('SourcesPanel', () => {
  it('says so when nothing is declared', () => {
    render(<Harness initial={BOUND} />)
    expect(
      screen.getByText('No sources declared — Alexa and the viewer will show none.'),
    ).toBeTruthy()
  })

  it('names a stored source that was left out, with its reason', () => {
    render(
      <Harness
        initial={{
          ...BOUND,
          refusedSources: [
            { index: 0, id: 'hdmi2', name: 'HDMI 2', reason: 'a pulse has no space' },
          ],
        }}
      />,
    )
    expect(screen.getByTestId('remote-refused-sources').textContent).toContain(
      'HDMI 2: a pulse has no space',
    )
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
    selectOption(screen.getByTestId('source-kind'), 'sequence')
    fireEvent.change(screen.getByTestId('source-name'), { target: { value: 'HDMI' } })
    const offered = selectOptionValues(screen.getByTestId('source-step-pick'))
    expect(offered).toEqual(['', 'input', 'ok', 'digit_1', 'digit_2'])
    for (const role of ['input', 'ok']) {
      selectOption(screen.getByTestId('source-step-pick'), role)
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

  it('declares an infrared code of its own through the default transmitter, and refuses a broken one (planning#464)', () => {
    render(<Harness initial={{ ...BOUND, defaultTransmitterId: 7 }} />)
    fireEvent.click(screen.getByTestId('source-add'))
    selectOption(screen.getByTestId('source-kind'), 'ir')
    fireEvent.change(screen.getByTestId('source-name'), { target: { value: 'HDMI 2' } })
    // Blank = the remote's default emitter; nothing is pinned on the source.
    expect((screen.getByTestId('source-transmitter') as HTMLButtonElement).value).toBe('')
    fireEvent.change(screen.getByTestId('source-code'), { target: { value: '9000 4500' } })
    fireEvent.click(screen.getByTestId('source-save'))
    expect(screen.getByText(/must be a non-zero space/)).toBeTruthy()
    expect(latest.sources).toEqual([])
    fireEvent.change(screen.getByTestId('source-code'), {
      target: { value: '9000, -4500, 560, -560' },
    })
    fireEvent.change(screen.getByTestId('source-carrier'), { target: { value: '38' } })
    fireEvent.click(screen.getByTestId('source-save'))
    expect(latest.sources).toEqual([
      {
        id: 'hdmi-2',
        kind: 'ir',
        name: 'HDMI 2',
        payload: { kind: 'raw', timings: [9000, -4500, 560, -560], settings: { carrierHz: 38000 } },
      },
    ])
    expect(screen.getByText('Infrared · 4 pulses · 38 kHz')).toBeTruthy()
  })

  it('asks for a transmitter when the remote has none', () => {
    render(<Harness initial={BOUND} />)
    fireEvent.click(screen.getByTestId('source-add'))
    selectOption(screen.getByTestId('source-kind'), 'ir')
    fireEvent.change(screen.getByTestId('source-name'), { target: { value: 'HDMI 2' } })
    fireEvent.change(screen.getByTestId('source-code'), { target: { value: '9000, -4500' } })
    fireEvent.click(screen.getByTestId('source-save'))
    expect(screen.getByText('Pick an emitter: this remote has no default one.')).toBeTruthy()
    expect(latest.sources).toEqual([])
  })
})
