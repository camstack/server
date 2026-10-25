import { describe, expect, it } from 'vitest'
import { deviceIntegrationResolver, resolveDeviceIntegration } from '../device-integration'

// The live case (D659): "Porch (composto)", id 4603, is SERVED by the
// `composer` addon and was CREATED by the "Blocks" integration (int_0024),
// whose own addonId is `core-blocks`.
const BLOCKS = { id: 'int_0024', addonId: 'core-blocks', name: 'Blocks' }
const COMPOSER_INTEGRATION = { id: 'int_0099', addonId: 'composer', name: 'Composer' }
const REOLINK = { id: 'int_reolink', addonId: 'provider-reolink', name: 'Reolink' }

describe('resolveDeviceIntegration', () => {
  it('integrationId wins over addonId', () => {
    const r = resolveDeviceIntegration({ addonId: 'composer', integrationId: 'int_0024' }, [
      COMPOSER_INTEGRATION,
      BLOCKS,
    ])
    expect(r).toEqual({ kind: 'resolved', integration: BLOCKS })
  })

  it('a composed device resolves to Blocks even when no integration serves its addonId', () => {
    const r = resolveDeviceIntegration({ addonId: 'composer', integrationId: 'int_0024' }, [
      BLOCKS,
      REOLINK,
    ])
    expect(r).toEqual({ kind: 'resolved', integration: BLOCKS })
  })

  it('an integrationId no registered integration answers is orphan, whatever the addonId', () => {
    const r = resolveDeviceIntegration({ addonId: 'core-blocks', integrationId: 'int_gone' }, [
      BLOCKS,
    ])
    expect(r).toEqual({ kind: 'orphan' })
  })

  it('legacy rows (no integrationId) fall back to the addonId', () => {
    expect(resolveDeviceIntegration({ addonId: 'provider-reolink' }, [BLOCKS, REOLINK])).toEqual({
      kind: 'resolved',
      integration: REOLINK,
    })
    expect(
      resolveDeviceIntegration({ addonId: 'provider-reolink', integrationId: null }, [REOLINK]),
    ).toEqual({ kind: 'resolved', integration: REOLINK })
    expect(
      resolveDeviceIntegration({ addonId: 'provider-reolink', integrationId: '' }, [REOLINK]),
    ).toEqual({ kind: 'resolved', integration: REOLINK })
  })

  it('a legacy row whose addonId no integration has is orphan', () => {
    expect(resolveDeviceIntegration({ addonId: 'gone-addon' }, [REOLINK])).toEqual({
      kind: 'orphan',
    })
  })

  it('a LOADED empty list is an answer: a linked device is orphan', () => {
    expect(
      resolveDeviceIntegration({ addonId: 'composer', integrationId: 'int_0024' }, []),
    ).toEqual({ kind: 'orphan' })
  })

  it('an UNANSWERED integrations list is unknown — never orphan', () => {
    expect(
      resolveDeviceIntegration({ addonId: 'composer', integrationId: 'int_0024' }, undefined),
    ).toEqual({ kind: 'unknown' })
    expect(resolveDeviceIntegration({ addonId: 'gone-addon' }, null)).toEqual({ kind: 'unknown' })
  })

  it('a row naming no link at all is unlinked, not orphan', () => {
    expect(resolveDeviceIntegration({ addonId: '' }, [REOLINK])).toEqual({ kind: 'unlinked' })
  })
})

describe('deviceIntegrationResolver', () => {
  it('prepared once, gives the same answers per row', () => {
    const resolve = deviceIntegrationResolver([COMPOSER_INTEGRATION, BLOCKS, REOLINK])
    expect(resolve({ addonId: 'composer', integrationId: 'int_0024' })).toEqual({
      kind: 'resolved',
      integration: BLOCKS,
    })
    expect(resolve({ addonId: 'provider-reolink' })).toEqual({
      kind: 'resolved',
      integration: REOLINK,
    })
    expect(resolve({ addonId: 'x', integrationId: 'int_gone' })).toEqual({ kind: 'orphan' })
  })

  it('an unanswered list resolves every row to unknown', () => {
    const resolve = deviceIntegrationResolver(undefined)
    expect(resolve({ addonId: 'composer', integrationId: 'int_0024' })).toEqual({ kind: 'unknown' })
  })
})
