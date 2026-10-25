import { SECRET_CLEAR } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  HOMECOM_CLIENT_ID,
  HOMECOM_REDIRECT_URI,
  HOMECOM_SCOPE,
  HOMECOM_TOKEN_URL,
} from '../../homecom/homecom-oauth.js'
import {
  HOME_CONNECT_AUTHORIZE_SCOPE,
  HOME_CONNECT_CLIENT_ID,
  HOME_CONNECT_OAUTH_BASE,
  HOME_CONNECT_REDIRECT_URI,
} from '../home-connect-login.js'
import {
  homeConnectSignOutPatch,
  homeConnectSignedInAccount,
} from '../home-connect-account-status.js'

describe('HomeCom and Home Connect sign-in are different clients', () => {
  it('does not share client id, token endpoint, redirect or scope', () => {
    expect(HOMECOM_CLIENT_ID).not.toBe(HOME_CONNECT_CLIENT_ID)
    expect(HOMECOM_TOKEN_URL).not.toBe(`${HOME_CONNECT_OAUTH_BASE}token`)
    expect(HOMECOM_REDIRECT_URI).not.toBe(HOME_CONNECT_REDIRECT_URI)
    expect(HOMECOM_SCOPE).not.toBe(HOME_CONNECT_AUTHORIZE_SCOPE)
  })
})

describe('homeConnect sign-out', () => {
  it('clears the account secrets and reads the stored label', () => {
    expect(homeConnectSignOutPatch()).toEqual({
      token: SECRET_CLEAR,
      refresh: SECRET_CLEAR,
      applianceSecrets: SECRET_CLEAR,
      appliances: [],
      accountLabel: '',
    })
    expect(homeConnectSignedInAccount({ accountLabel: 'subject-1' })).toBe('subject-1')
    expect(homeConnectSignedInAccount({})).toBe('')
  })
})
