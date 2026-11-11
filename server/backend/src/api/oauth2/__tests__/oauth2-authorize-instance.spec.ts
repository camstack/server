/**
 * `instance=` on `/api/oauth2/authorize` (planning#415): which instance of an
 * integration an account is being linked to.
 */
import { describe, expect, it } from 'vitest'
import {
  type AuthorizeQuery,
  type IntegrationPolicy,
  validateAuthorizeQuery,
} from '../oauth2-routes.js'

const base: AuthorizeQuery = {
  response_type: 'code',
  integration: 'voice',
  redirect_uri: 'https://cb.example/r',
  state: 's',
}

const multi = new Map<string, IntegrationPolicy>([
  ['voice', { addonId: 'export-voice', instances: [{ id: 'second' }, { id: 'third' }] }],
])
const single = new Map<string, IntegrationPolicy>([['voice', { addonId: 'export-voice' }]])

function instanceOf(q: AuthorizeQuery, known: ReadonlyMap<string, IntegrationPolicy>) {
  const v = validateAuthorizeQuery(q, known)
  return v.ok ? { ok: true, instance: v.instance } : { ok: false, error: v.error }
}

describe('authorize — instance parameter', () => {
  it('links to a declared instance', () => {
    expect(instanceOf({ ...base, instance: 'second' }, multi)).toEqual({
      ok: true,
      instance: 'second',
    })
  })

  it('links to the default instance when the parameter is absent or empty', () => {
    expect(instanceOf(base, multi)).toEqual({ ok: true, instance: null })
    expect(instanceOf({ ...base, instance: '' }, multi)).toEqual({ ok: true, instance: null })
    expect(instanceOf(base, single)).toEqual({ ok: true, instance: null })
  })

  it('reads the addon id as the default instance, so the default has one spelling on a link', () => {
    expect(instanceOf({ ...base, instance: 'export-voice' }, multi)).toEqual({
      ok: true,
      instance: null,
    })
    expect(instanceOf({ ...base, instance: 'export-voice' }, single)).toEqual({
      ok: true,
      instance: null,
    })
  })

  it('refuses an instance the integration did not declare', () => {
    expect(instanceOf({ ...base, instance: 'fourth' }, multi)).toEqual({
      ok: false,
      error: 'invalid_request — unknown instance',
    })
  })

  it('refuses any instance on an integration that declares none', () => {
    expect(instanceOf({ ...base, instance: 'second' }, single)).toEqual({
      ok: false,
      error: 'invalid_request — unknown instance',
    })
  })

  it('refuses an instance that is not a plain id', () => {
    expect(instanceOf({ ...base, instance: 'a/b' }, multi)).toEqual({
      ok: false,
      error: 'invalid_request — instance is not a valid id',
    })
  })

  it('collapses a repeat with one value and refuses a repeat that disagrees', () => {
    expect(instanceOf({ ...base, instance: ['second', 'second'] }, multi)).toEqual({
      ok: true,
      instance: 'second',
    })
    expect(instanceOf({ ...base, instance: ['second', 'third'] }, multi)).toEqual({
      ok: false,
      error: 'invalid_request — instance parameter repeated with conflicting values',
    })
  })
})
