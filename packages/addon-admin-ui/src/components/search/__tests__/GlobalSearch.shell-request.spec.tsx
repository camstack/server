/**
 * GlobalSearch asked by the shell (D1096): while chromeless the box floats and is
 * absent until a `search` request arrives, which opens it with the shell's text.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { GlobalSearch } from '../GlobalSearch'

vi.mock('@dominevo/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dominevo/ui-library')>()
  const idle = () => ({ data: undefined, isLoading: false })
  return {
    ...actual,
    useDeviceManagerListAll: idle,
    useIntegrationsList: idle,
    useActionsList: idle,
    useCoreBlocksList: idle,
    useCoreBlocksListCompositions: idle,
    useSchedulersList: idle,
    useTemplateList: idle,
    useSearchFieldHotkey: () => undefined,
  }
})

function mount(request: { id: number; query: string } | null) {
  return render(
    <MemoryRouter>
      <GlobalSearch floating compact={false} navSections={[]} addonPages={[]} request={request} />
    </MemoryRouter>,
  )
}

describe('GlobalSearch floating for the shell', () => {
  it('renders nothing until the shell asks for a search', () => {
    mount(null)
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull()
  })

  it('opens with the requested text', () => {
    mount({ id: 1, query: 'garage' })
    expect(screen.getByPlaceholderText(/search/i)).toHaveProperty('value', 'garage')
  })
})
