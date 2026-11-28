/**
 * `support_diagnose_accelerator`: a node should have an accelerator and the
 * hub does not offer it. Reads what the platform probe saw and what the node's
 * inference runtime offers, then says one of
 *
 *  - `ok`            the runtime offers the device, available and enabled;
 *  - `misconfigured` the runtime supports the kind but the node does not offer
 *                    it (passthrough, driver, image tag) or it is not opted in;
 *  - `unsupported`   no inference backend exists for the kind — says which
 *                    addon would have to be extended;
 *  - `unknown`       a read failed: the reason is named, never read as "absent"
 *                    (D315, D393).
 *
 * Read-only. The install rules are the ones `setup_install_guide` serves.
 */
import type { HubClient } from '@dominevo/develop'
import { z } from 'zod'
import type { McpContext } from './context.js'
import {
  cap,
  readQuery,
  withHub,
  type NoSessionResult,
  type Read,
  type RefusedResult,
} from './ops-hub.js'
import {
  IMAGE_TAG_BY_ACCELERATOR,
  isNvidiaAccelerator,
  MUST_NOT_OMIT,
  NO_BARE_LATEST,
  NVIDIA_MUST_NOT_OMIT,
  type Accelerator,
} from './setup-install-rules.js'
import {
  IMAGE_VARIANT_TABLE,
  intelVariantForName,
  NVIDIA_CONTAINER_NEEDS,
  nvidiaVariantForName,
  variantTag,
  type ImageVariant,
} from './image-variants.js'

export const EXPECTED_ACCELERATORS = [
  'intel-igpu',
  'intel-npu',
  'amd-webgpu',
  'amd-vaapi',
  'amd-npu',
  'coral-usb',
  'coral-pcie',
  'apple-ane',
  'nvidia',
] as const
export const ExpectedAcceleratorSchema = z.enum(EXPECTED_ACCELERATORS)
export type ExpectedAccelerator = z.infer<typeof ExpectedAcceleratorSchema>

export type AcceleratorVerdict = 'ok' | 'misconfigured' | 'unsupported' | 'unknown'

const HardwareSchema = z.looseObject({
  platform: z.enum(['darwin', 'linux', 'win32']),
  arch: z.enum(['arm64', 'x64']),
  cpuModel: z.string(),
  gpu: z.looseObject({ type: z.string(), name: z.string() }).nullable(),
  npu: z.looseObject({ type: z.string() }).nullable(),
  /** NVIDIA's own slot (never `gpu`, which is the iGPU); absent on older nodes. */
  nvidia: z
    .looseObject({ name: z.string(), usable: z.boolean(), reason: z.string().optional() })
    .nullable()
    .optional(),
})

const InferenceDevicesSchema = z.looseObject({
  reachable: z.boolean(),
  devices: z.array(
    z.looseObject({
      key: z.string(),
      available: z.boolean(),
      presence: z.enum(['present', 'absent', 'unknown']).optional(),
      enabled: z.boolean(),
      exclusion: z.string().nullable(),
    }),
  ),
})

/** What the inference runtime (the `detection-pipeline` addon, package `@dominevo/addon-pipeline`) can drive. */
interface Expectation {
  /** Inference device keys that mean "this accelerator is offered". */
  readonly deviceKeys: (key: string) => boolean
  /** What the platform probe reports for this vendor, or null when the probe cannot see it. */
  readonly probe: ((hw: z.infer<typeof HardwareSchema>) => boolean) | null
  readonly image: Accelerator | null
  /** Passthrough and driver steps, in the order to try them. */
  readonly steps: readonly string[]
  /** Set when no inference backend exists for the kind. */
  readonly unsupported?: { readonly extend: string; readonly why: string }
  /** Set when the platform makes the kind impossible on this node. */
  readonly onlyOn?: { readonly platform: 'darwin'; readonly why: string }
  readonly optIn?: readonly string[]
}

