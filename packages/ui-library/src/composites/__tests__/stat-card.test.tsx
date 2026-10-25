// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Activity } from 'lucide-react'

import { StatCard } from '../stat-card'

describe('StatCard', () => {
  it('renders label, value and optional subtext', () => {
    render(<StatCard label="Phase" value="Watching" subtext="motion" />)
    expect(screen.getByText('Phase')).toBeTruthy()
    expect(screen.getByText('Watching')).toBeTruthy()
    expect(screen.getByText('motion')).toBeTruthy()
  })

  it('renders an optional icon', () => {
    const { container } = render(<StatCard label="Phase" value="Watching" icon={Activity} />)
    expect(container.querySelector('svg.lucide-activity')).not.toBeNull()
  })

  it('applies valueClassName to the value', () => {
    render(<StatCard label="Rec" value="Active" valueClassName="text-success" />)
    expect(screen.getByText('Active').className).toContain('text-success')
  })

  it('renders a trend marker', () => {
    render(<StatCard label="FPS" value={12} trend={{ value: 3, direction: 'up' }} />)
    expect(screen.getByText('3%')).toBeTruthy()
  })
})
