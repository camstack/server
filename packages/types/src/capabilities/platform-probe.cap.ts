import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { MODEL_FORMATS } from '../types/models.js'
import { AcceleratorComputeSchema } from '../pipeline/auto-tune/accelerator-compute.js'

const ModelFormatSchema = z.enum(MODEL_FORMATS)

const HwAccelBackendInputSchema = z
  .enum([
    'videotoolbox',
    'cuda',
    'nvdec',
    'vaapi',
    'qsv',
    'd3d11va',
    'dxva2',
    'amf',
    'vdpau',
    'drm',
    'coreml',
    'tensorrt',
    'openvino',
    'directml',
    'webgpu',
    'none',
  ])
  .nullable()
  .optional()

const HwAccelResolutionSchema = z.object({
  preferred: z.array(z.string()).readonly(),
  // Human-readable explanation of WHY these backends were picked (platform +
  // detected GPU signals, or an explicit override). The kernel resolver always
  // computes it; surfacing it here lets the admin hwaccel router expose the
  // same observability without a second resolution surface.
  rationale: z.string(),
})

const HardwareEncoderIdSchema = z.enum([
  'h264_videotoolbox',
  'hevc_videotoolbox',
  'h264_vaapi',
  'hevc_vaapi',
  'h264_nvenc',
  'hevc_nvenc',
  'h264_qsv',
  'hevc_qsv',
  'h264_amf',
  'hevc_amf',
  'libx264',
  'libx265',
])
export type HardwareEncoderId = z.infer<typeof HardwareEncoderIdSchema>

const HardwareEncoderProbeSchema = z.object({
  encoder: HardwareEncoderIdSchema,
  codec: z.enum(['H264', 'H265']),
  family: z.enum(['videotoolbox', 'vaapi', 'nvenc', 'qsv', 'amf', 'software']),
  available: z.boolean(),
  reason: z.string().optional(),
})
export type HardwareEncoderProbe = z.infer<typeof HardwareEncoderProbeSchema>

const HardwareEncodersSchema = z.object({
  encoders: z.array(HardwareEncoderProbeSchema).readonly(),
  defaultH264: HardwareEncoderIdSchema,
  defaultH265: HardwareEncoderIdSchema,
  probedAt: z.number(),
})
export type HardwareEncoders = z.infer<typeof HardwareEncodersSchema>

/**
 * Decode-side companion to {@link HardwareEncodersSchema}: the `-hwaccel`
 * methods the configured ffmpeg binary actually supports (parsed from
 * `ffmpeg -hwaccels`). Used to gate decode-hwaccel attempts so the transcode
 * egress never spends a spawn on a backend this build cannot offer. Per-stream
 * decode fragility (e.g. VideoToolbox HEVC) is still handled by the egress's
 * software fallback — this only filters out wholly-unsupported backends.
 */
const HardwareDecodeAccelsSchema = z.object({
  methods: z.array(z.string()).readonly(),
  probedAt: z.number(),
})
export type HardwareDecodeAccels = z.infer<typeof HardwareDecodeAccelsSchema>

const HardwarePlatformSchema = z.enum(['darwin', 'linux', 'win32'])
const HardwareArchSchema = z.enum(['arm64', 'x64'])

const GpuInfoSchema = z.object({
  type: z.enum(['nvidia', 'amd', 'intel', 'apple']),
  name: z.string(),
  memoryMB: z.number().optional(),
})

const NpuInfoSchema = z.object({
  type: z.enum(['apple-ane', 'intel-npu', 'amd-xdna']),
  name: z.string().optional(),
  generation: z.enum(['xdna1', 'xdna2']).optional(),
})

const CoralBusSchema = z.enum(['usb', 'pci'])

const CoralInfoSchema = z.object({
  type: z.literal('coral-edgetpu'),
  /** Legacy single-bus report (older nodes) — read via `coralUsableUnits`. */
  bus: z.string().optional(),
  /** Legacy USB unit count (older nodes) — read via `coralUsableUnits`. */
  count: z.number().int().nonnegative().optional(),
  /** Usable units per bus — each one is its own `edgetpu:<bus>[:N]` device. */
  units: z
    .array(z.object({ bus: CoralBusSchema, count: z.number().int().nonnegative() }))
    .readonly()
    .optional(),
  /** Present-but-unusable units, each with its typed reason (never "absent"). */
  unavailable: z
    .array(
      z.object({
        bus: CoralBusSchema,
        count: z.number().int().nonnegative(),
        reason: z.enum(['driver-missing', 'device-not-accessible']),
      }),
    )
    .readonly()
    .optional(),
})

