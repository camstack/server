import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { GroupedTilePicker } from '../grouped-tile-picker'

describe('GroupedTilePicker', () => {
  it('draws each group under its label and hands back the picked tile key', () => {
    const onPick = vi.fn()
    render(
      <GroupedTilePicker
        emptyMessage="nothing"
        onPick={onPick}
        groups={[
          { id: 'a', label: 'ai', tiles: [{ key: 'ai:openai', label: 'OpenAI', icon: <span /> }] },
          {
            id: 'b',
            label: 'acme',
            tiles: [{ key: 'acme:x', label: 'Acme', icon: <span />, testId: 'tile-acme' }],
          },
        ]}
      />,
    )
    expect(screen.getByText('ai')).toBeTruthy()
    expect(screen.getByText('acme')).toBeTruthy()
    fireEvent.click(screen.getByTestId('tile-acme'))
    expect(onPick).toHaveBeenCalledWith('acme:x')
    expect(screen.queryByText('nothing')).toBeNull()
  })

  it('says so when there is no group', () => {
    render(
      <GroupedTilePicker emptyMessage="No provider is installed." onPick={() => {}} groups={[]} />,
    )
    expect(screen.getByText('No provider is installed.')).toBeTruthy()
  })
})
