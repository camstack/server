import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { filterTileGroups, GroupedTilePicker } from '../grouped-tile-picker'

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

  it('opens a tile detail without choosing that tile', () => {
    const onPick = vi.fn()
    render(
      <GroupedTilePicker
        emptyMessage="nothing"
        onPick={onPick}
        groups={[
          {
            id: 'readings',
            label: 'Readings',
            tiles: [
              {
                key: 'temperature',
                label: 'Temperature',
                icon: <span />,
                testId: 'tile-temperature',
                detailLabel: 'Temperature details',
                detail: <p>Mean, median</p>,
              },
            ],
          },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Temperature details' }))
    expect(onPick).not.toHaveBeenCalled()
    expect(screen.getByText('Mean, median')).toBeTruthy()
    fireEvent.click(screen.getByTestId('tile-temperature'))
    expect(onPick).toHaveBeenCalledWith('temperature')
  })

  it('says so when there is no group', () => {
    render(
      <GroupedTilePicker emptyMessage="No provider is installed." onPick={() => {}} groups={[]} />,
    )
    expect(screen.getByText('No provider is installed.')).toBeTruthy()
  })
})

describe('filterTileGroups and the search field', () => {
  const groups = [
    {
      id: 'g',
      label: 'Group',
      tiles: [
        { key: 'light', label: 'Light group', icon: <span /> },
        { key: 'lock', label: 'Lock group', icon: <span /> },
      ],
    },
    { id: 'c', label: 'Cameras', tiles: [{ key: 'grid', label: 'Camera grid', icon: <span /> }] },
  ]

  it('keeps matching tiles across sections, separator-insensitive, and drops empty groups', () => {
    expect(filterTileGroups(groups, 'cameragrid').map((g) => g.id)).toEqual(['c'])
    expect(filterTileGroups(groups, 'GROUP').flatMap((g) => g.tiles.map((t) => t.key))).toEqual([
      'light',
      'lock',
    ])
    expect(filterTileGroups(groups, '  ')).toBe(groups)
    expect(filterTileGroups(groups, 'zzz')).toEqual([])
  })

  it('filters as the operator types and shows the no-match message', () => {
    render(
      <GroupedTilePicker
        emptyMessage="nothing"
        onPick={vi.fn()}
        groups={groups}
        search={{ placeholder: 'Search', label: 'Search templates', noMatchMessage: 'no match' }}
      />,
    )
    const field = screen.getByTestId('tile-picker-search')
    expect(field.hasAttribute('data-dialog-autofocus')).toBe(true)
    fireEvent.change(field, { target: { value: 'lock' } })
    expect(screen.queryByText('Light group')).toBeNull()
    expect(screen.getByText('Lock group')).toBeTruthy()
    fireEvent.change(field, { target: { value: 'zzz' } })
    expect(screen.getByText('no match')).toBeTruthy()
    expect(screen.queryByText('nothing')).toBeNull()
  })
})
