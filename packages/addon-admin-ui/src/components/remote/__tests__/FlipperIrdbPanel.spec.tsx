import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { FlipperIrdbPanel } from '../FlipperIrdbPanel'
import { type FlipperIrdbClient, FlipperIrdbError } from '../flipper-irdb-client'

const FILE =
  'Filetype: IR signals file\nVersion: 1\n#\nname: Power\ntype: parsed\nprotocol: Samsung32\naddress: 07 00 00 00\ncommand: 02 00 00 00\n'

function fakeClient(): FlipperIrdbClient {
  return {
    list: async (path) =>
      path === ''
        ? [{ name: 'TVs', path: 'TVs', kind: 'dir' }]
        : [{ name: 'Samsung_X.ir', path: 'TVs/Samsung_X.ir', kind: 'file' }],
    readFile: async () => FILE,
  }
}

describe('FlipperIrdbPanel', () => {
  it('browses to a file, summarises it and applies the draft', async () => {
    const onApply = vi.fn()
    render(<FlipperIrdbPanel transmitterId={7} onApply={onApply} client={fakeClient()} />)
    fireEvent.click(await screen.findByText('TVs'))
    fireEvent.click(await screen.findByText('Samsung_X.ir'))
    await screen.findByTestId('flipper-summary')
    fireEvent.click(screen.getByTestId('flipper-apply'))
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(Object.keys(onApply.mock.calls[0]?.[0].bindings)).toEqual(['power'])
  })

  it('filters the listing by name', async () => {
    const client: FlipperIrdbClient = {
      list: async () => [
        { name: 'Samsung', path: 'Samsung', kind: 'dir' },
        { name: 'LG', path: 'LG', kind: 'dir' },
      ],
      readFile: async () => '',
    }
    render(<FlipperIrdbPanel transmitterId={7} onApply={vi.fn()} client={client} />)
    await screen.findByText('LG')
    fireEvent.change(screen.getByTestId('flipper-search'), { target: { value: 'sam' } })
    expect(screen.queryByText('LG')).toBeNull()
    expect(screen.getByText('Samsung')).toBeTruthy()
  })

  it('shows the rate limit as a typed error', async () => {
    const client: FlipperIrdbClient = {
      list: async () => {
        throw new FlipperIrdbError('rate-limited', 'x', null)
      },
      readFile: async () => '',
    }
    render(<FlipperIrdbPanel transmitterId={7} onApply={vi.fn()} client={client} />)
    await waitFor(() =>
      expect(screen.getByTestId('flipper-error').textContent).toMatch(/rate limit/i),
    )
  })

  it('refuses the file until a transmitter is picked', async () => {
    render(<FlipperIrdbPanel transmitterId={null} onApply={vi.fn()} client={fakeClient()} />)
    fireEvent.click(await screen.findByText('TVs'))
    fireEvent.click(await screen.findByText('Samsung_X.ir'))
    await screen.findByTestId('flipper-refused')
  })
})
