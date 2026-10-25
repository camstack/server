/**
 * Every location row starts its content in the SAME column.
 *
 * ## The report
 *
 * 2026-09-10, operator screenshot of the Data page. The provider badge is
 * rendered at its own intrinsic width — `FILESYSTEM-STORAGE` is eighteen
 * characters, `SMB-STORAGE` is eleven — and the rest of the row sits AFTER it
 * in the same flex line. So the name, the path and the capacity bar of an SMB
 * location began ~85 px to the left of its neighbours, and because the bar is
 * `w-full` inside that shifted column it ended short too. Stacked in a group,
 * the bars read as a ragged staircase rather than a scale.
 *
 * Nothing was wrong with the bar: it is the column in front of it that had no
 * width of its own.
 *
 * ## The rule
 *
 * A badge whose text length varies with the DATA cannot define a column. The
 * badge keeps its intrinsic size — stretching a short one to eighteen
 * characters would draw a box mostly made of air — and it is placed inside a
 * fixed-width slot, so the column after it is the same for every row.
 *
 * The slot is a `sm:` width on purpose: on a phone the row wraps anyway and a
 * 128 px reservation there is 40% of the viewport spent on a label.
 */
import type { StorageLocation } from '@camstack/types'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocationCard } from '../LocationCard'
import { type LocationModeReasons, modeBlockedReasons } from '../location-mode'

afterEach(() => {
  cleanup()
})

const BASE: StorageLocation = {
  id: 'recordings:nvme',
  type: 'recordings',
  displayName: 'NVMe',
  providerId: 'filesystem',
  config: { basePath: '/mnt/nvme/rec' },
  nodeId: 'agent-1',
  isSystem: false,
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
}

const ALLOWED: LocationModeReasons = modeBlockedReasons(BASE, [BASE])

function locationWith(providerId: string): StorageLocation {
  return { ...BASE, id: `recordings:${providerId}`, providerId }
}

function badgeSlotOf(providerId: string): HTMLElement {
  const { container } = render(
    <LocationCard
      location={locationWith(providerId)}
      cardinality="multi"
      canDelete
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onSetMode={vi.fn()}
      blockedReasons={ALLOWED}
      ownedBytes={null}
    />,
  )
  const slot = container.querySelector('[data-testid="location-badge-slot"]')
  if (!(slot instanceof HTMLElement)) throw new Error('no badge slot rendered')
  return slot
}

describe('the provider badge does not define the column', () => {
  it('reserves the SAME slot for a long provider id and a short one', () => {
    const long = badgeSlotOf('filesystem-storage').className
    const short = badgeSlotOf('smb-storage').className
    expect(short, 'the slot width depends on the provider id, so rows do not line up').toBe(long)
  })

  it('the slot carries an explicit width, not one inherited from its text', () => {
    // A class list with no width is the defect: the slot would collapse onto
    // the badge and we would be back to an intrinsic column.
    expect(badgeSlotOf('smb-storage').className).toMatch(/\bw-\[?[\dA-Za-z.]+\]?/)
  })

  it('does not reserve that width on a phone, where the row wraps anyway', () => {
    // 128 px of label column is 40% of a 320 px viewport.
    expect(badgeSlotOf('smb-storage').className).toMatch(/\bsm:w-/)
  })

  it('still renders the badge text itself', () => {
    expect(badgeSlotOf('smb-storage').textContent).toContain('smb-storage')
  })
})
