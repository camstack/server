/**
 * The per-member breakdown of a notifier-group test.
 *
 * A group answers "Delivered" when no member FAILED — including when every
 * member was skipped. The breakdown is what lets the operator see that, so
 * each member must read with its own status and the reason it got nothing.
 */
import type { GroupMemberOutcome } from '@dominevo/types'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { NotificationGroupMemberOutcomes } from '../NotificationGroupMemberOutcomes'

const MEMBERS: readonly GroupMemberOutcome[] = [
  { targetId: 'phone', status: 'sent' },
  { targetId: 'speaker', status: 'skipped', reason: 'schedule-inactive' },
  { targetId: 'chat', status: 'failed', error: 'HTTP 401' },
]

describe('NotificationGroupMemberOutcomes', () => {
  it('lists every member with its status, the skip reason and the failure text', () => {
    render(<NotificationGroupMemberOutcomes members={MEMBERS} />)
    const rows = screen.getAllByTestId('group-member-outcome')
    expect(rows).toHaveLength(3)
    expect(rows[0]?.textContent).toContain('phone')
    expect(rows[0]?.textContent).toContain('Sent')
    expect(rows[1]?.textContent).toContain('speaker')
    expect(rows[1]?.textContent).toContain('Skipped')
    expect(rows[1]?.textContent).toContain('Outside its schedule')
    expect(rows[2]?.textContent).toContain('chat')
    expect(rows[2]?.textContent).toContain('Failed')
    expect(rows[2]?.textContent).toContain('HTTP 401')
  })

  it('renders nothing for a result without members', () => {
    const { container } = render(<NotificationGroupMemberOutcomes members={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
