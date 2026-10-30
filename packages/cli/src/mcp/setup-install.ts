/**
 * `setup_install_guide`: an interview, then the steps and the OFFICIAL file
 * bodies for the chosen route. A missing answer is a question, a failed fetch
 * is a structured result naming the URL; nothing here throws.
 */
import { z } from 'zod'
import type { FetchFn } from './context.js'
import { composeToDockerRun, customizeCompose } from './setup-compose.js'
import {
  COMPOSE_MARKERS_BY_ACCELERATOR,
  firstRunHub,
  IMAGE_REPOSITORY,
  IMAGE_TAG_BY_ACCELERATOR,
  MUST_NOT_OMIT,
  NO_BARE_LATEST,
  TEMPLATE_URLS,
  type Accelerator,
  type HostKind,
  type InstallGuideInput,
  type InstallPaths,
  type Role,
} from './setup-install-rules.js'

const FETCH_TIMEOUT_MS = 10_000

export interface Question {
  readonly id: 'hostKind' | 'role' | 'accelerator' | 'paths'
  readonly question: string
  /** Empty for a free-text answer. */
  readonly options: readonly string[]
}

export interface GuideFile {
  readonly path: string
  readonly body: string
  /** The official URL the body was fetched from. */
  readonly source: string
}

export interface NeedAnswers {
  readonly status: 'need-answers'
  readonly questions: readonly Question[]
}

export interface FetchFailed {
  readonly status: 'fetch-failed'
  readonly url: string
  readonly error: string
}

export interface GuideReady {
  readonly status: 'ready'
  readonly hostKind: HostKind
  readonly role: Role
  readonly imageTag: string | null
  readonly steps: readonly string[]
  readonly files: readonly GuideFile[]
  /** Lines the person must still edit by hand. */
  readonly edits: readonly string[]
  readonly mustNotOmit: readonly string[]
}

export type InstallGuideResult = NeedAnswers | FetchFailed | GuideReady

const CONTAINER_ROUTES: readonly HostKind[] = ['docker-compose', 'docker']

const Q_HOST: Question = {
  id: 'hostKind',
  question: 'Where will CamStack run?',
  options: ['docker-compose', 'docker', 'unraid', 'proxmox-lxc', 'macos-desktop'],
}
const Q_ROLE: Question = {
  id: 'role',
  question: 'Which role? Start with a hub; an agent only adds a second machine to an existing hub.',
  options: ['hub', 'agent'],
}
const Q_ACCEL: Question = {
  id: 'accelerator',
  question: 'Which accelerator does this host have?',
  options: ['intel', 'amd', 'coral', 'cpu'],
}
const Q_PATHS: Question = {
  id: 'paths',
  question:
    'Host paths as {data, recordings} (optionally config, backups). Recordings is the one that grows: put it on a roomy disk.',
  options: [],
}

function missingQuestions(input: InstallGuideInput): readonly Question[] {
  const out: Question[] = []
  if (input.hostKind === undefined) out.push(Q_HOST)
  if (input.role === undefined) out.push(Q_ROLE)
  const desktop = input.hostKind === 'macos-desktop'
  if (!desktop && (input.accelerator === undefined || input.accelerator === 'apple')) {
    out.push(Q_ACCEL)
  }
  if (
    input.hostKind !== undefined &&
    CONTAINER_ROUTES.includes(input.hostKind) &&
    input.paths === undefined
  ) {
    out.push(Q_PATHS)
  }
  return out
}

type TextOutcome =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly failure: FetchFailed }

async function fetchText(url: string, fetchFn: FetchFn): Promise<TextOutcome> {
  try {
    const res = await fetchFn(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      return {
        ok: false,
        failure: {
          status: 'fetch-failed',
          url,
          error: `answered ${res.status}`,
        },
      }
    }
    return { ok: true, body: await res.text() }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    return { ok: false, failure: { status: 'fetch-failed', url, error } }
  }
}

const ReleaseSchema = z.object({
  tag_name: z.string(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })),
})
const DMG = /^CamStack-[0-9][0-9A-Za-z.-]*-(arm64|x64)\.dmg$/

function acceleratorEdits(accelerator: Accelerator, role: Role): readonly string[] {
  const note = `Image tag ${IMAGE_TAG_BY_ACCELERATOR[accelerator]} for ${accelerator}. ${NO_BARE_LATEST}`
  return role === 'agent' ? [note, 'Do not run a hub and an agent on the same host.'] : [note]
}