const CORAL_OPT_IN: readonly string[] = [
  'A Coral is never picked automatically (D39): it must be enabled by an operator.',
  'In the admin UI open the node, Inference devices, and enable the Coral (edgetpu) device; Auto tune only sizes devices that are already enabled.',
]

const EXPECTATIONS: { readonly [kind in ExpectedAccelerator]: Expectation } = {
  'intel-igpu': {
    deviceKeys: (k) => k === 'openvino:gpu',
    probe: (hw) => hw.gpu?.type === 'intel',
    image: 'intel',
    steps: [
      'Pass the render node into the container: --device /dev/dri (Compose: devices: ["/dev/dri:/dev/dri"]).',
      'On the host, `ls -l /dev/dri` must list renderD128; if it does not, the i915/xe driver is not loaded on the host.',
      'Use the intel-latest (or intel-<version>) image: the AMD image carries no OpenVINO GPU runtime. An iGPU older than Gen12 (Skylake to Ice Lake, Jasper/Elkhart Lake) needs intel-legacy-latest instead.',
    ],
  },
  'intel-npu': {
    deviceKeys: (k) => k === 'openvino:npu',
    probe: (hw) => hw.npu?.type === 'intel-npu',
    image: 'intel',
    steps: [
      'Pass the accelerator node into the container: --device /dev/accel (Compose: devices: ["/dev/accel:/dev/accel"]).',
      'On the host, `ls -l /dev/accel` must list accel0; if it does not, the intel_vpu kernel driver is missing (needs kernel 6.6 or newer and the NPU firmware).',
      'Use the intel-latest (or intel-<version>) image.',
    ],
  },
  'amd-webgpu': {
    deviceKeys: (k) => k === 'onnx:webgpu',
    probe: (hw) => hw.gpu?.type === 'amd',
    image: 'amd',
    steps: [
      'Pass the render node into the container: --device /dev/dri.',
      'On the host, `ls -l /dev/dri` must list renderD128; the amdgpu driver and Vulkan (Mesa RADV) must be present.',
      'Use the amd-latest (or amd-<version>) image: the Intel image does not carry the WebGPU runtime.',
    ],
  },
  'amd-vaapi': {
    deviceKeys: () => false,
    probe: (hw) => hw.gpu?.type === 'amd',
    image: 'amd',
    steps: [
      'VAAPI is a hardware DECODE path, not an inference device: this check can only prove the GPU is visible.',
      'Pass the render node into the container: --device /dev/dri, and check `vainfo` on the host.',
      'Use the amd-latest (or amd-<version>) image.',
    ],
  },
  'amd-npu': {
    deviceKeys: (k) => k.startsWith('vitisai:'),
    probe: (hw) => hw.npu?.type === 'amd-xdna',
    image: null,
    steps: [],
    unsupported: {
      extend:
        '@dominevo/addon-pipeline (the detection-pipeline addon): a vitisai execution-provider backend',
      why: 'The runtime maps no AMD XDNA backend yet; the table has no amd-npu column to measure either.',
    },
  },
  'coral-usb': {
    deviceKeys: (k) => k.startsWith('edgetpu:'),
    probe: null,
    image: 'coral',
    steps: [
      'Pass the USB bus into the container: --device /dev/bus/usb AND the device-cgroup rule --device-cgroup-rule="c 189:* rmw" (Compose: device_cgroup_rules: ["c 189:* rmw"]). Without the rule the stick is invisible after it re-enumerates.',
      'On the host, `lsusb` must show "Global Unichip Corp." (before first use) or "Google Inc." (after).',
      'Use a Coral-capable image tag (intel-latest; there is no Coral-specific image).',
    ],
    optIn: CORAL_OPT_IN,
  },
  'coral-pcie': {
    deviceKeys: (k) => k.startsWith('edgetpu:'),
    probe: null,
    image: 'coral',
    steps: [
      'Pass the PCIe device into the container: --device /dev/apex_0.',
      'On the host, `ls -l /dev/apex_0` must exist; if it does not, the gasket and apex kernel modules are not loaded.',
      'Use a Coral-capable image tag (intel-latest; there is no Coral-specific image).',
    ],
    optIn: CORAL_OPT_IN,
  },
  'apple-ane': {
    deviceKeys: (k) => k === 'coreml' || k.startsWith('coreml:'),
    probe: (hw) => hw.npu?.type === 'apple-ane',
    image: 'apple',
    steps: [
      'The Neural Engine is reachable only from a process running natively on the Mac: run the Dominevo desktop app or agent on macOS, not a container.',
    ],
    onlyOn: {
      platform: 'darwin',
      why: 'The Apple Neural Engine exists only on an Apple Silicon Mac, and only a native macOS process can reach it.',
    },
  },
  nvidia: {
    deviceKeys: (k) => /cuda|tensorrt|nvidia/i.test(k),
    // Its own slot; `gpu.type === 'nvidia'` only from a node that predates it.
    probe: (hw) => hw.nvidia != null || hw.gpu?.type === 'nvidia',
    image: 'nvidia',
    steps: [
      ...NVIDIA_CONTAINER_NEEDS,
      'On the host, `nvidia-smi` must list the card; the nvidia images install onnxruntime-gpu from their wheelhouse, so the node reports cuda only after the pipeline addon has provisioned it (a restart of the pipeline addon retries it).',
    ],
  },
}

