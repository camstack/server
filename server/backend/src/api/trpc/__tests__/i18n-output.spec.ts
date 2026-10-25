/**
 * D863 output points: the error formatter (coded error -> translated `message`,
 * code kept in `data.i18n`) and the schema-localizing middleware (`labelKey` ->
 * catalog text in the request language, English otherwise).
 */
import { getCatalogRegistry, resetCatalogRegistryForTests } from '@camstack/system'
import { userError } from '@camstack/types'
import { TRPCError } from '@trpc/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatTrpcError } from '../cap-route-error-formatter.js'
import { createCallerFactory, protectedProcedure, trpcRouter } from '../trpc.middleware.js'
import type { TrpcContext } from '../trpc.context.js'
import { trpcUserError } from '../user-error.js'

function shapeFor(message: string): Parameters<typeof formatTrpcError>[0]['shape'] {
  return { message, code: -32603, data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 } }
}

describe('error formatter', () => {
  it('translates a coded error to Italian and keeps the code and params in the payload', () => {
    const error = trpcUserError('NOT_FOUND', 'device.not-found', { id: 7 }, 'Device 7 not found')
    const out = formatTrpcError({ error, shape: shapeFor(error.message), ctx: { lang: 'it' } })
    expect(out.message).toBe('Dispositivo 7 non trovato')
    expect(out.data.i18n).toEqual({ code: 'device.not-found', params: { id: 7 } })
  })

  it('keeps the English message in English, with the code still in the payload', () => {
    const error = trpcUserError('NOT_FOUND', 'device.not-found', { id: 7 }, 'Device 7 not found')
    const out = formatTrpcError({ error, shape: shapeFor(error.message), ctx: { lang: 'en' } })
    expect(out.message).toBe('Device 7 not found')
    expect(out.data.i18n?.code).toBe('device.not-found')
  })

  it('leaves an unknown code with its original English message', () => {
    const error = trpcUserError('BAD_REQUEST', 'made.up-code', undefined, 'Something odd')
    const out = formatTrpcError({ error, shape: shapeFor(error.message), ctx: { lang: 'it' } })
    expect(out.message).toBe('Something odd')
  })

  it('passes a legacy error (no code) through unchanged, as a string message', () => {
    const error = new TRPCError({ code: 'BAD_REQUEST', message: 'Plain old failure' })
    const out = formatTrpcError({ error, shape: shapeFor(error.message), ctx: { lang: 'it' } })
    expect(out.message).toBe('Plain old failure')
    expect(typeof out.message).toBe('string')
    expect(out.data).not.toHaveProperty('i18n')
  })

  it('finds a code on a plain Error thrown from a handler (cause chain)', () => {
    const error = new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Invalid credentials',
      cause: userError('auth.invalid-credentials', undefined, 'Invalid credentials'),
    })
    const out = formatTrpcError({ error, shape: shapeFor(error.message), ctx: { lang: 'it' } })
    expect(out.message).toBe('Credenziali non valide')
  })

  it('answers English when the context carries no language (mesh)', () => {
    const error = trpcUserError('FORBIDDEN', 'auth.admin-required', undefined, 'Admin required')
    expect(formatTrpcError({ error, shape: shapeFor('Admin required') }).message).toBe(
      'Admin required',
    )
  })
})

describe('schema localization middleware', () => {
  beforeEach(() => {
    resetCatalogRegistryForTests()
    getCatalogRegistry().set(
      'demo',
      'it',
      { 'host.label': 'Server', 'sec.title': 'Connessione' },
      'spec',
    )
  })
  afterEach(() => resetCatalogRegistryForTests())

  const schema = {
    sections: [
      {
        id: 'sec',
        title: 'Connection',
        titleKey: 'demo:sec.title',
        fields: [
          { key: 'host', label: 'Host', labelKey: 'demo:host.label' },
          { key: 'port', label: 'Port', labelKey: 'demo:port.label' },
        ],
      },
    ],
  }
  const router = trpcRouter({
    addonSettings: trpcRouter({ getGlobalSettings: protectedProcedure.query(() => schema) }),
    other: trpcRouter({ getThing: protectedProcedure.query(() => schema) }),
  })
  const caller = createCallerFactory(router)
  const ctxFor = (lang?: 'en' | 'it'): TrpcContext => ({
    user: {
      id: 'u',
      username: 'u',
      isAdmin: true,
      isApiKey: false,
      permissions: { isAdmin: true, allowedProviders: '*', allowedDevices: {} },
      scopes: ['*'],
    },
    ...(lang !== undefined ? { lang } : {}),
  })

  it('serves the Italian text for it, English for en, and English for an unknown key', async () => {
    const italian = await caller(ctxFor('it')).addonSettings.getGlobalSettings()
    expect(italian.sections[0]?.title).toBe('Connessione')
    expect(italian.sections[0]?.fields[0]?.label).toBe('Server')
    expect(italian.sections[0]?.fields[1]?.label).toBe('Port')

    const en = await caller(ctxFor('en')).addonSettings.getGlobalSettings()
    expect(en).toEqual(schema)
    const none = await caller(ctxFor()).addonSettings.getGlobalSettings()
    expect(none).toEqual(schema)
  })

  it('only touches the methods that serve a schema', async () => {
    const other = await caller(ctxFor('it')).other.getThing()
    expect(other).toEqual(schema)
  })
})
