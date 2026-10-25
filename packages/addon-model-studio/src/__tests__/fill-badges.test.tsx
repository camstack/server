// @vitest-environment jsdom
/**
 * D737 — a model card lists "masks" among what a root supplies when the
 * model's decode emits an instance mask per detection (a YOLO26-seg build).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { COCO_80_LABELS, COCO_TO_MACRO, rootSuppliesOf } from '@camstack/types'
import { FillBadges } from '../components/FillBadges.js'

afterEach(cleanup)

const STEP_DEFAULTS = { labels: COCO_80_LABELS.map((l) => l.id), classMap: COCO_TO_MACRO }
const IN_640 = { width: 640, height: 640 }

describe('FillBadges', () => {
  it('a seg root card lists masks after the COCO label supplies', () => {
    const supplies = rootSuppliesOf(
      { labels: [], inputSize: IN_640, postprocessor: 'yolo-seg' },
      STEP_DEFAULTS,
    )
    render(<FillBadges supplies={supplies} />)
    const badges = screen.getByTestId('fill-badges')
    expect([...badges.children].map((b) => b.textContent)).toEqual([
      'animals 6/8',
      'vehicles 5/8',
      'masks',
    ])
    expect(screen.getByText('masks').getAttribute('title')).toMatch(/Segmentation step/)
  })

  it('the plain detector card lists no masks', () => {
    render(
      <FillBadges supplies={rootSuppliesOf({ labels: [], inputSize: IN_640 }, STEP_DEFAULTS)} />,
    )
    expect(screen.queryByText('masks')).toBeNull()
  })
})