export interface DeviceFact {
  readonly key: string
  readonly available: boolean
  readonly presence: string | null
  readonly enabled: boolean
  readonly exclusion: string | null
}

export interface ProbeFact {
  readonly platform: string
  readonly arch: string
  readonly cpuModel: string
  readonly gpu: string | null
  readonly npu: string | null
  /** `<name>: present, usable` or `<name>: present, not usable (<reason>)`; null when absent. */
  readonly nvidia: string | null
}

export interface AcceleratorDiagnosis {
  readonly status: 'ok'
  readonly nodeId: string
  readonly expected: ExpectedAccelerator
  readonly verdict: AcceleratorVerdict
  readonly summary: string
  /** What the platform probe saw; null when the probe could not be read. */
  readonly probe: ProbeFact | null
  /** What the node's inference runtime offers; null when it could not be read. */
  readonly inferenceDevices: readonly DeviceFact[] | null
  readonly matchedDevices: readonly string[]
  readonly fixSteps: readonly string[]
  readonly mustNotOmit: readonly string[]
  readonly unsupported: {
    readonly extend: string
    readonly why: string
  } | null
  readonly optIn: readonly string[]
  readonly unavailable: { readonly [part: string]: string }
}

const MAX_DEVICES = 30

function probeFact(hw: z.infer<typeof HardwareSchema>): ProbeFact {
  return {
    platform: hw.platform,
    arch: hw.arch,
    cpuModel: hw.cpuModel,
    gpu: hw.gpu ? `${hw.gpu.type}: ${hw.gpu.name}` : null,
    npu: hw.npu ? hw.npu.type : null,
    nvidia: hw.nvidia ? nvidiaFact(hw.nvidia) : null,
  }
}

function nvidiaFact(nvidia: NonNullable<z.infer<typeof HardwareSchema>['nvidia']>): string {
  return nvidia.usable
    ? `${nvidia.name}: present, usable`
    : `${nvidia.name}: present, not usable (${nvidia.reason ?? 'unknown reason'})`
}

/** The image variant this node's own hardware names, when the probe says enough to pick one. */
function variantFor(
  expectation: Expectation,
  hw: z.infer<typeof HardwareSchema> | null,
): ImageVariant | null {
  if (hw === null) return null
  if (expectation.image === 'intel' && hw.gpu?.type === 'intel') {
    return expectation.deviceKeys('openvino:gpu') ? intelVariantForName(hw.gpu.name) : null
  }
  if (expectation.image === 'nvidia') {
    const name = hw.nvidia?.name ?? (hw.gpu?.type === 'nvidia' ? hw.gpu.name : null)
    return name === null ? null : nvidiaVariantForName(name)
  }
  return null
}