const HardwareInfoSchema = z.object({
  platform: HardwarePlatformSchema,
  arch: HardwareArchSchema,
  cpuModel: z.string(),
  cpuCores: z.number(),
  totalRAM_MB: z.number(),
  availableRAM_MB: z.number(),
  gpu: GpuInfoSchema.nullable(),
  npu: NpuInfoSchema.nullable(),
  // Optional/nullable so a cross-node probe report from an older node (which
  // omits it) still validates on the receiving hub. Present ⇒ Coral hardware
  // found (USB and/or PCIe); the `edgetpu` runtime is offered only for USABLE
  // units (`units`), never for the `unavailable` ones.
  coral: CoralInfoSchema.nullable().optional(),
  /**
   * Per-accelerator compute (D930). Omitted by a node that has not probed it.
   * `null` fields inside an entry are a failed query, never a zero.
   */
  accelerators: z.array(AcceleratorComputeSchema).readonly().optional(),
})

const PlatformScoreSchema = z.object({
  runtime: z.literal('python'),
  backend: z.string(),
  format: z.enum(['onnx', 'coreml', 'openvino', 'tflite']),
  score: z.number(),
  reason: z.string(),
  available: z.boolean(),
})

// One usable inference device on a node (enumerate, don't elect). Coexists with
// the elected `bestScore` — the orchestrator balances across the full set.
const InferenceDeviceDescriptorSchema = z.object({
  key: z.string(),
  backend: z.string(),
  device: z.string(),
  format: ModelFormatSchema,
  runtime: z.literal('python'),
  score: z.number(),
  available: z.boolean(),
})

const PlatformCapabilitiesSchema = z.object({
  hardware: HardwareInfoSchema,
  scores: z.array(PlatformScoreSchema).readonly(),
  bestScore: PlatformScoreSchema,
  pythonPath: z.string().nullable(),
  devices: z.array(InferenceDeviceDescriptorSchema).readonly(),
})

const ModelRequirementSchema = z.object({
  modelId: z.string(),
  name: z.string(),
  minRAM_MB: z.number(),
  accuracyScore: z.number(),
  formats: z.array(z.string()).readonly(),
})

const ResolvedInferenceConfigSchema = z.object({
  modelId: z.string(),
  runtime: z.literal('python'),
  backend: z.string(),
  format: ModelFormatSchema,
  reason: z.string(),
})

/**
 * The answer of an accelerator rescan (D919): the node's device list after
 * the re-probe, what changed, and the evidence that decided the Coral answer
 * (`usbBus` — could the USB bus be read at all; `decidedBy` — USB ids, the PCI
 * bus, the installed-delegate fallback, or nothing).
 */
const AcceleratorRescanSchema = z.object({
  devices: z.array(InferenceDeviceDescriptorSchema).readonly(),
  appeared: z.array(z.string()).readonly(),
  disappeared: z.array(z.string()).readonly(),
  usbBus: z.enum(['observed', 'unobservable']),
  decidedBy: z.enum(['usb-ids', 'pci', 'delegate-fallback', 'none']),
})
export type AcceleratorRescan = z.infer<typeof AcceleratorRescanSchema>

export const platformProbeCapability = {
  name: 'platform-probe',
  scope: 'system',
  mode: 'singleton',
  methods: {
    getCapabilities: method(z.void(), PlatformCapabilitiesSchema),
    getHardware: method(z.void(), HardwareInfoSchema),
    resolveInferenceConfig: method(
      z.object({ requirements: z.array(ModelRequirementSchema).readonly() }),
      ResolvedInferenceConfigSchema,
    ),
    // Per-node targeting is transport-level `nodePin(nodeId)`, NEVER a data
    // field: this is a singleton provider that runs ON the pinned node and
    // resolves the LOCAL `ctx.kernel.hwaccel`. A data nodeId could not be
    // honored inside the singleton without re-issuing a cross-node round-trip
    // (the retired `$hwaccel` Moleculer path), so it is intentionally absent.
    resolveHwAccel: method(
      z.object({ prefer: HwAccelBackendInputSchema }),
      HwAccelResolutionSchema,
    ),
    /**
     * Re-probe this node's accelerators NOW (Coral USB ids + PCIe apex units;
     * `/sys` and `/dev` reads, no model load) and rebuild the device list that
     * `getCapabilities` serves. The same re-probe runs every 60 s on its own;
     * this is the operator's "rescan inference devices". Target a node with the
     * `{ nodeId }` routing input, like `getCapabilities`.
     */
    rescanAccelerators: method(z.void(), AcceleratorRescanSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    // Removed: getHardwareEncoders / refreshHardwareEncoders /
    // getHardwareDecodeAccels / refreshHardwareDecodeAccels. These probed
    // `ffmpeg -encoders` / `-hwaccels` on the singleton's node (→ hub hardware
    // from a forked agent child) and had no remaining consumers: the decoder +
    // stream-broker now derive decode/encode hwaccel node-locally from
    // `ctx.kernel.hwaccel` (+ a static encoder map). `resolveHwAccel` stays as
    // the node-local utility (local `ctx.kernel` when unpinned; the admin router
    // forwards to a specific node via `createCapabilityProxy`).
  },
} as const satisfies CapabilityDefinition

export type IPlatformProbeProvider = InferProvider<typeof platformProbeCapability>
