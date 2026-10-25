/**
 * `POST /addon/ai/test-chat` — the data-plane handler.
 *
 * Also serves `GET /addon/ai/test-chat/chats` (list) and
 * `GET /addon/ai/test-chat/chats/:id` (resume) for the caller's private
 * history. The generation wire is unchanged: NDJSON, cancel, one usage row.
 *
 * The hub authenticates (`access: 'authenticated'`) and reverse-proxies to the
 * `127.0.0.1` listener this addon binds; from there it is a real
 * `ServerResponse` and the addon owns every byte. Nothing about the generation
 * touches UDS, which is what the 60 s cap lived on.
 *
 * ## The two things that make it actually stream
 *
 * **No compression, declared twice.** The hub's `/addon/:addonId/*` route is
 * registered `{ compress: false }` and a data-plane hit is `reply.hijack()`ed
 * and piped raw, so nothing compresses this today. The handler still sends
 * `content-encoding: identity` and `x-no-compression` because "no compressor in
 * front of this" is a fact with a shelf life, and a buffered stream is
 * invisible until an operator waits two minutes for a first token that was
 * already sitting in a Brotli window. This repo has paid for it twice — an SSE
 * stream gzipped into silence, and a pull that died with `TypeError:
 * terminated`.
 *
 * **`flushHeaders()` before the first event.** Without it Node holds the head
 * until the first write is large enough, and the client's `fetch` promise does
 * not settle — so the page shows nothing at all during the phase it most needs
 * to show something.
 *
 * ## Abort
 *
 * Browser aborts its `fetch` → the hub's `clientRes` closes → `proxyToUpstream`
 * destroys the upstream request → this `res` emits `close` → we abort the
 * controller the provider fetch is holding. No orphan generation keeps a GPU
 * warm because someone closed a tab.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DataPlaneHandler, IScopedLogger } from '@camstack/types'
import type { ChatRetention, ChatStore } from './chat-store.js'
import {
  TestChatRequestSchema,
  encodeEvent,
  type TestChatAttachment,
  type TestChatEvent,
  type TestChatRequest,
} from './contract.js'
import { commitPersistentTurn, resolveStreamMessages } from './persist.js'
import { runTestChatStream, type TestChatStreamDeps } from './run-stream.js'
import { readUserIdFromRequest } from './user-from-request.js'

/** Bounded so a malformed or hostile body cannot buy memory. */
const MAX_BODY_BYTES = 256 * 1024

export interface TestChatPlaneDeps {
  readonly stream: TestChatStreamDeps
  readonly logger: IScopedLogger
  readonly chats?: ChatStore
  readonly retention?: () => ChatRetention
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    total += buf.byteLength
    if (total > MAX_BODY_BYTES) return null
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function pathParts(url: string | undefined): string[] {
  const path = (url ?? '/').split('?')[0] ?? '/'
  return path.split('/').filter((p) => p.length > 0)
}

function requireUser(req: IncomingMessage, res: ServerResponse): string | null {
  const userId = readUserIdFromRequest(req)
  if (userId === null) {
    sendJson(res, 401, { error: 'unauthenticated' })
    return null
  }
  return userId
}

async function handleList(
  deps: TestChatPlaneDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (deps.chats === undefined) {
    sendJson(res, 503, { error: 'chat store unavailable' })
    return
  }
  const userId = requireUser(req, res)
  if (userId === null) return
  const chats = await deps.chats.list(userId)
  sendJson(res, 200, { chats })
}

async function handleGet(
  deps: TestChatPlaneDeps,
  req: IncomingMessage,
  res: ServerResponse,
  conversationId: string,
): Promise<void> {
  if (deps.chats === undefined) {
    sendJson(res, 503, { error: 'chat store unavailable' })
    return
  }
  const userId = requireUser(req, res)
  if (userId === null) return
  const conversation = await deps.chats.get(userId, conversationId)
  if (conversation === null) {
    sendJson(res, 404, { error: 'conversation not found' })
    return
  }
  sendJson(res, 200, conversation)
}

async function handleStream(
  deps: TestChatPlaneDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await readBody(req)
  if (raw === null) {
    sendJson(res, 413, { error: 'request body too large' })
    return
  }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    sendJson(res, 400, { error: 'invalid JSON body' })
    return
  }

