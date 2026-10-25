/**
 * @vitest-environment jsdom
 *
 * System → Data → Records: Entries and Deleted devices are views of the ONE
 * Records section, and the old tab links still land there.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../components/system/deleted-devices/DeletedDevicesData', () => ({
  DeletedDevicesData: () => <div data-testid="deleted-devices" />,
}))
vi.mock('../Storage', () => ({ StoragePage: () => <div /> }))
vi.mock('../Backup', () => ({ BackupPage: () => <div /> }))
vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return { ...actual, DataRecordsHub: () => <div data-testid="records-hub" /> }
})

import { DataPage } from '../Data'
import { DataRecordsSection } from '../DataRecordsSection'

function Where() {
  const loc = useLocation()
  return <div data-testid="where">{loc.search}</div>
}

afterEach(cleanup)

describe('DataRecordsSection', () => {
  it('shows the unified hub by default and the deleted-devices view on toggle', () => {
    render(
      <MemoryRouter initialEntries={['/system/data?tab=records']}>
        <DataRecordsSection />
        <Where />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('records-hub')).toBeTruthy()
    expect(screen.queryByTestId('deleted-devices')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /deleted devices/i }))
    expect(screen.getByTestId('deleted-devices')).toBeTruthy()
    expect(screen.getByTestId('where').textContent).toContain('view=deleted-devices')
  })
})

describe('DataPage legacy tabs', () => {
  it.each([
    ['entries', 'tab=records', null],
    ['deleted-devices', 'tab=records', 'view=deleted-devices'],
  ])('?tab=%s lands in Records', (legacy, tab, view) => {
    render(
      <MemoryRouter initialEntries={[`/system/data?tab=${legacy}`]}>
        <DataPage />
        <Where />
      </MemoryRouter>,
    )
    const search = screen.getByTestId('where').textContent ?? ''
    expect(search).toContain(tab)
    if (view !== null) expect(search).toContain(view)
    else expect(search).not.toContain('view=')
  })
})