function installSteps(
  expectation: Expectation,
  hw: z.infer<typeof HardwareSchema> | null,
): readonly string[] {
  if (expectation.image === null) return []
  const variant = variantFor(expectation, hw)
  const tag = variant === null ? IMAGE_TAG_BY_ACCELERATOR[expectation.image] : variantTag(variant)
  const steps = [`Image tag for this accelerator: ${tag}. ${NO_BARE_LATEST}`]
  if (variant !== null && variant !== expectation.image) {
    steps.push(
      `This node's ${variant === 'intel-legacy' ? 'iGPU is Gen8-Gen11' : 'card is Pascal/Maxwell'}: use ${tag}, not ${IMAGE_TAG_BY_ACCELERATOR[expectation.image]}. ${IMAGE_VARIANT_TABLE[variant].when}`,
    )
  }
  return steps
}

function mustNotOmitForExpectation(expectation: Expectation): readonly string[] {
  const coral = expectation.image === 'coral'
  const base = MUST_NOT_OMIT.filter((rule) => coral || !rule.startsWith('Coral'))
  return expectation.image !== null && isNvidiaAccelerator(expectation.image)
    ? [...base, ...NVIDIA_MUST_NOT_OMIT]
    : base
}

export interface DiagnoseInputs {
  readonly nodeId: string
  readonly expected: ExpectedAccelerator
  readonly hardware: Read<z.infer<typeof HardwareSchema>>
  readonly devices: Read<z.infer<typeof InferenceDevicesSchema>>
}

