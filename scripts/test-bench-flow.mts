#!/usr/bin/env tsx
/**
 * Manual test — emulate the benchmark UI operator flow.
 *
 * Covers the gaps the user reported after the settings/bench refactor:
 *   1. `pipeline.progress` events must arrive on the benchmark live
 *      subscription during a `runPipelineTest` run, carrying the
 *      structured `engine: {runtime, backend, device}` payload so the
 *      UI can render which engine is actually executing the steps.
 *   2. (Removed by D646: the benchmark's per-run `engine` override no
 *      longer exists — a run names its pool by `deviceKey`.)
 *   3. `getGlobalSettings` with an `overlay` must drive the cascade
 *      (runtime → backend → device) — the returned schema has to
 *      reflect the overlay, not the persisted store.
 *
 * Usage:
 *   tsx scripts/test-bench-flow.mts [AGENT_NODE_ID]
 *
 *   AGENT_NODE_ID defaults to 'hub'. Accepts any cluster node id.
 *
 * Env:
 *   CAMSTACK_SERVER   base URL (default: https://localhost:4443)
 *   CAMSTACK_USER     username (default: admin)
 *   CAMSTACK_PASS     password (default: admin)
 *
 * Exits 0 on all green, 1 on any failure. Prints per-check PASS/FAIL.
 * Does NOT mutate any persisted settings.
 */
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import WebSocket from 'ws'
import type { AppRouter } from '@camstack/types'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const SERVER = process.env.CAMSTACK_SERVER ?? 'https://localhost:4443'
const USERNAME = process.env.CAMSTACK_USER ?? 'admin'
const PASSWORD = process.env.CAMSTACK_PASS ?? 'admin'
const AGENT = process.argv[2] ?? 'hub'

async function login(): Promise<string> {
  const res = await fetch(`${SERVER}/trpc/auth.login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ json: { username: USERNAME, password: PASSWORD } }),
  })
  const body = (await res.json()) as { result?: { data?: { json?: { token?: string } } } }
  const token = body?.result?.data?.json?.token
  if (!token) throw new Error(`login failed: ${JSON.stringify(body)}`)
  return token
}

type TrpcClient = ReturnType<typeof createTRPCClient<AppRouter>>

async function connect(): Promise<{ trpc: TrpcClient; close: () => void }> {
  const token = await login()
  const ws = createWSClient({
    url: SERVER.replace('https', 'wss') + '/trpc',
    WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
    connectionParams: () => ({ token }),
  })
  const trpc = createTRPCClient<AppRouter>({
    links: [wsLink({ client: ws, transformer: superjson })],
  })
  return { trpc, close: () => ws.close() }
}

// ── Helpers ─────────────────────────────────────────────────────────

interface Field {
  key: string
  value?: unknown
  options?: readonly { value: unknown; label: string }[]
}
interface Section {
  fields: readonly Field[]
}
interface Schema {
  sections: readonly Section[]
}

function field(schema: Schema | null, key: string): Field | undefined {
  if (!schema) return undefined
  for (const s of schema.sections) for (const f of s.fields) if (f.key === key) return f
  return undefined
}

function fieldValue(schema: Schema | null, key: string): unknown {
  return field(schema, key)?.value
}

function fieldOptionValues(schema: Schema | null, key: string): readonly string[] {
  return (field(schema, key)?.options ?? []).map((o) => String(o.value))
}

interface Result {
  name: string
  ok: boolean
  note: string
}
const results: Result[] = []

function record(name: string, ok: boolean, note = ''): void {
  results.push({ name, ok, note })
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${note ? ` — ${note}` : ''}`)
}

function section(title: string): void {
  console.log(`\n${title}\n${'─'.repeat(title.length)}`)
}

