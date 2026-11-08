import { describe, expect, it } from 'vitest'
import {
  heroLang,
  heroModelCovers,
  modelSaysAnything,
  pickText,
  sceneOf,
  sceneStateOf,
  uncoveredCaps,
} from '../hero-model-view'
import { buildModel, MEDIA_SLICE, PLUG_SLICES, WASHER_SLICES } from './fixtures'

describe('hero model -> scene props', () => {
  it('draws a running washer with the moving state, not the idle one', () => {
    const model = buildModel('washer', ['running-state', 'power-meter'], WASHER_SLICES)
    expect(sceneOf(model)).toMatchObject({ scene: 'washer', state: 'run' })
  })

  it('draws an unreported switch dim (unknown is never a moving state)', () => {
    const model = buildModel('switch', ['switch'], {
      switch: { on: null, lastChangedAt: 0 },
    })
    expect(model.state).toBe('unknown')
    expect(sceneStateOf(model)).toBe('off')
  })

  it('takes the scene mode over the generic state when the device says one', () => {
    const model = buildModel('media-player', ['media-player'], {
      'media-player': MEDIA_SLICE,
    })
    expect(model.scene.mode).toBe('playing')
    expect(sceneOf(model).state).toBe('playing')
  })

  it('carries a level only when the model has one', () => {
    const model = buildModel('media-player', ['media-player'], {
      'media-player': MEDIA_SLICE,
    })
    expect('level' in sceneOf(model)).toBe(model.scene.level !== null)
  })

  it('picks the operator language, English for anything else', () => {
    expect(heroLang('it-IT')).toBe('it')
    expect(heroLang('de')).toBe('en')
    expect(pickText({ en: 'On', it: 'Acceso' }, 'it')).toBe('Acceso')
  })
})

describe('hero model coverage', () => {
  it('covers a plug and a washer', () => {
    const plug = buildModel('switch', ['switch', 'power-meter'], PLUG_SLICES)
    const washer = buildModel('washer', ['running-state', 'power-meter'], WASHER_SLICES)
    expect(heroModelCovers(plug, ['switch', 'power-meter'])).toBe(true)
    expect(heroModelCovers(washer, ['running-state', 'power-meter'])).toBe(true)
  })

  it('no bound cap is left to the legacy hero (LATER_PHASE is empty)', () => {
    expect(uncoveredCaps(['switch', 'brightness', 'device-status', 'update'])).toEqual([])
  })

  it('falls back when the model has nothing to say', () => {
    const model = buildModel('sensor', ['device-status'], {})
    expect(modelSaysAnything(model)).toBe(false)
    expect(heroModelCovers(model, ['device-status'])).toBe(false)
  })
})