async function composeGuide(
  input: ResolvedInput,
  fetchFn: FetchFn,
  asDockerRun: boolean,
): Promise<InstallGuideResult> {
  const url = TEMPLATE_URLS.compose[input.role]
  const fetched = await fetchText(url, fetchFn)
  if (!fetched.ok) return fetched.failure
  const imageTag = IMAGE_TAG_BY_ACCELERATOR[input.accelerator]
  const custom = customizeCompose(fetched.body, {
    imageTag,
    markers: COMPOSE_MARKERS_BY_ACCELERATOR[input.accelerator],
    paths: input.paths,
    hubAddress: input.hubAddress,
  })
  const edits = [...custom.edits, ...acceleratorEdits(input.accelerator, input.role)]
  const first = firstRun(input)
  if (!asDockerRun) {
    return ready(input, imageTag, {
      steps: [
        'Save docker-compose.yml (below) in an empty directory on the host.',
        'docker compose up -d && docker compose logs -f camstack',
        'The first boot seeds addons and pulls models: allow a few minutes.',
        ...first,
      ],
      files: [{ path: 'docker-compose.yml', body: custom.body, source: url }],
      edits,
    })
  }
  const run = composeToDockerRun(custom.body)
  if (run === null) {
    return {
      status: 'fetch-failed',
      url,
      error: 'the official compose file has no image line; cannot derive docker run',
    }
  }
  return ready(input, imageTag, {
    steps: [
      'Create the host directories named by the -v lines, then run the file below as a shell script.',
      'docker logs -f camstack (the first boot seeds addons and pulls models).',
      ...first,
    ],
    files: [{ path: 'run-camstack.sh', body: `#!/bin/sh\n${run}\n`, source: url }],
    edits,
  })
}

async function unraidGuide(input: ResolvedInput, fetchFn: FetchFn): Promise<InstallGuideResult> {
  const url = TEMPLATE_URLS.unraid[input.role]
  const fetched = await fetchText(url, fetchFn)
  if (!fetched.ok) return fetched.failure
  const imageTag = IMAGE_TAG_BY_ACCELERATOR[input.accelerator]
  const edits = [
    `In the template form, set Repository to ${IMAGE_REPOSITORY}:${imageTag} (the template ships intel-latest). ${NO_BARE_LATEST}`,
    'Recordings: point it at a roomy array share, not the cache; leave Media root as /recordings.',
    'Keep ExtraParams as shipped: --device-cgroup-rule and --pids-limit=8192.',
    ...unraidDeviceEdits(input.accelerator),
  ]
  const first = firstRun(input)
  return ready(input, imageTag, {
    steps: [
      `Unraid: Docker > Add Container > Template, paste ${url}`,
      'Review the paths and Repository (edits below), then Apply.',
      ...first,
    ],
    files: [{ path: urlName(url), body: fetched.body, source: url }],
    edits,
  })
}

function unraidDeviceEdits(accelerator: Accelerator): readonly string[] {
  if (accelerator === 'intel' || accelerator === 'amd') {
    return ['Intel/AMD iGPU: enter /dev/dri in that field. Intel NPU: enter /dev/accel.']
  }
  if (accelerator === 'coral') {
    return ['Coral USB: enter /dev/bus/usb (the whole bus). Coral PCIe/M.2: /dev/apex_0 (and _1).']
  }
  return []
}

function urlName(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1)
}

async function proxmoxGuide(input: ResolvedInput, fetchFn: FetchFn): Promise<InstallGuideResult> {
  const url = TEMPLATE_URLS.proxmoxInstaller
  const fetched = await fetchText(url, fetchFn)
  if (!fetched.ok) return fetched.failure
  const imageTag = IMAGE_TAG_BY_ACCELERATOR[input.accelerator]
  const vars: string[] = [`ROLE=${input.role}`]
  vars.push(`IMAGE_TAG=${IMAGE_REPOSITORY}:${imageTag}`)
  if (input.accelerator === 'cpu') vars.push('PASS_ACCEL=none')
  if (input.role === 'agent') vars.push(`CAMSTACK_HUB_ADDRESS=${input.hubAddress ?? '<hub-ip>'}`)
  if (input.paths !== undefined) vars.push(`RECORDINGS_HOST_PATH=${input.paths.recordings}`)
  const header = fetched.body
    .split('\n')
    .slice(1, 20)
    .filter((l) => l.startsWith('#'))
    .join('\n')
  const first = firstRun(input)
  return ready(input, imageTag, {
    steps: [
      'Run on the Proxmox HOST (needs `pct`), not inside a container. It asks nothing: everything is an environment variable (defaults: VMID 200 hub / 201 agent, 8 cores, 8 GB, 64 GB disk, bridge vmbr0).',
      `${vars.join(' ')} bash -c "$(curl -fsSL ${url})"`,
      'It builds an Ubuntu 24.04 LXC with Docker, passes through the accelerators the host has (PASS_ACCEL=none skips it) and starts CamStack.',
      ...first,
    ],
    files: [
      {
        path: 'install-camstack-proxmox.sh (header)',
        body: header,
        source: url,
      },
    ],
    edits: [
      `The script defaults to the amd image; IMAGE_TAG above sets ${imageTag}. ${NO_BARE_LATEST}`,
      'A hub and an agent on one machine need two CTs (host networking collides otherwise).',
    ],
  })
}