// ── Test body ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { trpc, close } = await connect()
  console.log(`Target agent: ${AGENT}\n`)
  try {
    // ── A. Engine cascade under overlay (runtime=node) ──
    section('A. detection-pipeline overlay drives cascade')
    const baseSchema = (await trpc.addonSettings.getGlobalSettings.query({
      addonId: 'detection-pipeline',
      nodeId: AGENT,
    })) as Schema | null
    const storedRuntime = fieldValue(baseSchema, 'engineRuntime')
    const storedBackend = fieldValue(baseSchema, 'engineBackend')
    const storedDevice = fieldValue(baseSchema, 'engineDevice')
    record(
      'baseline fetch has runtime/backend/device',
      typeof storedRuntime === 'string' &&
        typeof storedBackend === 'string' &&
        typeof storedDevice === 'string',
      `${storedRuntime}/${storedBackend}/${storedDevice}`,
    )

    const altRuntime = storedRuntime === 'python' ? 'node' : 'python'
    const overlaySchema = (await trpc.addonSettings.getGlobalSettings.query({
      addonId: 'detection-pipeline',
      nodeId: AGENT,
      overlay: { engineRuntime: altRuntime },
    })) as Schema | null
    const overlaidRuntime = fieldValue(overlaySchema, 'engineRuntime')
    const overlaidBackendOpts = fieldOptionValues(overlaySchema, 'engineBackend')
    const overlaidBackend = fieldValue(overlaySchema, 'engineBackend')
    record(
      'overlay runtime echoes in response',
      overlaidRuntime === altRuntime,
      `${overlaidRuntime}`,
    )
    record(
      'overlay runtime shifts backend options',
      overlaidBackendOpts.length > 0 &&
        JSON.stringify(overlaidBackendOpts) !==
          JSON.stringify(fieldOptionValues(baseSchema, 'engineBackend')),
      `opts=${overlaidBackendOpts.join(',')}`,
    )
    record(
      'overlay runtime resets backend to a valid option',
      typeof overlaidBackend === 'string' && overlaidBackendOpts.includes(String(overlaidBackend)),
      `${overlaidBackend}`,
    )

    // Confirm the store was NOT mutated by the preview.
    const afterOverlayCheck = (await trpc.addonSettings.getGlobalSettings.query({
      addonId: 'detection-pipeline',
      nodeId: AGENT,
    })) as Schema | null
    record(
      'overlay preview does NOT mutate store',
      fieldValue(afterOverlayCheck, 'engineRuntime') === storedRuntime,
      `runtime still ${fieldValue(afterOverlayCheck, 'engineRuntime')}`,
    )

    // ── B. runPipelineTest emits pipeline.progress with engine ──
    section('B. runPipelineTest emits pipeline.progress events (incl. engine)')
    const sessionId = `bench-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const progressEvents: {
      step?: string
      engine?: { runtime: string; backend: string; device?: string }
      message?: string
    }[] = []
    const subHolder: { unsub: (() => void) | null } = { unsub: null }
    const subscribePromise = new Promise<void>((resolve) => {
      const sub = (
        trpc as unknown as {
          live: {
            onEvent: {
              subscribe: (
                filter: { category: string },
                cb: { onData: (e: unknown) => void; onError?: (e: unknown) => void },
              ) => { unsubscribe: () => void }
            }
          }
        }
      ).live.onEvent.subscribe(
        { category: 'pipeline.progress' },
        {
          onData: (raw) => {
            const evt = raw as { data?: Record<string, unknown> }
            const data = evt?.data ?? {}
            if (data['sessionId'] !== sessionId) return
            progressEvents.push({
              step: typeof data['step'] === 'string' ? data['step'] : undefined,
              engine: (data['engine'] as (typeof progressEvents)[number]['engine']) ?? undefined,
              message: typeof data['message'] === 'string' ? data['message'] : undefined,
            })
          },
          onError: (err) => console.warn('[test] subscribe error:', err),
        },
      )
      subHolder.unsub = () => sub.unsubscribe()
      setTimeout(resolve, 500) // give moleculer a beat to wire the sub
    })
    await subscribePromise

    const minimalSteps = [
      {
        addonId: 'object-detection',
        modelId: 'yolov9s',
        enabled: true,
        classFilters: [],
        children: [],
      },
    ]
    // Pick the first reference image the node advertises — filenames
    // differ across installs (people.jpg / street.jpg / camera.jpg …).
    const refs = (await trpc.pipelineExecutor.listReferenceImages.query({
      nodeId: AGENT,
    })) as readonly { filename: string }[]
    const refImage = refs[0]?.filename
    if (!refImage) {
      record('reference image available on node', false, 'list empty')
    } else {
      record('reference image available on node', true, refImage)
    }

    let ran = false
    try {
      await (
        trpc as unknown as {
          addons: { custom: { mutate: (i: unknown) => Promise<unknown> } }
        }
      ).addons.custom.mutate({
        addonId: 'benchmark',
        action: 'runPipelineTest',
        input: {
          nodeId: AGENT,
          sessionId,
          steps: minimalSteps,
          ...(refImage
            ? { referenceImage: refImage }
            : { imageBase64: Buffer.alloc(1).toString('base64') }),
        },
      })
      ran = true
    } catch (err) {
      record('runPipelineTest completes', false, err instanceof Error ? err.message : String(err))
    }
    if (ran) record('runPipelineTest completes', ran)

    // Give events 500ms to settle in case of slow propagation.
    await new Promise((r) => setTimeout(r, 500))
    subHolder.unsub?.()

    record(
      'received at least one pipeline.progress event',
      progressEvents.length > 0,
      `count=${progressEvents.length}`,
    )
    const engineEvt = progressEvents.find((e) => e.step === 'engine')
    record(
      'received engine-step event with structured engine payload',
      engineEvt !== undefined && engineEvt.engine !== undefined,
      engineEvt?.engine
        ? `${engineEvt.engine.runtime}/${engineEvt.engine.backend}${engineEvt.engine.device ? `/${engineEvt.engine.device}` : ''}`
        : 'missing',
    )

    // ── C. Final confirmation: store untouched after bench ──
    section('C. Persisted store untouched after bench run')
    const afterRun = (await trpc.addonSettings.getGlobalSettings.query({
      addonId: 'detection-pipeline',
      nodeId: AGENT,
    })) as Schema | null
    record(
      'runtime unchanged',
      fieldValue(afterRun, 'engineRuntime') === storedRuntime,
      `${fieldValue(afterRun, 'engineRuntime')}`,
    )
    record(
      'backend unchanged',
      fieldValue(afterRun, 'engineBackend') === storedBackend,
      `${fieldValue(afterRun, 'engineBackend')}`,
    )
    record(
      'device unchanged',
      fieldValue(afterRun, 'engineDevice') === storedDevice,
      `${fieldValue(afterRun, 'engineDevice')}`,
    )
  } finally {
    close()
  }

  const passed = results.filter((r) => r.ok).length
  console.log(`\nSummary: ${passed}/${results.length} passed, ${results.length - passed} failed`)
  if (passed !== results.length) process.exit(1)
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
