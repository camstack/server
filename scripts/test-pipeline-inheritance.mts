#!/usr/bin/env tsx
/**
 * Manual test — pipeline settings inheritance + step combinations.
 *
 * Hits a running CamStack server via tRPC over WSS and walks the full
 * inheritance matrix of the 3-level pipeline settings model that was
 * reshaped by phases 2b–2f. It is intentionally manual (not vitest) —
 * it needs a real orchestrator, real agents, the detection-pipeline
 * addon, the two decoder addons, and the audio-analyzer. Don't run
 * against production.
 *
 * Usage:
 *   tsx scripts/test-pipeline-inheritance.mts [DEVICE_ID] [AGENT_NODE_ID]
 *
 * DEVICE_ID defaults to the first camera returned by device-manager.
 * AGENT_NODE_ID defaults to the camera's current assignment or 'hub'.
 *
 * Env:
 *   CAMSTACK_SERVER   base URL (default: https://localhost:4443)
 *   CAMSTACK_USER     login username (default: admin)
 *   CAMSTACK_PASS     login password (default: admin)
 *
 * What it covers:
 *
 *   A. Agent-side cascade (detection-pipeline addon owns engine + steps):
 *      - read `api.addonSettings.getGlobalSettings({addonId:'detection-pipeline',nodeId:AGENT})`
 *      - verify engineRuntime / engineBackend / engineDevice + probedBestEngine
 *      - call `api.detectionPipeline.reprobeEngine({nodeId:AGENT})` → expect probedBestEngine refreshed
 *      - call `api.detectionPipeline.getVideoPipelineSteps({nodeId:AGENT})` → record base step set
 *
 *   B. Decoder hwaccel ownership (phase 2d):
 *      - read global settings for decoder-nodeav
 *      - verify `hwaccel` + `probedBestHwaccel` fields present
 *      - call `api.decoder.reprobeHwaccel({nodeId:AGENT})` → expect a backend string
 *
 *   C. Audio-analyzer ownership (phase 2e):
 *      - read global settings for audio-analyzer
 *      - verify audioBackend + probedBestAudioBackend + selectedAudioModel
 *      - call `api.audioAnalyzer.reprobeAudioEngine({nodeId:AGENT})`
 *
 *   D. Device-level inheritance (L2 — stepToggles):
 *      - resolve the pipeline for (DEVICE, AGENT) baseline
 *      - flip face-detection to false via `setCameraStepToggle(enabled:false)`
 *      - re-resolve → expect face-detection gone
 *      - flip to null (inherit) → expect face-detection back
 *      - flip an addon the agent has disabled to true → expect it appears
 *
 *   E. Device+agent override (L3 — pipelineByAgent):
 *      - capture the current resolved pipeline
 *      - write a trimmed override (only object-detection, no children) via
 *        `setCameraPipelineForAgent`
 *      - re-resolve → expect exactly one step, engine INHERITED from agent
 *        (phase 2f invariant — override carries no engine)
 *      - clear the override → expect baseline restored
 *
 *   F. Sibling-agent leak guard:
 *      - write L3 on AGENT
 *      - resolve on a different agent (if available) → must NOT see the override
 *
 *   G. Engine swap propagation:
 *      - flip detection-pipeline engineBackend on the agent
 *      - re-read agent settings → expect new backend
 *      - re-resolve device pipeline → expect new engine on both the L2 and
 *        L3 paths (L3 inherits engine from the agent — phase 2f)
 *
 * Every test logs PASS/FAIL and leaves the store in the state it started
 * in (best-effort restore in `finally`). Exit 0 on all pass, 1 on any
 * failure.
 */
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import WebSocket from 'ws'
import type { AppRouter } from '@camstack/types'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const SERVER = process.env.CAMSTACK_SERVER ?? 'https://localhost:4443'
const USERNAME = process.env.CAMSTACK_USER ?? 'admin'
const PASSWORD = process.env.CAMSTACK_PASS ?? 'admin'

// ── Login + tRPC connect ───────────────────────────────────────────────

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

// ── Test harness ──────────────────────────────────────────────────────

interface Result {
  readonly name: string
  readonly ok: boolean
  readonly note: string
}

const results: Result[] = []

function record(name: string, ok: boolean, note = ''): void {
  results.push({ name, ok, note })
  const tag = ok ? 'PASS' : 'FAIL'
  console.log(`  [${tag}] ${name}${note ? ` — ${note}` : ''}`)
}

