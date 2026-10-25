import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import type { HwAccelBackend } from '../interfaces/addon.js'

/**
 * Operator-facing hwaccel selection — wins over `probedBestHwaccel`
 * when concrete; `'auto'` defers to the session's local resolver
 * (`ctx.kernel.hwaccel`) which probes the host. Shared across every
 * decoder addon (node-av, ffmpeg, …) so UI + settings + sessions all
 * speak the same vocabulary.
 */
export type HwAccelChoice = 'auto' | 'none' | HwAccelBackend

/**
 * Stable UI option list for the `hwaccel` setting. Decoder addons
 * reuse this for `globalSettingsSchema()` so the dropdown is
 * identical everywhere. Order: auto → off → common backends by
 * platform affinity (macOS, NVIDIA, Intel/AMD, Windows, Linux).
 */
export const HWACCEL_OPTIONS: ReadonlyArray<{ value: HwAccelChoice; label: string }> = [
  { value: 'auto', label: 'Auto (defer to probed best)' },
  { value: 'none', label: 'Off (software)' },
  { value: 'videotoolbox', label: 'VideoToolbox (macOS)' },
  { value: 'cuda', label: 'CUDA (NVIDIA)' },
  { value: 'nvdec', label: 'NVDEC (NVIDIA legacy)' },
  { value: 'vaapi', label: 'VAAPI (Linux Intel/AMD)' },
  { value: 'qsv', label: 'QuickSync (Intel)' },
  { value: 'd3d11va', label: 'D3D11VA (Windows)' },
  { value: 'dxva2', label: 'DXVA2 (Windows legacy)' },
  { value: 'amf', label: 'AMF (AMD)' },
  { value: 'vdpau', label: 'VDPAU (Linux NVIDIA legacy)' },
  { value: 'drm', label: 'DRM (Linux generic)' },
]

/**
 * Shared shape of a decoder addon's global settings. Every decoder
 * owns its own instance (node-av, ffmpeg, future backends) — they
 * don't share a store, but they share this config shape.
 */
export interface DecoderHwAccelConfig {
  readonly hwaccel: HwAccelChoice
  readonly probedBestHwaccel: string
}

export const DEFAULT_DECODER_HWACCEL_CONFIG: DecoderHwAccelConfig = {
  hwaccel: 'auto',
  probedBestHwaccel: '',
}

export const decoderCapability = {
  name: 'decoder',
  scope: 'system',
  // Singleton — one decoder per node, and `decoder-nodeav` is the only
  // provider (the ffmpeg-subprocess fallback addon was deleted with D763).
  mode: 'singleton',
  preferredProvider: 'decoder-nodeav',
  methods: {
    // The session surface (`createSession`, `pushPacket`, `openStream`,
    // `pullFrames`, `pullHandles`, `getFrame`, `getShmStats`, `updateConfig`,
    // `getStats`, `listActiveSessions`, `supportsCodec`, `destroySession`) is
    // removed (D763): its only caller was the stream broker's frame-handle plane
    // (D762), and decoding runs in the pipeline runner's session-decode workers,
    // which use node-av directly. What is left answers per-node hwaccel.
    getInfo: method(
      z.void(),
      z.object({
        id: z.string(),
        name: z.string(),
        // Active decode hwaccel state of THIS provider on THIS node. Lets the
        // orchestrator surface per-node decode hwaccel (UI) by asking the
        // active `decoder` cap via nodePin — no addon-id lookup.
        hwaccel: z.string().optional(),
        probedBestHwaccel: z.string().optional(),
      }),
    ),

    /**
     * Re-run the host platform-probe for the decoder's hwaccel backend
     * and write the detected value into the addon's own global
     * settings (`probedBestHwaccel`). Replaces the legacy per-agent
     * `pipeline-orchestrator.reprobeAgentHwAccel` — each decoder addon
     * now owns its own probe.
     *
     * Returns the backend the probe picked (`'none'` = software-only
     * host, otherwise one of `HwAccelBackend`). The operator's
     * `hwaccel` setting (auto / none / backend) is not touched; only
     * the `probedBestHwaccel` hint.
     */
    reprobeHwaccel: method(z.void(), z.object({ backend: z.string() }), {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
} as const satisfies CapabilityDefinition

export type IDecoderCapProvider = InferProvider<typeof decoderCapability>
