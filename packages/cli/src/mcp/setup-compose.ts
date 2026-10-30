/**
 * Edits of the OFFICIAL compose file, and the `docker run` derived from it.
 * Nothing here knows the file's content: it follows the file's own markers
 * (`#@dri`, `#@usb` ...), so a change to the template needs no change here.
 */
import { IMAGE_REPOSITORY, type InstallPaths } from './setup-install-rules.js'

const MARKER_LINE = /^(\s*)# (.*#@([A-Za-z0-9_]+)\s*)$/
const VOLUME_HOST_PATHS: ReadonlyArray<{
  readonly container: string
  readonly key: keyof InstallPaths
}> = [
  { container: '/data', key: 'data' },
  { container: '/recordings', key: 'recordings' },
  { container: '/config', key: 'config' },
  { container: '/backups', key: 'backups' },
]

export interface ComposeCustomization {
  readonly imageTag: string
  readonly markers: readonly string[]
  readonly paths: InstallPaths | undefined
  readonly hubAddress: string | undefined
}

export interface CustomizedCompose {
  readonly body: string
  /** Edits the person still has to make by hand, because the template has no clear placeholder. */
  readonly edits: readonly string[]
}

function swapImageTag(body: string, imageTag: string): string {
  const escaped = IMAGE_REPOSITORY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return body.replace(new RegExp(`(${escaped}):[A-Za-z0-9._-]+`), `$1:${imageTag}`)
}

function enableMarkers(body: string, markers: readonly string[]): string {
  return body
    .split('\n')
    .map((line) => {
      const match = MARKER_LINE.exec(line)
      if (match === null) return line
      const tag = match[3]
      return tag !== undefined && markers.includes(tag)
        ? `${match[1] ?? ''}${match[2] ?? ''}`
        : line
    })
    .join('\n')
}

function setVolumeHosts(body: string, paths: InstallPaths | undefined): CustomizedCompose {
  const edits: string[] = []
  let out = body
  for (const { container, key } of VOLUME_HOST_PATHS) {
    const wanted = paths?.[key]
    const volume = new RegExp(`^(\\s*- )([^\\s:]+)(:${container}\\s*)$`, 'm')
    if (!volume.test(out)) {
      if (wanted !== undefined) {
        edits.push(
          `${container}: no volume line found in the template; map ${wanted} to it yourself`,
        )
      }
      continue
    }
    if (wanted === undefined) {
      edits.push(
        `${container}: left at the template's host path, change it if that is not where you want it`,
      )
      continue
    }
    out = out.replace(
      volume,
      (_m, pre: string, _host: string, post: string) => `${pre}${wanted}${post}`,
    )
  }
  return { body: out, edits }
}

function setHubAddress(body: string, hubAddress: string | undefined): CustomizedCompose {
  const line = /^(\s*- CAMSTACK_HUB_ADDRESS=).*$/m
  if (!line.test(body)) return { body, edits: [] }
  if (hubAddress === undefined) {
    return {
      body,
      edits: [
        'CAMSTACK_HUB_ADDRESS: export it before `docker compose up` (or edit the line) with the hub IP or hostname',
      ],
    }
  }
  return {
    body: body.replace(line, (_m, pre: string) => `${pre}${hubAddress}`),
    edits: [],
  }
}

export function customizeCompose(source: string, c: ComposeCustomization): CustomizedCompose {
  const tagged = enableMarkers(swapImageTag(source, c.imageTag), c.markers)
  const volumes = setVolumeHosts(tagged, c.paths)
  const hub = setHubAddress(volumes.body, c.hubAddress)
  return { body: hub.body, edits: [...volumes.edits, ...hub.edits] }
}

interface ServiceFields {
  scalars: Map<string, string>
  lists: Map<string, string[]>
  maps: Map<string, Map<string, string>>
}

function unquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && (v.startsWith('"') || v.startsWith("'")) && v.endsWith(v[0] ?? '')) {
    return v.slice(1, -1)
  }
  return v
}

function stripComment(line: string): string {
  return line.replace(/\s+#.*$/, '')
}

/** The service's own fields, read from the file's real (uncommented) lines. */
function readService(body: string): ServiceFields {
  const fields: ServiceFields = {
    scalars: new Map(),
    lists: new Map(),
    maps: new Map(),
  }
  let key: string | null = null
  let sub: string | null = null
  for (const raw of body.split('\n')) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue
    const line = stripComment(raw)
    const indent = line.length - line.trimStart().length
    const text = line.trim()
    if (indent === 4) {
      sub = null
      const m = /^([A-Za-z_]+):\s*(.*)$/.exec(text)
      if (m === null) continue
      key = m[1] ?? null
      if (key !== null && (m[2] ?? '') !== '') fields.scalars.set(key, unquote(m[2] ?? ''))
    } else if (indent === 6 && key !== null) {
      if (text.startsWith('- ')) {
        const list = fields.lists.get(key) ?? []
        list.push(unquote(text.slice(2)))
        fields.lists.set(key, list)
      } else {
        const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(text)
        if (m === null) continue
        sub = m[1] ?? null
        const map = fields.maps.get(key) ?? new Map<string, string>()
        if ((m[2] ?? '') !== '' && sub !== null) map.set(sub, unquote(m[2] ?? ''))
        fields.maps.set(key, map)
      }
    } else if (indent === 8 && key !== null && sub !== null) {
      const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(text)
      if (m === null) continue
      const map = fields.maps.get(`${key}.${sub}`) ?? new Map<string, string>()
      map.set(m[1] ?? '', unquote(m[2] ?? ''))
      fields.maps.set(`${key}.${sub}`, map)
    }
  }
  return fields
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/** `docker run` equivalent of the (already customized) compose file. */
export function composeToDockerRun(body: string): string | null {
  const f = readService(body)
  const image = f.scalars.get('image')
  if (image === undefined) return null
  const args: string[] = ['docker run -d']
  const name = f.scalars.get('container_name')
  if (name !== undefined) args.push(`--name ${shellQuote(name)}`)
  const restart = f.scalars.get('restart')
  if (restart !== undefined) args.push(`--restart ${shellQuote(restart)}`)
  const network = f.scalars.get('network_mode')
  if (network !== undefined) args.push(`--network ${shellQuote(network)}`)
  const pids = f.scalars.get('pids_limit')
  if (pids !== undefined) args.push(`--pids-limit=${pids}`)
  for (const d of f.lists.get('devices') ?? []) args.push(`--device ${shellQuote(d)}`)
  for (const r of f.lists.get('device_cgroup_rules') ?? []) {
    args.push(`--device-cgroup-rule ${shellQuote(r)}`)
  }
  for (const g of f.lists.get('group_add') ?? []) args.push(`--group-add ${shellQuote(g)}`)
  for (const v of f.lists.get('volumes') ?? []) args.push(`-v ${shellQuote(v)}`)
  for (const e of f.lists.get('environment') ?? []) {
    // `${VAR:-}` is compose interpolation: it has no value in a plain docker run.
    if (!e.includes('${')) args.push(`-e ${shellQuote(e)}`)
  }
  const driver = f.maps.get('logging')?.get('driver')
  if (driver !== undefined) args.push(`--log-driver ${shellQuote(driver)}`)
  for (const [k, v] of f.maps.get('logging.options') ?? []) {
    args.push(`--log-opt ${shellQuote(`${k}=${v}`)}`)
  }
  args.push(shellQuote(image))
  return args.join(' \\\n  ')
}
