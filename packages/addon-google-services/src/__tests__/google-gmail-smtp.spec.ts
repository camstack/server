import { describe, expect, it, vi } from 'vitest'
import {
  buildRawMime,
  createGmailSmtpProvider,
  selectGmailAccount,
  type GmailAccountView,
} from '../google-gmail-smtp.js'

describe('buildRawMime', () => {
  it('builds a plain-text message with CRLF headers', () => {
    const raw = buildRawMime({
      from: 'me@example.com',
      to: 'you@example.com',
      subject: 'Hello',
      text: 'Body line',
    })
    expect(raw).toContain('From: me@example.com')
    expect(raw).toContain('To: you@example.com')
    expect(raw).toContain('Subject: Hello')
    expect(raw).toContain('Content-Type: text/plain')
    expect(raw).toContain('\r\n\r\nBody line')
  })

  it('builds multipart/alternative when html is set', () => {
    const raw = buildRawMime({
      from: 'me@example.com',
      to: ['a@example.com', 'b@example.com'],
      subject: 'Hi',
      text: 'plain',
      html: '<p>html</p>',
    })
    expect(raw).toContain('multipart/alternative')
    expect(raw).toContain('text/html')
    expect(raw).toContain('<p>html</p>')
    expect(raw).toContain('To: a@example.com, b@example.com')
  })
})

describe('selectGmailAccount', () => {
  const a: GmailAccountView = {
    brokerId: 'google_001',
    accountEmail: 'a@example.com',
    fromAddress: '',
    fromName: '',
    connected: true,
    getAccessToken: async () => 'tok-a',
  }
  const b: GmailAccountView = {
    brokerId: 'google_002',
    accountEmail: 'b@example.com',
    fromAddress: 'alias-b@example.com',
    fromName: '',
    connected: true,
    getAccessToken: async () => 'tok-b',
  }

  it('matches From to accountEmail or fromAddress', () => {
    expect(selectGmailAccount([a, b], 'b@example.com')?.brokerId).toBe('google_002')
    expect(selectGmailAccount([a, b], 'Alias-B@example.com')?.brokerId).toBe('google_002')
  })

  it('falls back to the first connected when From is absent', () => {
    expect(selectGmailAccount([a, b], undefined)?.brokerId).toBe('google_001')
  })

  it('ignores disconnected accounts', () => {
    expect(selectGmailAccount([{ ...a, connected: false }, b], undefined)?.brokerId).toBe(
      'google_002',
    )
  })
})

describe('createGmailSmtpProvider', () => {
  function make(accounts: GmailAccountView[], httpFetch?: typeof globalThis.fetch) {
    return createGmailSmtpProvider({
      accounts: () => accounts,
      fetch: httpFetch,
    })
  }

  const accountA: GmailAccountView = {
    brokerId: 'google_001',
    accountEmail: 'a@example.com',
    fromAddress: 'a@example.com',
    fromName: '',
    connected: true,
    getAccessToken: async () => 'tok-a',
  }
  const accountB: GmailAccountView = {
    brokerId: 'google_002',
    accountEmail: 'b@example.com',
    fromAddress: 'b@example.com',
    fromName: '',
    connected: true,
    getAccessToken: async () => 'tok-b',
  }

  it('getStatus is not ready when disconnected', async () => {
    const smtp = make([{ ...accountA, connected: false }])
    const status = await smtp.getStatus()
    expect(status.ready).toBe(false)
    expect(status.error).toMatch(/not connected|No Google broker/i)
  })

  it('verify hits Gmail profile and marks ready', async () => {
    const calls: string[] = []
    const fetchMock: typeof fetch = async (url) => {
      calls.push(String(url))
      return {
        ok: true,
        text: async () => '',
        json: async () => ({ emailAddress: 'a@example.com' }),
      } as Response
    }
    const smtp = make([accountA], fetchMock)
    const status = await smtp.verify()
    expect(calls[0]).toContain('/users/me/profile')
    expect(status.ready).toBe(true)
    expect(status.error).toBeUndefined()
  })

  it('sendEmail without from uses the first connected account token', async () => {
    const tokens: string[] = []
    const fetchMock: typeof fetch = async (url, init) => {
      if (String(url).includes('/messages/send')) {
        const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '')
        tokens.push(auth)
        return {
          ok: true,
          json: async () => ({ id: 'msg-1' }),
        } as Response
      }
      return { ok: true, json: async () => ({}) } as Response
    }
    const smtp = make([accountA, accountB], fetchMock)
    await smtp.sendEmail({
      to: 'you@example.com',
      subject: 'Subj',
      text: 'Hello world',
    })
    expect(tokens[0]).toContain('tok-a')
  })

  it('sendEmail with from matching B uses B token', async () => {
    const tokens: string[] = []
    const fetchMock: typeof fetch = async (url, init) => {
      if (String(url).includes('/messages/send')) {
        const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '')
        tokens.push(auth)
        return {
          ok: true,
          json: async () => ({ id: 'msg-2' }),
        } as Response
      }
      return { ok: true, json: async () => ({}) } as Response
    }
    const getA = vi.fn(async () => 'tok-a')
    const getB = vi.fn(async () => 'tok-b')
    const smtp = make(
      [
        { ...accountA, getAccessToken: getA },
        { ...accountB, getAccessToken: getB },
      ],
      fetchMock,
    )
    await smtp.sendEmail({
      to: 'you@example.com',
      from: 'b@example.com',
      subject: 'Subj',
      text: 'Hello',
    })
    expect(getB).toHaveBeenCalled()
    expect(getA).not.toHaveBeenCalled()
    expect(tokens[0]).toContain('tok-b')
  })
})
