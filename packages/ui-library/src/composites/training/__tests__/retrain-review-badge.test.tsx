// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RETRAIN_REVIEW_STATUSES } from '@camstack/types'
import { RetrainReviewBadge, retrainReviewBadgeLook } from '../retrain-review-badge'

describe('retrain review badge', () => {
  it('maps every review status to a look', () => {
    for (const status of RETRAIN_REVIEW_STATUSES) {
      expect(retrainReviewBadgeLook(status).label.length).toBeGreaterThan(0)
    }
  })

  it('maps the vocabulary to the agreed colours', () => {
    expect(retrainReviewBadgeLook('added').variant).toBe('success')
    expect(retrainReviewBadgeLook('removed').variant).toBe('danger')
    expect(retrainReviewBadgeLook('reclassified').variant).toBe('warning')
    expect(retrainReviewBadgeLook('adjusted').variant).toBe('info')
    expect(retrainReviewBadgeLook('unchanged').variant).toBe('neutral')
  })

  it('keeps model-error visually distinct from removed', () => {
    const a = retrainReviewBadgeLook('model-error')
    const b = retrainReviewBadgeLook('removed')
    expect(a.style).toBe('outline')
    expect(b.style).toBe('fill')
  })

  it('marks an approximate outline dashed and an approximate fill with a tilde', () => {
    render(<RetrainReviewBadge kind="draft" approximate />)
    expect(screen.getByText('Draft').className).toContain('border-dashed')
    render(<RetrainReviewBadge kind="added" approximate />)
    expect(screen.getByText('Added ~')).not.toBeNull()
  })
})