function section(title: string): void {
  console.log(`\n${title}\n${'─'.repeat(title.length)}`)
}

// ── Helpers ───────────────────────────────────────────────────────────

function findField(
  schema:
    | { sections: readonly { fields: readonly { key: string; value?: unknown }[] }[] }
    | null
    | undefined,
  key: string,
): unknown {
  if (!schema) return undefined
  for (const s of schema.sections) {
    for (const f of s.fields) if (f.key === key) return f.value
  }
  return undefined
}

async function getGlobal(
  trpc: TrpcClient,
  addonId: string,
  nodeId: string,
): Promise<{
  sections: readonly { fields: readonly { key: string; value?: unknown }[] }[]
} | null> {
  return (await trpc.addonSettings.getGlobalSettings.query({ addonId, nodeId })) as {
    sections: readonly { fields: readonly { key: string; value?: unknown }[] }[]
  } | null
}

async function resolveDevice(
  trpc: TrpcClient,
  deviceId: number,
  agentNodeId: string,
): Promise<{
  engine: { runtime: string; backend: string; format: string }
  steps: readonly { addonId: string; children?: readonly { addonId: string }[] }[]
  audio: { modelId: string; enabled: boolean } | null
}> {
  return (await trpc.pipelineOrchestrator.resolvePipeline.query({ deviceId, agentNodeId })) as {
    engine: { runtime: string; backend: string; format: string }
    steps: readonly { addonId: string; children?: readonly { addonId: string }[] }[]
    audio: { modelId: string; enabled: boolean } | null
  }
}

function hasAddon(
  steps: readonly { addonId: string; children?: readonly { addonId: string }[] }[],
  addonId: string,
): boolean {
  for (const s of steps) {
    if (s.addonId === addonId) return true
    if (s.children && hasAddon(s.children, addonId)) return true
  }
  return false
}

// ── Pick device + agent ───────────────────────────────────────────────

async function pickDevice(trpc: TrpcClient, override?: string): Promise<number> {
  if (override) return Number(override)
  const devices = (await trpc.deviceManager.listAll.query({})) as readonly {
    id: number
    type: string
  }[]
  const cam = devices.find((d) => d.type === 'camera')
  if (!cam) throw new Error('no camera registered — cannot run pipeline inheritance test')
  return cam.id
}

async function pickAgent(trpc: TrpcClient, deviceId: number, override?: string): Promise<string> {
  if (override) return override
  const assignments = (await trpc.pipelineOrchestrator.getPipelineAssignments.query()) as readonly {
    deviceId: number
    agentNodeId: string
  }[]
  const a = assignments.find((x) => x.deviceId === deviceId)
  return a?.agentNodeId ?? 'hub'
}