async function macGuide(input: ResolvedInput, fetchFn: FetchFn): Promise<InstallGuideResult> {
  const url = TEMPLATE_URLS.latestRelease
  const fetched = await fetchText(url, fetchFn)
  if (!fetched.ok) return fetched.failure
  let release: z.infer<typeof ReleaseSchema>
  try {
    const parsed = ReleaseSchema.safeParse(JSON.parse(fetched.body))
    if (!parsed.success) {
      return {
        status: 'fetch-failed',
        url,
        error: 'the release answer had no assets',
      }
    }
    release = parsed.data
  } catch {
    return {
      status: 'fetch-failed',
      url,
      error: 'the release answer was not JSON',
    }
  }
  const dmgs = release.assets.filter((a) => DMG.test(a.name))
  const first = firstRun(input)
  return ready(input, null, {
    steps: [
      `Download the disk image for your Mac from release ${release.tag_name}: ${dmgs.map((a) => `${a.name} (${a.browser_download_url})`).join(' or ')}. Apple silicon (M1 and later) takes arm64; Intel takes x64. The CamStackViewer files are a different app.`,
      'Drag CamStack into Applications and open it.',
      `The setup window asks what this Mac should be: choose ${input.role === 'hub' ? 'Hub (full server)' : 'Agent (worker)'}, then Save and start.`,
      ...first,
    ],
    files: [],
    edits: ['A Mac uses the app, not Docker: a container there cannot reach the Neural Engine.'],
  })
}

interface ResolvedInput {
  readonly hostKind: HostKind
  readonly role: Role
  readonly accelerator: Accelerator
  readonly paths: InstallPaths | undefined
  readonly hubAddress: string | undefined
}

function firstRun(input: ResolvedInput): readonly string[] {
  const host = input.hostKind === 'macos-desktop' ? 'localhost' : '<host>'
  if (input.role === 'hub') return firstRunHub(host)
  return [
    'The agent status dashboard answers on http://<agent-host>:4444.',
    'Pair it from the hub: run setup_add_node (it lists agents found on the network), then in the admin UI Cluster > Nodes > Agents found on the network. Type the six digits shown on the other screen on BOTH sides.',
  ]
}

interface Body {
  readonly steps: readonly string[]
  readonly files: readonly GuideFile[]
  readonly edits: readonly string[]
}

function ready(input: ResolvedInput, imageTag: string | null, body: Body): GuideReady {
  return {
    status: 'ready',
    hostKind: input.hostKind,
    role: input.role,
    imageTag,
    steps: body.steps,
    files: body.files,
    edits: body.edits,
    mustNotOmit: input.hostKind === 'macos-desktop' ? [] : MUST_NOT_OMIT,
  }
}

export async function installGuide(
  input: InstallGuideInput,
  fetchFn: FetchFn,
): Promise<InstallGuideResult> {
  const questions = missingQuestions(input)
  if (questions.length > 0) return { status: 'need-answers', questions }
  const { hostKind, role } = input
  if (hostKind === undefined || role === undefined) {
    return { status: 'need-answers', questions: missingQuestions({}) }
  }
  const resolved: ResolvedInput = {
    hostKind,
    role,
    accelerator: hostKind === 'macos-desktop' ? 'apple' : (input.accelerator ?? 'cpu'),
    paths: input.paths,
    hubAddress: input.hubAddress,
  }
  switch (hostKind) {
    case 'docker-compose':
      return composeGuide(resolved, fetchFn, false)
    case 'docker':
      return composeGuide(resolved, fetchFn, true)
    case 'unraid':
      return unraidGuide(resolved, fetchFn)
    case 'proxmox-lxc':
      return proxmoxGuide(resolved, fetchFn)
    case 'macos-desktop':
      return macGuide(resolved, fetchFn)
  }
}
