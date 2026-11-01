/**
 * BrokerPicker — the one broker-selection control pre-selects the first broker
 * of its kind once the list ANSWERED, only while nothing is chosen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import './setup'

interface ListState {
  data: unknown
  isLoading: boolean
  isError: boolean
}
let listState: ListState

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return { ...actual, useBrokerList: () => listState }
})
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('../BrokerEditorDialog', () => ({ BrokerEditorDialog: () => null }))

import { BrokerPicker } from '../BrokerPicker'

const row = (id: string, kind: string) => ({
  id,
  kind,
  name: id,
  addonId: 'a',
  status: 'connected',
  info: {},
  lastCheckedAt: null,
  error: null,
})

describe('BrokerPicker default selection', () => {
  const onChange = vi.fn()
  beforeEach(() => {
    onChange.mockReset()
  })

  it('selects the first broker of the kind when empty and the list answered', () => {
    listState = {
      data: [row('x', 'other'), row('a1', 'alexa'), row('a2', 'alexa')],
      isLoading: false,
      isError: false,
    }
    render(<BrokerPicker kind="alexa" value={null} onChange={onChange} />)
    expect(onChange).toHaveBeenCalledExactlyOnceWith('a1')
  })

  it('does not select while loading, or over an existing choice, or with none', () => {
    listState = { data: undefined, isLoading: true, isError: false }
    const { rerender } = render(<BrokerPicker kind="alexa" value={null} onChange={onChange} />)
    listState = { data: [row('a1', 'alexa')], isLoading: false, isError: false }
    rerender(<BrokerPicker kind="alexa" value="a1" onChange={onChange} />)
    listState = { data: [], isLoading: false, isError: false }
    rerender(<BrokerPicker kind="alexa" value={null} onChange={onChange} />)
    expect(onChange).not.toHaveBeenCalled()
  })
})