/** Pure: the verdict from what was read. */
export function diagnoseAccelerator(input: DiagnoseInputs): AcceleratorDiagnosis {
  const expectation = EXPECTATIONS[input.expected]
  const unavailable: { [part: string]: string } = {}
  const hw = input.hardware.ok ? input.hardware.value : null
  if (!input.hardware.ok) unavailable['hardware'] = input.hardware.reason
  let devices: DeviceFact[] | null = null
  if (input.devices.ok) {
    if (input.devices.value.reachable) {
      devices = cap(
        input.devices.value.devices.map(
          (d): DeviceFact => ({
            key: d.key,
            available: d.available,
            presence: d.presence ?? null,
            enabled: d.enabled,
            exclusion: d.exclusion,
          }),
        ),
        MAX_DEVICES,
      ).items.slice()
    } else {
      unavailable['devices'] = 'the node was unreachable when its devices were probed'
    }
  } else {
    unavailable['devices'] = input.devices.reason
  }
  const base = {
    status: 'ok' as const,
    nodeId: input.nodeId,
    expected: input.expected,
    probe: hw ? probeFact(hw) : null,
    inferenceDevices: devices,
    mustNotOmit: mustNotOmitForExpectation(expectation),
    optIn: expectation.optIn ?? [],
    unavailable,
  }
  const finish = (
    verdict: AcceleratorVerdict,
    summary: string,
    matched: readonly string[],
    fixSteps: readonly string[],
    unsupported: AcceleratorDiagnosis['unsupported'],
  ): AcceleratorDiagnosis => ({
    ...base,
    verdict,
    summary,
    matchedDevices: matched,
    fixSteps,
    unsupported,
  })

  if (expectation.onlyOn && hw && hw.platform !== expectation.onlyOn.platform) {
    return finish(
      'unsupported',
      `${expectation.onlyOn.why} This node runs ${hw.platform}/${hw.arch}.`,
      [],
      expectation.steps,
      {
        extend: 'none: the hardware is not on this node',
        why: expectation.onlyOn.why,
      },
    )
  }
  if (expectation.unsupported) {
    const seen = devices?.filter((d) => expectation.deviceKeys(d.key)) ?? []
    if (seen.length === 0) {
      return finish('unsupported', expectation.unsupported.why, [], [], expectation.unsupported)
    }
  }
  if (devices === null) {
    return finish(
      'unknown',
      'The node\'s inference devices could not be read, so nothing can be said about the accelerator. This is not "absent".',
      [],
      [],
      null,
    )
  }
  const matched = devices.filter((d) => expectation.deviceKeys(d.key))
  const matchedKeys = matched.map((d) => d.key)
  const ready = matched.filter((d) => d.available && d.enabled && d.exclusion === null)
  if (ready.length > 0) {
    return finish(
      'ok',
      `The node offers ${ready.map((d) => d.key).join(', ')}, available and enabled.`,
      matchedKeys,
      [],
      null,
    )
  }
  if (matched.length > 0) {
    const steps: string[] = []
    const notAvailable = matched.filter((d) => !d.available)
    const disabled = matched.filter((d) => d.available && !d.enabled)
    const excluded = matched.filter((d) => d.exclusion !== null)
    if (notAvailable.length > 0) {
      steps.push(
        `${notAvailable.map((d) => d.key).join(', ')} is listed but not available (presence: ${notAvailable.map((d) => d.presence ?? 'unknown').join(', ')}): the runtime could not open the device.`,
        ...expectation.steps,
        ...installSteps(expectation, hw),
      )
    }
    if (disabled.length > 0) {
      steps.push(
        `${disabled.map((d) => d.key).join(', ')} is available but not enabled.`,
        ...(expectation.optIn ?? [
          "Enable it on the node's Inference devices page in the admin UI.",
        ]),
      )
    }
    if (excluded.length > 0) {
      steps.push(...excluded.map((d) => `${d.key} is dropped by the dispatcher: ${d.exclusion}`))
    }
    return finish(
      'misconfigured',
      `The runtime knows ${matchedKeys.join(', ')} but it is not usable yet.`,
      matchedKeys,
      steps,
      null,
    )
  }
  const probeSees = expectation.probe !== null && hw !== null ? expectation.probe(hw) : null
  const sawText =
    probeSees === true
      ? 'The platform probe sees the hardware, but the inference runtime does not offer it.'
      : probeSees === false
        ? 'The platform probe does not see the hardware, and the inference runtime does not offer it.'
        : hw === null && expectation.probe !== null
          ? 'The platform probe could not be read, and the inference runtime does not offer the device.'
          : 'The platform probe cannot see this device kind, and the inference runtime does not offer it.'
  return finish(
    'misconfigured',
    sawText,
    [],
    [
      probeSees === false
        ? 'The device never reached the container: fix the host first (driver, cable, BIOS), then the passthrough below.'
        : 'The hardware is on the host but not in the container, or the image lacks its runtime.',
      ...expectation.steps,
      ...installSteps(expectation, hw),
      ...(expectation.optIn ?? []),
    ],
    null,
  )
}

/** The platform probe of one node as a fact; used by the issue and PR drafts. */
export async function readProbe(client: HubClient, nodeId: string): Promise<Read<ProbeFact>> {
  const hardware = await readQuery(client, 'platformProbe.getHardware', { nodeId }, HardwareSchema)
  return hardware.ok ? { ok: true, value: probeFact(hardware.value) } : hardware
}

export async function supportDiagnoseAccelerator(
  ctx: McpContext,
  args: { readonly nodeId: string; readonly expected: ExpectedAccelerator },
): Promise<AcceleratorDiagnosis | NoSessionResult | RefusedResult> {
  return withHub(ctx, async ({ client }) => {
    const [hardware, devices] = await Promise.all([
      readQuery(client, 'platformProbe.getHardware', { nodeId: args.nodeId }, HardwareSchema),
      readQuery(
        client,
        'pipelineOrchestrator.getNodeInferenceDevices',
        { nodeId: args.nodeId },
        InferenceDevicesSchema,
      ),
    ])
    return diagnoseAccelerator({
      nodeId: args.nodeId,
      expected: args.expected,
      hardware,
      devices,
    })
  })
}