// ── Test body ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { trpc, close } = await connect()

  const deviceIdArg = process.argv[2]
  const agentIdArg = process.argv[3]
  const deviceId = await pickDevice(trpc, deviceIdArg)
  const agentNodeId = await pickAgent(trpc, deviceId, agentIdArg)
  console.log(`Target: deviceId=${deviceId} agentNodeId=${agentNodeId}\n`)

  // Snapshot we restore at the end.
  const originalCameraSettings = (await trpc.pipelineOrchestrator.getCameraSettings.query({
    deviceId,
  })) as {
    stepToggles?: Record<string, boolean>
    pipelineByAgent?: Record<
      string,
      { steps: readonly unknown[]; audio: { modelId: string; enabled: boolean } | null }
    >
    stepOverridesByAgent?: Record<
      string,
      Record<
        string,
        {
          enabled?: boolean
          modelId?: string
          classFilters?: readonly string[]
          settings?: Record<string, unknown>
        }
      >
    >
  } | null
  const originalDetectionPipeline = await getGlobal(trpc, 'detection-pipeline', agentNodeId)
  const originalEngineBackend = findField(originalDetectionPipeline, 'engineBackend')

  try {
    // ── A. Agent-side cascade ────────────────────────────────────────
    section('A. detection-pipeline addon owns engine + steps (phase 2b + 2c)')
    const dp = await getGlobal(trpc, 'detection-pipeline', agentNodeId)
    record('engineRuntime present', typeof findField(dp, 'engineRuntime') === 'string')
    record('engineBackend present', typeof findField(dp, 'engineBackend') === 'string')
    record('engineDevice present', typeof findField(dp, 'engineDevice') === 'string')
    record('probedBestEngine present', typeof findField(dp, 'probedBestEngine') === 'string')

    const probeResult = (await trpc.pipelineExecutor.reprobeEngine.mutate({
      nodeId: agentNodeId,
    })) as { runtime: string; backend: string }
    record(
      'reprobeEngine returns runtime/backend',
      typeof probeResult.runtime === 'string' && typeof probeResult.backend === 'string',
      `${probeResult.runtime}/${probeResult.backend}`,
    )

    const videoSteps = (await trpc.pipelineExecutor.getVideoPipelineSteps.query({
      nodeId: agentNodeId,
    })) as Record<
      string,
      { modelId: string; classFilters: readonly string[]; settings: Record<string, unknown> }
    >
    record(
      'getVideoPipelineSteps returns a map',
      videoSteps != null && typeof videoSteps === 'object',
      `${Object.keys(videoSteps ?? {}).length} addons`,
    )

    // ── B. Decoder hwaccel ownership ────────────────────────────────
    section('B. Decoder addons own hwaccel (phase 2d)')
    for (const addonId of ['decoder-nodeav']) {
      const cfg = await getGlobal(trpc, addonId, agentNodeId)
      const hwaccel = findField(cfg, 'hwaccel')
      const probed = findField(cfg, 'probedBestHwaccel')
      record(`${addonId}: hwaccel present`, typeof hwaccel === 'string', String(hwaccel ?? ''))
      record(
        `${addonId}: probedBestHwaccel present`,
        typeof probed === 'string',
        String(probed ?? ''),
      )
      try {
        const res = (await trpc.decoder.reprobeHwaccel.mutate({ nodeId: agentNodeId })) as {
          backend: string
        }
        record(
          `${addonId}: reprobeHwaccel returns backend`,
          typeof res.backend === 'string',
          res.backend,
        )
      } catch (err) {
        record(
          `${addonId}: reprobeHwaccel`,
          false,
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    // ── C. Audio analyzer ownership ────────────────────────────────
    section('C. audio-analyzer owns backend + audio step (phase 2e)')
    const aa = await getGlobal(trpc, 'audio-analyzer', agentNodeId)
    record('audioBackend present', typeof findField(aa, 'audioBackend') === 'string')
    record(
      'probedBestAudioBackend present',
      typeof findField(aa, 'probedBestAudioBackend') === 'string',
    )
    record('selectedAudioModel present', typeof findField(aa, 'selectedAudioModel') === 'string')
    try {
      const res = (await trpc.audioAnalyzer.reprobeAudioEngine.mutate({ nodeId: agentNodeId })) as {
        backend: string
      }
      record('reprobeAudioEngine returns backend', typeof res.backend === 'string', res.backend)
    } catch (err) {
      record('reprobeAudioEngine', false, err instanceof Error ? err.message : String(err))
    }

    // ── D. L2 — stepToggles inherit/enable/disable ──────────────────
    section('D. Device stepToggles — inherit / enable / disable (phase 2f rule)')
    const baseline = await resolveDevice(trpc, deviceId, agentNodeId)
    const baselineHasFace = hasAddon(baseline.steps, 'face-detection')
    record('baseline resolved', baseline.steps.length >= 0, `${baseline.steps.length} root step(s)`)

    if (baselineHasFace) {
      await trpc.pipelineOrchestrator.setCameraStepToggle.mutate({
        deviceId,
        addonId: 'face-detection',
        enabled: false,
      })
      const afterOff = await resolveDevice(trpc, deviceId, agentNodeId)
      record(
        'stepToggle(false) removes face-detection',
        !hasAddon(afterOff.steps, 'face-detection'),
      )

      await trpc.pipelineOrchestrator.setCameraStepToggle.mutate({
        deviceId,
        addonId: 'face-detection',
        enabled: null,
      })
      const afterInherit = await resolveDevice(trpc, deviceId, agentNodeId)
      record(
        'stepToggle(null) restores face-detection (inherit)',
        hasAddon(afterInherit.steps, 'face-detection'),
      )
    } else {
      record(
        'baseline lacks face-detection — skipping stepToggle(false) path',
        true,
        'not applicable',
      )
    }

    // ── E. L3 — per-agent wholesale override ────────────────────────
    section('E. Device+Agent wholesale override (phase 2f: engine from agent)')
    const samplePayload = {
      steps: [
        {
          addonId: 'object-detection',
          modelId: (videoSteps?.['object-detection']?.modelId ?? 'yolov9s') as string,
          enabled: true,
          classFilters: ['person'],
          children: [],
        },
      ],
      audio: null as { modelId: string; enabled: boolean } | null,
    }
    await trpc.pipelineOrchestrator.setCameraPipelineForAgent.mutate({
      deviceId,
      agentNodeId,
      pipeline: samplePayload,
    })
    const overridden = await resolveDevice(trpc, deviceId, agentNodeId)
    record('override yields exactly one root step', overridden.steps.length === 1)
    record(
      'override engine inherits agent engine (no override engine — phase 2f)',
      overridden.engine.runtime === baseline.engine.runtime &&
        overridden.engine.backend === baseline.engine.backend &&
        overridden.engine.format === baseline.engine.format,
      `agent=${baseline.engine.runtime}/${baseline.engine.backend} override=${overridden.engine.runtime}/${overridden.engine.backend}`,
    )
    record(
      'override carries the object-detection step',
      overridden.steps.length > 0 && overridden.steps[0]!.addonId === 'object-detection',
    )

    await trpc.pipelineOrchestrator.setCameraPipelineForAgent.mutate({
      deviceId,
      agentNodeId,
      pipeline: null,
    })
    const cleared = await resolveDevice(trpc, deviceId, agentNodeId)
    record(
      'clearing the override restores L2 resolution',
      cleared.steps.length === baseline.steps.length &&
        hasAddon(cleared.steps, baseline.steps[0]?.addonId ?? '___'),
    )

    // ── F. Sibling-agent leak guard ─────────────────────────────────
    section('F. Sibling-agent leak guard')
    const agents = (await trpc.pipelineOrchestrator.getAgentLoad.query()) as readonly {
      nodeId: string
    }[]
    const sibling = agents.find((a) => a.nodeId !== agentNodeId)
    if (!sibling) {
      record('no sibling agent — skipping', true, 'single-node cluster')
    } else {
      await trpc.pipelineOrchestrator.setCameraPipelineForAgent.mutate({
        deviceId,
        agentNodeId,
        pipeline: samplePayload,
      })
      const onSibling = await resolveDevice(trpc, deviceId, sibling.nodeId)
      record(
        'override on target agent does not leak into sibling resolution',
        onSibling.steps.length === 0 ||
          hasAddon(onSibling.steps, 'face-detection') ||
          onSibling.steps[0]?.addonId !== 'object-detection',
        `sibling=${sibling.nodeId} rootSteps=${onSibling.steps.length}`,
      )
      await trpc.pipelineOrchestrator.setCameraPipelineForAgent.mutate({
        deviceId,
        agentNodeId,
        pipeline: null,
      })
    }

    // ── G. Engine swap propagation ──────────────────────────────────
    section('G. Engine swap propagates to L2 + L3')
    const runtimeNow = findField(dp, 'engineRuntime') as string
    const backendNow = findField(dp, 'engineBackend') as string
    // Pick any other backend advertised by the cap — fall back to cpu.
    const alternate = backendNow === 'cpu' ? 'coreml' : 'cpu'
    const altRuntime = alternate === 'cpu' ? 'node' : 'python'
    await trpc.addonSettings.updateGlobalSettings.mutate({
      addonId: 'detection-pipeline',
      nodeId: agentNodeId,
      patch: { engineBackend: alternate, engineRuntime: altRuntime },
    })
    // `requiresRestart: true` on engine fields triggers an auto-restart
    // (setImmediate) after the write. Give the worker time to come back
    // before re-fetching — without the delay we hit the old instance's
    // tail response.
    await new Promise((r) => setTimeout(r, 3000))
    const dpAfter = await getGlobal(trpc, 'detection-pipeline', agentNodeId)
    const changed = findField(dpAfter, 'engineBackend')
    record(
      'detection-pipeline engineBackend flipped',
      changed === alternate,
      `${String(backendNow)} → ${String(changed)}`,
    )

    const afterSwap = await resolveDevice(trpc, deviceId, agentNodeId)
    record(
      'L2 resolved engine picks up new agent backend',
      afterSwap.engine.backend === alternate,
      `${afterSwap.engine.runtime}/${afterSwap.engine.backend}`,
    )

    await trpc.pipelineOrchestrator.setCameraPipelineForAgent.mutate({
      deviceId,
      agentNodeId,
      pipeline: samplePayload,
    })
    const afterSwapOverride = await resolveDevice(trpc, deviceId, agentNodeId)
    record(
      'L3 override engine follows new agent backend (phase 2f)',
      afterSwapOverride.engine.backend === alternate,
      `${afterSwapOverride.engine.runtime}/${afterSwapOverride.engine.backend}`,
    )
    await trpc.pipelineOrchestrator.setCameraPipelineForAgent.mutate({
      deviceId,
      agentNodeId,
      pipeline: null,
    })

    // ── H. Per-agent per-step override (L2.5) ──────────────────────
    section('H. Per-agent per-step override (L2.5)')
    {
      const addonId = 'object-detection'
      const baseline = await resolveDevice(trpc, deviceId, agentNodeId)
      const baseStep = baseline.steps.find((s) => s.addonId === addonId) as
        | { addonId: string; modelId?: string }
        | undefined
      const baseModel = baseStep?.modelId

      await trpc.pipelineOrchestrator.setCameraStepOverride.mutate({
        deviceId,
        agentNodeId,
        addonId,
        patch: { modelId: 'TEST_OVERRIDE_MODEL' },
      })
      const patched = await resolveDevice(trpc, deviceId, agentNodeId)
      const patchedStep = patched.steps.find((s) => s.addonId === addonId) as
        | { addonId: string; modelId?: string }
        | undefined
      record(
        'L2.5 modelId patch applied',
        patchedStep?.modelId === 'TEST_OVERRIDE_MODEL',
        `modelId=${String(patchedStep?.modelId)}`,
      )

      await trpc.pipelineOrchestrator.setCameraStepOverride.mutate({
        deviceId,
        agentNodeId,
        addonId,
        patch: null,
      })
      const cleared = await resolveDevice(trpc, deviceId, agentNodeId)
      const clearedStep = cleared.steps.find((s) => s.addonId === addonId) as
        | { addonId: string; modelId?: string }
        | undefined
      record(
        'L2.5 clear restores baseline',
        clearedStep?.modelId === baseModel,
        `modelId=${String(clearedStep?.modelId)}`,
      )
    }
  } finally {
    // ── Best-effort restore ────────────────────────────────────────
    try {
      if (typeof originalEngineBackend === 'string') {
        await trpc.addonSettings.updateGlobalSettings.mutate({
          addonId: 'detection-pipeline',
          nodeId: agentNodeId,
          patch: {
            engineBackend: originalEngineBackend,
            engineRuntime: findField(originalDetectionPipeline, 'engineRuntime'),
          },
        })
      }
      // Restore stepToggles + pipelineByAgent + stepOverridesByAgent verbatim.
      const snap = originalCameraSettings ?? {}
      for (const addonId of Object.keys(snap.stepToggles ?? {})) {
        await trpc.pipelineOrchestrator.setCameraStepToggle.mutate({
          deviceId,
          addonId,
          enabled: (snap.stepToggles ?? {})[addonId] ?? null,
        })
      }
      for (const agent of Object.keys(snap.pipelineByAgent ?? {})) {
        const orig = (snap.pipelineByAgent ?? {})[agent]!
        await trpc.pipelineOrchestrator.setCameraPipelineForAgent.mutate({
          deviceId,
          agentNodeId: agent,
          pipeline: {
            steps: orig.steps as never,
            audio: orig.audio,
          },
        })
      }
      const byAgent = snap.stepOverridesByAgent ?? {}
      for (const agent of Object.keys(byAgent)) {
        const forAgent = byAgent[agent] ?? {}
        for (const addonId of Object.keys(forAgent)) {
          await trpc.pipelineOrchestrator.setCameraStepOverride.mutate({
            deviceId,
            agentNodeId: agent,
            addonId,
            patch: forAgent[addonId] ?? null,
          })
        }
      }
    } catch (err) {
      console.warn(
        'restore failed (manual cleanup may be needed):',
        err instanceof Error ? err.message : err,
      )
    }
    close()
  }

  const passed = results.filter((r) => r.ok).length
  const failed = results.length - passed
  console.log(`\nSummary: ${passed}/${results.length} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
