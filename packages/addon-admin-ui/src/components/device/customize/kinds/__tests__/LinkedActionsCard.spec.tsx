/**
 * Linked actions (D356): the card lists what the camera links, and a link is
 * written only for what the operator ticked.
 */
import { DeviceType } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'

const CAMERA = {
  id: 103,
  name: 'Kitchen',
  addonId: 'provider-reolink',
  stableId: 'r-103',
  type: DeviceType.Camera,
  location: null,
  role: null,
  disabled: false,
  parentDeviceId: null,
  online: true,
  features: [],
  isCamera: true,
  config: {},
}

function entry(id: string, name: string, readOnly: boolean) {
  return { id, name, readOnly, addonId: readOnly ? 'provider-homeassistant' : 'automation' }
}
const ENTRIES = [
  entry('internal:feed', 'Feed the dog', false),
  entry('internal:lock', 'Lock up', false),
  entry('ha:movie', 'Movie night', true),
]

const linkedIds = vi.hoisted((): { current: readonly string[] } => ({ current: [] }))
const setLinks = vi.fn()
const runAction = vi.fn()

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useActionsList: () => ({ data: ENTRIES }),
    useActionsGetLinks: () => ({ data: { deviceId: 103, actionIds: linkedIds.current } }),
    useActionsSetLinks: () => ({ mutate: setLinks, isPending: false, error: null }),
    useActionsRun: () => ({ mutate: runAction, isPending: false }),
  }
})

import { LinkedActionsCard } from '../LinkedActionsCard'

function renderCard() {
  const client = new QueryClient()
  return render(
    <QueryClientProvider client={client}>
      <LinkedActionsCard device={CAMERA} />
    </QueryClientProvider>,
  )
}

describe('LinkedActionsCard', () => {
  beforeEach(() => {
    setLinks.mockClear()
    runAction.mockClear()
    linkedIds.current = []
  })

  it('shows nothing linked until the operator picks', () => {
    renderCard()
    expect(screen.getByText('None linked.')).toBeTruthy()
    expect(setLinks).not.toHaveBeenCalled()
  })

  it('links only the ticked actions, on top of the existing ones', () => {
    linkedIds.current = ['internal:feed']
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: /Add/ }))
    fireEvent.click(screen.getByText('Movie night'))
    fireEvent.click(screen.getByRole('button', { name: 'Add 1' }))
    expect(setLinks).toHaveBeenCalledWith({
      deviceId: 103,
      actionIds: ['internal:feed', 'ha:movie'],
    })
  })

  it('unlinks one action and runs another through this camera', () => {
    linkedIds.current = ['internal:feed', 'internal:lock']
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Run Lock up' }))
    expect(runAction).toHaveBeenCalledWith({ actionId: 'internal:lock', deviceId: 103 })
    fireEvent.click(screen.getByRole('button', { name: 'Unlink Feed the dog' }))
    expect(setLinks).toHaveBeenCalledWith({ deviceId: 103, actionIds: ['internal:lock'] })
  })
})
