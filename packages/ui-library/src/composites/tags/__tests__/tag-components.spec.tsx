// @vitest-environment jsdom
/**
 * The tag input and the tagged table (D1054): typing adds a tag, Backspace on
 * an empty box takes the last one off, a suggestion comes from the registry;
 * the search matches tag names, and the by-tag view lists a row with two tags
 * under both, untagged last.
 */
import type { TagEntry } from '@camstack/types'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialogProvider } from '../../confirm-dialog'
import type { DataColumn } from '../../data-table'
import { TagInput } from '../tag-input'
import { TaggedDataTable } from '../tagged-data-table'
import type { TagRegistry } from '../use-tag-registry'

const NO_COUNTS = { coreBlocks: 0, schedulers: 0, templates: 0, actions: 0, devices: 0 }

const ENTRIES: readonly TagEntry[] = [
  { name: 'Garden', color: 'tag-c', icon: 'tag', styled: true, counts: NO_COUNTS },
  { name: 'Night', color: 'tag-e', icon: 'tag', styled: false, counts: NO_COUNTS },
]

const registry: TagRegistry = {
  entries: ENTRIES,
  failed: false,
  presence: 'present',
  setStyle: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
}

vi.mock('../use-tag-registry', () => ({ useTagRegistry: () => registry }))

function Harness({ initial }: { readonly initial: readonly string[] }) {
  const [tags, setTags] = useState<readonly string[]>(initial)
  return (
    <>
      <TagInput value={tags} onChange={setTags} label="Tags" />
      <output data-testid="value">{tags.join('|')}</output>
    </>
  )
}

describe('TagInput', () => {
  it('Enter adds the typed tag, trimmed; Backspace on an empty box removes the last', () => {
    render(<Harness initial={['Garden']} />)
    const box = screen.getByRole('combobox', { name: 'Tags' })
    fireEvent.change(box, { target: { value: '  Porch ' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(screen.getByTestId('value').textContent).toBe('Garden|Porch')
    fireEvent.keyDown(box, { key: 'Backspace' })
    expect(screen.getByTestId('value').textContent).toBe('Garden')
  })

  it('suggests a tag in use that the record does not carry yet', () => {
    render(<Harness initial={['Garden']} />)
    const box = screen.getByRole('combobox', { name: 'Tags' })
    fireEvent.change(box, { target: { value: 'ni' } })
    const list = screen.getByRole('listbox')
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toContain('Night')
    expect(within(list).queryByText('Garden')).toBeNull()
  })
})

interface Row {
  readonly id: string
  readonly name: string
  readonly tags?: readonly string[]
}

const ROWS: readonly Row[] = [
  { id: 'a', name: 'Porch light', tags: ['Garden', 'Night'] },
  { id: 'b', name: 'Kitchen fan', tags: [] },
  { id: 'c', name: 'Sprinkler', tags: ['Garden'] },
]
const COLUMNS: readonly DataColumn<Row>[] = [
  { key: 'name', header: 'Name', render: (r) => r.name, sortValue: (r) => r.name },
]
const rowTags = (r: Row): readonly string[] | undefined => r.tags
const rowText = (r: Row): readonly string[] => [r.name]

function renderTable() {
  return render(
    <ConfirmDialogProvider>
      <TaggedDataTable<Row>
        section="spec"
        rows={ROWS}
        columns={COLUMNS}
        rowKey={(r) => r.id}
        getTags={rowTags}
        searchText={rowText}
        searchLabel="Search rows"
      />
    </ConfirmDialogProvider>,
  )
}

describe('TaggedDataTable', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('the search matches a tag name, not only the row text', () => {
    renderTable()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search rows' }), {
      target: { value: 'night' },
    })
    expect(screen.getByText('Porch light')).toBeTruthy()
    expect(screen.queryByText('Sprinkler')).toBeNull()
    expect(screen.queryByText('Kitchen fan')).toBeNull()
  })

  it('by tag: a row with two tags is in both groups, untagged last, and the choice is remembered', () => {
    const { unmount } = renderTable()
    fireEvent.click(screen.getByRole('radio', { name: 'By tag' }))
    const groups = within(screen.getByTestId('tag-groups-spec')).getAllByRole('region')
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Garden', 'Night', 'No tag'])
    expect(within(groups[0] as HTMLElement).getByText('Porch light')).toBeTruthy()
    expect(within(groups[1] as HTMLElement).getByText('Porch light')).toBeTruthy()
    expect(within(groups[2] as HTMLElement).getByText('Kitchen fan')).toBeTruthy()
    unmount()
    renderTable()
    expect(screen.getByTestId('tag-groups-spec')).toBeTruthy()
  })
})
