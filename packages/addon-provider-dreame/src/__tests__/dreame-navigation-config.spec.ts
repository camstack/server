import { describe, expect, it } from 'vitest'
import {
  DREAME_NAVIGATION_DEFAULT_FEATURES,
  dreameNavigationCatalog,
  resolveDisabledEntryIds,
  resolveNavigationFeatures,
} from '../devices/dreame-navigation-config.js'

describe('navigation overrides are data on top of the defaults', () => {
  it('no override = the shipped defaults, goToPoint off', () => {
    expect(resolveNavigationFeatures(undefined)).toEqual(DREAME_NAVIGATION_DEFAULT_FEATURES)
    expect(resolveNavigationFeatures(undefined).goToPoint).toBe(false)
  })

  it('a device flag wins over the default, the rest stay', () => {
    const features = resolveNavigationFeatures({ features: { playSound: false, goToPoint: true } })
    expect(features).toMatchObject({ playSound: false, goToPoint: true, move: true })
  })

  it('a device can switch a dictionary entry off, and the catalog reports it disabled', () => {
    const ids = resolveDisabledEntryIds({ disabledEntryIds: ['dockWash', 'sound:bark'] })
    const catalog = dreameNavigationCatalog(ids)
    expect(catalog.find((e) => e.id === 'dockWash')?.enabled).toBe(false)
    expect(catalog.find((e) => e.id === 'sound:bark')?.enabled).toBe(false)
    expect(catalog.find((e) => e.id === 'goHome')?.enabled).toBe(true)
  })
})
