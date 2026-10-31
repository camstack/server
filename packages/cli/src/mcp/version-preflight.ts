/**
 * Preflight of every tool call: a cached, shared, time-boxed version probe
 * whose one-line warning is prepended to the tool's result. The tool itself is
 * never delayed past the budget and never changed otherwise.
 *
 * The wrap point is the TRANSPORT, not the tool registrations: the SDK has no
 * typed hook around a tool handler, and the toolsets register through both
 * `server.tool` and `server.registerTool`, so a transport wrapper is the one
 * place that sees every `tools/call` (develop toolset included).
 * Diagnostics go to stderr: stdout is the protocol.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js'
import { failureReason, formatWarning, type VersionProbe } from './version-probe.js'

export const VERSION_CHECK_TOOL = 'version_check'
export const PREFLIGHT_TTL_MS = 15 * 60_000
export const PREFLIGHT_TIMEOUT_MS = 2_000

export interface PreflightConfig {
  readonly probe: () => Promise<VersionProbe>
  /** Injectable clock (ms epoch). */
  readonly now?: () => number
  readonly ttlMs?: number
  readonly timeoutMs?: number
  readonly log?: (line: string) => void
}

interface Cached {
  readonly at: number
  readonly probe: VersionProbe
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class VersionPreflight {
  private cache: Cached | null = null
  private inflight: Promise<VersionProbe> | null = null
  private failureShown = false
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private readonly log: (line: string) => void

  constructor(private readonly config: PreflightConfig) {
    this.now = config.now ?? Date.now
    this.ttlMs = config.ttlMs ?? PREFLIGHT_TTL_MS
    this.timeoutMs = config.timeoutMs ?? PREFLIGHT_TIMEOUT_MS
    this.log = config.log ?? ((line) => process.stderr.write(`${line}\n`))
  }

  /** Runs (or joins) the probe and caches its answer; a throw becomes an `unavailable` probe. */
  private run(): Promise<VersionProbe> {
    if (this.inflight) return this.inflight
    const started = this.config
      .probe()
      .catch(
        (err: unknown): VersionProbe => ({
          server: { state: 'unknown', reason: errorText(err) },
          addons: { state: 'unknown', reason: errorText(err) },
          cli: { state: 'unknown', reason: errorText(err) },
        }),
      )
      .then((probe) => {
        this.cache = { at: this.now(), probe }
        this.inflight = null
        return probe
      })
    this.inflight = started
    return started
  }

  /** The probe, skipping the TTL (for `version_check`). */
  refresh(): Promise<VersionProbe> {
    return this.run()
  }

  /** The line to prepend to a tool result, or `null`. Never waits past the budget. */
  async lineForCall(): Promise<string | null> {
    const cached = this.cache
    let probe: VersionProbe | null = null
    if (cached && this.now() - cached.at < this.ttlMs) probe = cached.probe
    else probe = await this.withinBudget(this.run())
    if (probe === null) return null
    const warning = formatWarning(probe)
    if (warning !== null) return warning
    const failure = failureReason(probe)
    if (failure === null) return null
    this.log(`camstack mcp: version check unavailable: ${failure}`)
    if (this.failureShown) return null
    this.failureShown = true
    return `version check unavailable: ${failure}`
  }

  private async withinBudget(work: Promise<VersionProbe>): Promise<VersionProbe | null> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.timeoutMs)
    })
    try {
      return await Promise.race([work, timeout])
    } finally {
      clearTimeout(timer)
    }
  }
}

function prependLine(message: JSONRPCMessage, line: string): JSONRPCMessage {
  if (!isJSONRPCResultResponse(message)) return message
  const content: unknown = message.result['content']
  if (!Array.isArray(content)) return message
  const block = { type: 'text', text: line }
  return {
    ...message,
    result: { ...message.result, content: [block, ...content] },
  }
}

/** Wraps a transport: waits for the preflight before a `tools/call` is handled, decorates its answer. */
class PreflightTransport implements Transport {
  onmessage?: Transport['onmessage']
  private readonly lines = new Map<RequestId, string>()

  constructor(
    private readonly inner: Transport,
    private readonly preflight: VersionPreflight,
  ) {
    inner.onmessage = (message: JSONRPCMessage, extra?: MessageExtraInfo) => {
      if (isJSONRPCRequest(message) && message.method === 'tools/call') {
        void this.gated(message, extra)
        return
      }
      this.onmessage?.(message, extra)
    }
  }

  private async gated(
    message: JSONRPCMessage & { id: RequestId; params?: { name?: unknown } },
    extra?: MessageExtraInfo,
  ): Promise<void> {
    if (message.params?.name !== VERSION_CHECK_TOOL) {
      const line = await this.preflight.lineForCall().catch((err: unknown) => {
        process.stderr.write(`camstack mcp: version preflight failed: ${errorText(err)}\n`)
        return null
      })
      if (line !== null) this.lines.set(message.id, line)
    }
    this.onmessage?.(message, extra)
  }

  start(): Promise<void> {
    return this.inner.start()
  }

  send(message: JSONRPCMessage, options?: Parameters<Transport['send']>[1]): Promise<void> {
    if (isJSONRPCResultResponse(message)) {
      const line = this.lines.get(message.id)
      if (line !== undefined) {
        this.lines.delete(message.id)
        return this.inner.send(prependLine(message, line), options)
      }
    }
    if (isJSONRPCErrorResponse(message) && message.id !== undefined) this.lines.delete(message.id)
    return this.inner.send(message, options)
  }

  close(): Promise<void> {
    return this.inner.close()
  }

  get onclose(): Transport['onclose'] {
    return this.inner.onclose
  }
  set onclose(handler: Transport['onclose']) {
    this.inner.onclose = handler
  }
  get onerror(): Transport['onerror'] {
    return this.inner.onerror
  }
  set onerror(handler: Transport['onerror']) {
    this.inner.onerror = handler
  }
  get sessionId(): string | undefined {
    return this.inner.sessionId
  }
  get setProtocolVersion(): Transport['setProtocolVersion'] {
    return this.inner.setProtocolVersion?.bind(this.inner)
  }
}

/** An `McpServer` whose every `tools/call` runs behind the version preflight. */
export class PreflightMcpServer extends McpServer {
  constructor(
    info: ConstructorParameters<typeof McpServer>[0],
    readonly preflight: VersionPreflight,
  ) {
    super(info)
  }

  override connect(transport: Transport): Promise<void> {
    return super.connect(new PreflightTransport(transport, this.preflight))
  }
}
