/// <reference types="@testing-library/jest-dom" />
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RoleNodePill } from '../role-node-pill'

expect.extend(jestDomMatchers)

describe('RoleNodePill', () => {
  it('renders the role label and hosting node name', () => {
    render(
      <RoleNodePill
        roleId="detection"
        roleLabel="Detection"
        nodeName="macmini"
        colorId="node-b"
        emphasized
      />,
    )
    expect(screen.getByText('Detection')).toBeInTheDocument()
    expect(screen.getByText('macmini')).toBeInTheDocument()
    expect(screen.getByTestId('role-node-pill')).toHaveAttribute('data-role', 'detection')
  })

  it('tints by role, not by node colour class on the chrome', () => {
    render(
      <RoleNodePill
        roleId="decode"
        roleLabel="Decode"
        nodeName="Hub"
        colorId="node-a"
        emphasized={false}
      />,
    )
    const pill = screen.getByTestId('role-node-pill')
    expect(pill.className).toMatch(/bg-warning/)
    expect(pill.className).not.toMatch(/bg-node-a\//)
  })

  it('adds a stronger chrome class when emphasized', () => {
    const { rerender } = render(
      <RoleNodePill
        roleId="audio"
        roleLabel="Audio"
        nodeName="Hub"
        colorId="node-a"
        emphasized={false}
      />,
    )
    const pill = screen.getByTestId('role-node-pill')
    expect(pill.className).not.toMatch(/role-node-pill-emphasized/)

    rerender(
      <RoleNodePill roleId="audio" roleLabel="Audio" nodeName="Hub" colorId="node-a" emphasized />,
    )
    expect(screen.getByTestId('role-node-pill').className).toMatch(/role-node-pill-emphasized/)
    expect(screen.getByTestId('role-node-pill').className).toMatch(/bg-success/)
  })

  it('node-only mode is colour icon + name, selectable as a tab', () => {
    const onSelect = () => undefined
    render(<RoleNodePill nodeName="macmini" colorId="node-b" emphasized onSelect={onSelect} />)
    const pill = screen.getByRole('tab', { name: /macmini/ })
    expect(pill).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByText('Detection')).toBeNull()
  })
})
