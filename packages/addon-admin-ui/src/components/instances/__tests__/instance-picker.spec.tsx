/**
 * InstancePicker — what the host mounts for `instance-select`: a broker link is the rich
 * BrokerPicker, any other cap the library's plain select.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../brokers/BrokerPicker', () => ({
  BrokerPicker: (props: { kind: string; optional?: boolean; disabled?: boolean }) => (
    <span>
      broker-picker:{props.kind}:{String(props.optional)}:{String(props.disabled)}
    </span>
  ),
}))
vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    InstancePlainSelect: (props: { functionCap: string; noneLabel?: string }) => (
      <span>
        plain:{props.functionCap}:{props.noneLabel}
      </span>
    ),
  }
})

import { InstancePicker } from '../InstancePicker'

describe('InstancePicker', () => {
  it('renders the BrokerPicker for a broker link, with its kind', () => {
    render(<InstancePicker functionCap="broker" kind="alexa" value={null} onChange={vi.fn()} />)
    expect(screen.getByText('broker-picker:alexa:false:false')).toBeTruthy()
  })

  it('renders the plain select, with the none label, for another cap', () => {
    render(
      <InstancePicker
        functionCap="smtp-provider"
        noneLabel="Default relay"
        value={null}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByText('plain:smtp-provider:Default relay')).toBeTruthy()
  })

  it('passes disabled through, and an optional link to the BrokerPicker', () => {
    render(
      <InstancePicker
        functionCap="broker"
        kind="alexa"
        value={null}
        required={false}
        disabled
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByText('broker-picker:alexa:true:true')).toBeTruthy()
  })
})
