/**
 * A send failure never echoes the URL it was sent to.
 *
 * Telegram carries the bot token in the request PATH, a Discord webhook URL is
 * the whole credential, and a webhook URL often holds a token in its path or
 * query. Node's `fetch` reports a malformed one as `Failed to parse URL from
 * <url>`, and a transport error names the url it dialled — so the raw error
 * string, returned in `SendResult.error` (shown in the admin test panel) and
 * logged, was a credential leak waiting for one bad value. Every error the
 * provider returns or logs goes through `stripUrls` first.
 */
import type { IScopedLogger, LogExtras, Target } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { NotifierAdapter } from '../adapters/adapter.js'
import { createNotificationOutputProvider, type HttpSender, stripUrls } from '../provider.js'
import { makeNotifiersRecords } from './fake-records.js'
import { TargetStore } from '../target-store.js'

interface LoggedLine {
  readonly message: string
  readonly extras: LogExtras | undefined
}

/** A logger that keeps every line, so a spec can prove what reached it. */
function capturingLogger(lines: LoggedLine[]): IScopedLogger {
  const push = (message: string, extras?: LogExtras): void => {
    lines.push({ message, extras })
  }
  const logger: IScopedLogger = {
    debug: push,
    info: push,
    warn: push,
    error: push,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

/** An adapter whose plan dials the stored `url` verbatim (the telegram/discord shape). */
function urlAdapter(build?: (config: Readonly<Record<string, unknown>>) => never): NotifierAdapter {
  return {
    descriptor: {
      kind: 'dial',
      label: 'Dial',
      icon: 'bell',
      addonId: 'notifiers',
      configSchema: { sections: [] },
      supportsDiscovery: false,
      caps: {
        attachments: { mediaTypes: [], mode: 'url', max: 0 },
        actions: 0,
        levels: [],
        format: ['text'],
        clickUrl: false,
        sound: false,
        ttl: false,
        bodyMaxLen: 1000,
      },
    },
    destinationKeys: ['url'],
    buildRequest: (config) => {
      if (build) return build(config)
      return { url: String(config['url']), body: { kind: 'json', value: {} } }
    },
  }
}

const TARGET: Target = {
  id: 't1',
  name: 'Bot',
  kind: 'dial',
  addonId: 'notifiers',
  enabled: true,
  config: { url: 'https://api.telegram.org/bot123456:SECRET-TOKEN/sendMessage' },
}

async function sendThrough(adapter: NotifierAdapter, httpSend: HttpSender) {
  const lines: LoggedLine[] = []
  const store = TargetStore.of((await makeNotifiersRecords()).records)
  const provider = createNotificationOutputProvider({
    store,
    adapters: [adapter],
    httpSend,
    logger: capturingLogger(lines),
  })
  await provider.upsertTarget({ target: TARGET })
  const result = await provider.testTarget({ targetId: 't1' })
  return { result, logged: JSON.stringify(lines) }
}

describe('send errors carry no URL', () => {
  it('a transport error naming the dialled url keeps its cause, not the url', async () => {
    const { result, logged } = await sendThrough(urlAdapter(), async (plan) => {
      throw new Error(`request to ${plan.url} failed, reason: ECONNRESET`)
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('ECONNRESET')
    expect(result.error).not.toContain('SECRET-TOKEN')
    expect(logged).toContain('ECONNRESET')
    expect(logged).not.toContain('SECRET-TOKEN')
  })

  it('a malformed stored url — no scheme, so no URL pattern matches it — is still cut', async () => {
    const { result, logged } = await sendThrough(urlAdapter(), async () => {
      throw new TypeError('Failed to parse URL from discord.com/api/webhooks/42/SECRET-TOKEN')
    })
    expect(result.error).not.toContain('SECRET-TOKEN')
    expect(result.error).toContain('Failed to parse URL')
    expect(logged).not.toContain('SECRET-TOKEN')
  })

  it('a buildRequest error that quotes the config is cut the same way', async () => {
    const throwing = urlAdapter((config) => {
      throw new Error(`bad endpoint ${String(config['url'])}`)
    })
    const { result, logged } = await sendThrough(throwing, async () => {
      throw new Error('unreachable')
    })
    expect(result.error).toMatch(/buildRequest failed/)
    expect(result.error).not.toContain('SECRET-TOKEN')
    expect(logged).not.toContain('SECRET-TOKEN')
  })
})

describe('stripUrls', () => {
  it('replaces every absolute url, and the tail of a parse failure', () => {
    expect(stripUrls('GET https://h.example/a?token=x and http://b/c failed')).toBe(
      'GET <url> and <url> failed',
    )
    expect(stripUrls('Failed to parse URL from example.com/secret')).toBe(
      'Failed to parse URL from <url>',
    )
    expect(stripUrls('HTTP 401 Unauthorized')).toBe('HTTP 401 Unauthorized')
    // A malformed value with a SPACE in it must not leak the part after it.
    expect(stripUrls('Failed to parse URL from bad value SECRET-TAIL')).toBe(
      'Failed to parse URL from <url>',
    )
  })
})