  // `.strict()` — an unknown key is a 400 NAMING it, never a silent strip.
  // A request that spelled the attachment field wrong once produced a
  // confident text-only answer to a vision question, with nothing anywhere
  // saying the picture had been dropped.
  const parsed = TestChatRequestSchema.safeParse(parsedJson)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    deps.logger.warn('ai test chat: request rejected — turn never ran', {
      meta: { detail },
    })
    sendJson(res, 400, { error: 'invalid request', detail })
    return
  }

  let request: TestChatRequest = parsed.data
  if (request.persist === true) {
    if (deps.chats === undefined) {
      sendJson(res, 503, { error: 'chat store unavailable' })
      return
    }
    const userId = requireUser(req, res)
    if (userId === null) return
    const resolved = await resolveStreamMessages(deps.chats, userId, request)
    if (!resolved.ok) {
      sendJson(res, resolved.status, { error: resolved.error })
      return
    }
    request = { ...request, messages: resolved.messages }
  }

  const controller = new AbortController()
  // `close` fires for a client that went away AND for a normal end; only the
  // former needs the abort, and aborting after we finished is harmless
  // because the run has already returned.
  res.on('close', () => controller.abort())

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    // Belt and braces against any compressor that might ever sit in front:
    // `identity` is what stops `@fastify/compress`, `x-no-compression` is the
    // hub's own opt-out marker, `no-transform` is the standards-track one.
    'content-encoding': 'identity',
    'x-no-compression': '1',
    connection: 'keep-alive',
  })
  res.flushHeaders()

  let assistantText = ''
  let mediaSent: TestChatAttachment | null = null
  let sawDone = false
  let pendingDone: Extract<TestChatEvent, { kind: 'done' }> | null = null

  const emit = (event: TestChatEvent): void => {
    if (res.writableEnded) return
    if (event.kind === 'token') assistantText += event.text
    if (event.kind === 'meta') mediaSent = event.mediaSent
    if (event.kind === 'done') {
      sawDone = true
      pendingDone = event
      return
    }
    res.write(encodeEvent(event))
  }

  try {
    await runTestChatStream(deps.stream, request, emit, controller.signal)
    let conversationId: string | undefined
    if (sawDone && request.persist === true && deps.chats !== undefined) {
      const userId = readUserIdFromRequest(req)
      if (userId !== null) {
        try {
          const committed = await commitPersistentTurn(deps.chats, userId, request, {
            assistantContent: assistantText,
            mediaSent,
            thumbnailBase64: thumbnailFrom(mediaSent),
          })
          conversationId = committed?.id
          const retention = deps.retention?.()
          if (retention !== undefined) {
            await deps.chats.prune(userId, retention).catch(() => undefined)
          }
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          deps.logger.warn('ai test chat: persist failed — turn was not saved', {
            meta: { error: message },
          })
        }
      }
    }
    if (pendingDone !== null) {
      emitDone(res, pendingDone, conversationId)
    }
  } catch (cause) {
    // A throw here is a bug in the run, not a provider failure — but the
    // client must still get a line it can render rather than a truncated
    // stream that looks like a network fault.
    const message = cause instanceof Error ? cause.message : String(cause)
    deps.logger.error('ai test chat: run threw — stream closed with an error event', {
      meta: { error: message },
    })
    if (!res.writableEnded)
      res.write(encodeEvent({ kind: 'error', code: 'adapter-error', message }))
  } finally {
    if (!res.writableEnded) res.end()
  }
}

function thumbnailFrom(sent: TestChatAttachment | null): string | undefined {
  return sent === null ? undefined : sent.thumbnailBase64
}

function emitDone(
  res: ServerResponse,
  done: Extract<TestChatEvent, { kind: 'done' }>,
  conversationId: string | undefined,
): void {
  if (res.writableEnded) return
  res.write(encodeEvent(conversationId !== undefined ? { ...done, conversationId } : done))
}

export function createTestChatPlaneHandler(deps: TestChatPlaneDeps): DataPlaneHandler {
  return async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase()
    const parts = pathParts(req.url)

    if (method === 'GET' && parts[0] === 'chats' && parts.length === 1) {
      await handleList(deps, req, res)
      return
    }
    if (method === 'GET' && parts[0] === 'chats' && parts.length === 2 && parts[1] !== undefined) {
      await handleGet(deps, req, res, parts[1])
      return
    }
    if (method !== 'POST' || parts.length > 0) {
      sendJson(res, 405, { error: 'POST only' })
      return
    }

    await handleStream(deps, req, res)
  }
}
