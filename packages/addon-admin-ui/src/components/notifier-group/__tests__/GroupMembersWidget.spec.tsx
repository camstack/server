// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ConfigUISchema } from '../../../types/config-ui'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, def: string, opts?: Record<string, unknown>) =>
      opts === undefined ? def : def.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(opts[k])),
  }),
}))
vi.mock('../../../pages/system/use-notification-targets', () => ({
  useNotificationTargets: () => ({
    isError: false,
    data: [
      {
        id: 'g1',
        name: 'Other group',
        kind: 'group',
        addonId: 'core-notifier',
        enabled: true,
        config: {},
      },
      {
        id: 'n1',
        name: 'Phone',
        kind: 'ntfy',
        addonId: 'notifiers',
        enabled: true,
        config: {},
      },
    ],
  }),
}))
vi.mock('../GroupMemberCard', () => ({
  GroupMemberCard: ({ name }: { name: string }) => <div data-testid="card">{name}</div>,
}))

import { GroupMembersWidget } from '../GroupMembersWidget'

const SCHEMA: ConfigUISchema = { sections: [] }

describe('GroupMembersWidget', () => {
  it('adds a picked target as a member and never lists a group', () => {
    const onValuesChange = vi.fn()
    render(
      <GroupMembersWidget schema={SCHEMA} values={{ name: 'x' }} onValuesChange={onValuesChange} />,
    )
    expect(screen.queryByText('Other group')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Add/ }))
    expect(onValuesChange).toHaveBeenCalledWith({
      name: 'x',
      members: [{ targetId: 'n1' }],
    })
  })

  it('shows a card per member and hides the picked target from the search', () => {
    render(
      <GroupMembersWidget
        schema={SCHEMA}
        values={{ members: [{ targetId: 'n1' }] }}
        onValuesChange={vi.fn()}
      />,
    )
    expect(screen.getAllByTestId('card')).toHaveLength(1)
    expect(screen.getByText(/No other notifier matches/)).toBeTruthy()
  })
})
