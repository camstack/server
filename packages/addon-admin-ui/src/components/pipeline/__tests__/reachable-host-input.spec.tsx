/// <reference types="@testing-library/jest-dom" />

import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

import { ReachableHostInput } from '../placement-board/ReachableHostInput'

describe('ReachableHostInput', () => {
  it('shows the first detected host as the placeholder default', () => {
    render(
      <ReachableHostInput
        nodeId="hub"
        value={null}
        detectedHosts={['192.0.2.10', '198.51.100.1']}
        status="idle"
        errorMessage={null}
        onCommit={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('Reachable host for hub')).toHaveAttribute(
      'placeholder',
      'auto: 192.0.2.10',
    )
  })

  it('falls back to a generic placeholder when no host is detected', () => {
    render(
      <ReachableHostInput
        nodeId="agent"
        value={null}
        detectedHosts={[]}
        status="idle"
        errorMessage={null}
        onCommit={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('Reachable host for agent')).toHaveAttribute(
      'placeholder',
      'auto-detect',
    )
  })

  it('commits the trimmed value on blur', () => {
    const onCommit = vi.fn()
    render(
      <ReachableHostInput
        nodeId="hub"
        value={null}
        detectedHosts={['192.0.2.10']}
        status="idle"
        errorMessage={null}
        onCommit={onCommit}
      />,
    )
    const input = screen.getByLabelText('Reachable host for hub')
    fireEvent.change(input, { target: { value: '  198.51.100.1  ' } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith('hub', '198.51.100.1')
  })

  it('commits null when cleared to blank (revert to auto-detect)', () => {
    const onCommit = vi.fn()
    render(
      <ReachableHostInput
        nodeId="hub"
        value="198.51.100.1"
        detectedHosts={['192.0.2.10']}
        status="idle"
        errorMessage={null}
        onCommit={onCommit}
      />,
    )
    const input = screen.getByLabelText('Reachable host for hub')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith('hub', null)
  })

  it('the Save button is disabled until the draft differs from the persisted value', () => {
    render(
      <ReachableHostInput
        nodeId="hub"
        value="198.51.100.1"
        detectedHosts={[]}
        status="idle"
        errorMessage={null}
        onCommit={vi.fn()}
      />,
    )
    const saveButton = screen.getByLabelText('Save reachable host for hub')
    expect(saveButton).toBeDisabled()

    const input = screen.getByLabelText('Reachable host for hub')
    fireEvent.change(input, { target: { value: '198.51.100.2' } })
    expect(saveButton).toBeEnabled()
  })

  it('clicking Save commits the draft', () => {
    const onCommit = vi.fn()
    render(
      <ReachableHostInput
        nodeId="agent-1"
        value={null}
        detectedHosts={[]}
        status="idle"
        errorMessage={null}
        onCommit={onCommit}
      />,
    )
    const input = screen.getByLabelText('Reachable host for agent-1')
    fireEvent.change(input, { target: { value: '192.0.2.10' } })
    fireEvent.click(screen.getByLabelText('Save reachable host for agent-1'))
    expect(onCommit).toHaveBeenCalledWith('agent-1', '192.0.2.10')
  })

  it('disables the input and Save button while a save is pending', () => {
    render(
      <ReachableHostInput
        nodeId="hub"
        value="198.51.100.1"
        detectedHosts={[]}
        status="pending"
        errorMessage={null}
        onCommit={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('Reachable host for hub')).toBeDisabled()
    expect(screen.getByLabelText('Save reachable host for hub')).toBeDisabled()
  })

  it('shows an error indicator when the last save failed', () => {
    render(
      <ReachableHostInput
        nodeId="hub"
        value="198.51.100.1"
        detectedHosts={[]}
        status="error"
        errorMessage="Network timeout"
        onCommit={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('Network timeout')).toBeInTheDocument()
  })

  it('shows a saved indicator once the value settles after a successful save', () => {
    render(
      <ReachableHostInput
        nodeId="hub"
        value="198.51.100.1"
        detectedHosts={[]}
        status="success"
        errorMessage={null}
        onCommit={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('Saved')).toBeInTheDocument()
  })
})
