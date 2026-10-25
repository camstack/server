/**
 * Demo hub for README viewer screenshots. HTTP + tRPC-over-WebSocket.
 * Answers the procedures the viewer paints, and serves synthetic JPEGs.
 * No real footage, names, or addresses.
 */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(
  '/Users/gianlucaruocco/Documents/Git/camstack/camstack-server/package.json',
)
const { WebSocketServer } = require('ws')
const superjson = require('superjson')

const PORT = Number(process.env.README_HUB_PORT ?? 8791)
const FRAMES = process.env.README_FRAMES ?? '/tmp/readme-frames'

const CAMERAS = [
  { id: 1, name: 'Front door', location: 'Porch', scene: 'front-door', features: [] },
  { id: 2, name: 'Driveway', location: 'Front of house', scene: 'driveway', features: [] },
  { id: 3, name: 'Garage', location: 'Garage', scene: 'garage', features: [] },
  { id: 4, name: 'Porch', location: 'Porch', scene: 'porch', features: [] },
  { id: 5, name: 'Garden', location: 'Garden', scene: 'garden', features: [] },
  { id: 6, name: 'Side gate', location: 'Garden', scene: 'side-gate', features: [] },
  { id: 7, name: 'Back yard', location: 'Garden', scene: 'back-yard', features: [] },
  { id: 8, name: 'Hallway', location: 'Indoors', scene: 'hallway', features: [] },
  { id: 9, name: 'Patio', location: 'Garden', scene: 'patio', features: [] },
]

const SCENE_BY_ID = new Map(CAMERAS.map((c) => [c.id, c.scene]))

const CROPS = ['person', 'car', 'dog', 'package', 'bike']

function cameraRow(c) {
  return {
    id: c.id,
    stableId: `cam-${c.id}`,
    addonId: 'provider-example',
    type: 'camera',
    name: c.name,
    location: c.location,
    disabled: false,
    parentDeviceId: null,
    role: null,
    online: true,
    probed: true,
    features: c.features,
    isCamera: true,
    config: {},
    secretConfigPaths: [],
    metadata: { manufacturer: 'Example', model: 'DemoCam' },
  }
}

function track(id, deviceId, className, minutesAgo, extra) {
  const lastSeen = Date.now() - minutesAgo * 60_000
  return {
    trackId: id,
    deviceId,
    className,
    label: extra.label,
    firstSeen: lastSeen - 20_000,
    lastSeen,
    state: 'idle',
    active: false,
    zonesVisited: [],
    zoneNames: extra.zone ? [extra.zone] : [],
    classes: [className],
    audioLabels: [],
    bestEventId: `ev-${id}`,
    source: 'pipeline',
    importance: extra.importance ?? 2,
  }
}

const TRACKS = [
  track('t-person-1', 1, 'person', 4, { zone: 'Porch', label: 'person', importance: 4 }),
  track('t-car-1', 2, 'vehicle', 12, { zone: 'Driveway', label: 'car', importance: 3 }),
  track('t-dog-1', 5, 'animal', 18, { zone: 'Garden', label: 'dog', importance: 2 }),
  track('t-pkg-1', 4, 'package', 26, { zone: 'Porch', label: 'package', importance: 3 }),
  track('t-person-2', 3, 'person', 35, { zone: 'Garage', label: 'person', importance: 2 }),
  track('t-bike-1', 6, 'vehicle', 48, { zone: 'Side gate', label: 'bicycle', importance: 2 }),
  track('t-person-3', 7, 'person', 70, { zone: 'Back yard', label: 'person', importance: 1 }),
  track('t-car-2', 2, 'vehicle', 95, { zone: 'Driveway', label: 'car', importance: 2 }),
  track('t-dog-2', 9, 'animal', 110, { zone: 'Patio', label: 'dog', importance: 1 }),
  track('t-person-4', 8, 'person', 140, { zone: 'Hallway', label: 'person', importance: 2 }),
  track('t-pkg-2', 1, 'package', 180, { zone: 'Porch', label: 'package', importance: 2 }),
  track('t-person-5', 5, 'person', 210, { zone: 'Garden', label: 'person', importance: 1 }),
]

const CROP_FOR_CLASS = {
  person: 'person',
  vehicle: 'car',
  animal: 'dog',
  package: 'package',
}

function kindsFor(deviceIds) {
  const kinds = [
    { kind: 'person', parentKind: null, iconId: 'person' },
    { kind: 'vehicle', parentKind: null, iconId: 'vehicle' },
    { kind: 'car', parentKind: 'vehicle', iconId: 'car' },
    { kind: 'bicycle', parentKind: 'vehicle', iconId: 'bike' },
    { kind: 'animal', parentKind: null, iconId: 'animal' },
    { kind: 'dog', parentKind: 'animal', iconId: 'dog' },
    { kind: 'package', parentKind: null, iconId: 'package' },
  ]
  return deviceIds.map((deviceId) => ({ deviceId, kinds }))
}

function density(input) {
  const since = typeof input.since === 'number' ? input.since : Date.now() - 86_400_000
  const until = typeof input.until === 'number' ? input.until : Date.now()
  const bucketMs =
    typeof input.bucketMs === 'number' && input.bucketMs > 0 ? input.bucketMs : 60_000
  const rows = []
  const span = Math.max(until - since, bucketMs)
  const count = Math.min(240, Math.ceil(span / bucketMs))
  for (let i = 0; i < count; i += 1) {
    const start = since + i * bucketMs
    const hour = new Date(start).getHours()
    const burst = i % 19 === 0 || i % 29 === 4
    const wave = burst && hour >= 7 && hour <= 22 ? 10 + (i % 9) : 0
    rows.push({
      bucketStart: start,
      motion: wave,
      audio: wave > 12 ? 2 : 0,
      ...(wave > 12 ? { audioDbfs: -28 } : {}),
    })
  }
  return rows
}

function availability(input) {
  const fromMs = typeof input.fromMs === 'number' ? input.fromMs : Date.now() - 86_400_000
  const toMs = typeof input.toMs === 'number' ? input.toMs : Date.now()
  const deviceId = typeof input.deviceId === 'number' ? input.deviceId : 1
  const gap = Math.min(20 * 60_000, Math.floor((toMs - fromMs) / 8))
  const mid = fromMs + Math.floor((toMs - fromMs) / 3)
  return {
    deviceId,
    read: 'read',
    ranges: [
      { startMs: fromMs, endMs: mid },
      { startMs: mid + gap, endMs: toMs },
    ],
  }
}

function links(input) {
  const targets = Array.isArray(input.targets) ? input.targets : []
  const now = Date.now()
  return targets.map((target) => {
    const deviceId = typeof target.deviceId === 'number' ? target.deviceId : 0
    const width = typeof target.width === 'number' ? target.width : 'full'
    return {
      deviceId,
      url: `/addon/snapshot/media/${deviceId}.jpg?w=${width}`,
      capturedAt: now - 4_000,
      ageMs: 4_000,
      width: typeof target.width === 'number' ? target.width : null,
      neverCaptured: false,
      sleeping: false,
      stateReason: null,
      battery: false,
      expiresAt: now + 120_000,
    }
  })
}

function overview(input) {
  const ids = Array.isArray(input.deviceIds) ? input.deviceIds : CAMERAS.map((c) => c.id)
  const now = Date.now()
  return ids
    .filter((id) => typeof id === 'number')
    .map((deviceId) => ({
      deviceId,
      lastCapturedAt: now - 4_000,
      cacheAgeMs: 4_000,
      etag: `demo-${deviceId}`,
    }))
}

function recentTracks(input) {
  const ids = Array.isArray(input.deviceIds) ? input.deviceIds : []
  const wanted = ids.length > 0 ? new Set(ids) : null
  const tracks = TRACKS.filter((row) => wanted === null || wanted.has(row.deviceId))
  return { tracks, nextCursor: null }
}

const HANDLERS = {
  'auth.me': () => ({ id: 'demo-user', username: 'demo', isAdmin: true }),
  'auth.getServerName': () => ({ name: 'Home hub', isDefault: false }),
  'auth.listLoginMethods': () => ({ methods: [{ kind: 'password' }] }),
  'auth.refreshSession': () => ({ __error: 'no refresh in the demo' }),
  'localNetwork.getConnectionEndpoints': () => ({ endpoints: [], localPort: null }),
  'localNetwork.getViewerEndpoints': () => ({ resolved: [] }),
  'system.info': () => ({
    streaming: true,
    notifications: true,
    objectDetection: true,
    serverName: { name: 'Home hub', isDefault: false },
  }),
  'deviceManager.listAll': () => CAMERAS.map(cameraRow),
  'snapshot.getSnapshotLinks': (input) => links(input),
  'snapshot.getSnapshotOverview': (input) => overview(input),
  'pipelineAnalytics.listRecentTracks': (input) => recentTracks(input),
  'pipelineAnalytics.listTracks': (input) => recentTracks(input),
  'pipelineAnalytics.getTrack': (input) => {
    const id = typeof input.trackId === 'string' ? input.trackId : ''
    return TRACKS.find((row) => row.trackId === id) ?? TRACKS[0]
  },
  'pipelineAnalytics.listEventKindsBatch': (input) =>
    kindsFor(Array.isArray(input.deviceIds) ? input.deviceIds : CAMERAS.map((c) => c.id)),
  'pipelineAnalytics.listEventKinds': () => kindsFor(CAMERAS.map((c) => c.id))[0]?.kinds ?? [],
  'pipelineAnalytics.getEventDensity': (input) => density(input),
  'pipelineAnalytics.getEventDensityBatch': (input) => {
    const ids = Array.isArray(input.deviceIds) ? input.deviceIds : []
    return ids.map((deviceId) => ({
      deviceId,
      read: 'read',
      buckets: density(input),
    }))
  },
  'recording.getAvailability': (input) => availability(input),
  'recordingArchive.getAvailabilityBatch': (input) => {
    const ids = Array.isArray(input.deviceIds) ? input.deviceIds : []
    return ids.map((deviceId) => availability({ ...input, deviceId }))
  },
  'recording.getDaysWithRecordings': () => {
    const day = new Date()
    day.setUTCHours(0, 0, 0, 0)
    return [day.getTime()]
  },
  'recording.listSources': () => [],
  'notifications.listRules': () => [],
  'site.getZones': () => [],
  'deviceManager.listSiteZones': () => [],
  'preferences.get': () => ({ rows: [] }),
  'preferences.changedSince': () => ({ rows: [] }),
  'recordingExport.listExports': () => [],
  'deviceManager.listLocationIcons': () => [],
  'deviceManager.getChildren': () => [],
  'deviceManager.getBindings': () => ({ entries: [] }),
  'deviceManager.getDeviceStatusAggregateBatch': () => [],
  'motion.getStatus': () => ({ active: false }),
  'recordingArchive.getDeviceConfig': () => ({ enabled: true, mode: 'events' }),
  'networkLink.getStatus': () => ({ state: 'up' }),
  'turnProvider.getTurnServers': () => ({ iceServers: [] }),
  'webrtcSession.listStreams': () => ({ streams: [] }),
  'pipelineOrchestrator.getCameraMetrics': () => null,
  'system.getNativeRelease': () => null,
}

function decodeInput(raw) {
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'object' && raw !== null && 'json' in raw) {
    return superjson.deserialize(raw)
  }
  return raw
}

function answer(path, rawInput) {
  const input = decodeInput(rawInput)
  const safe = input !== null && typeof input === 'object' ? input : {}
  const handler = HANDLERS[path]
  if (handler === undefined) {
    process.stdout.write(`miss ${path}\n`)
    if (path.includes('list') || path.endsWith('Batch') || path.endsWith('Children')) return []
    return null
  }
  return handler(safe)
}

function serialize(value) {
  return superjson.serialize(value)
}

function httpResult(value) {
  return JSON.stringify({ result: { data: serialize(value) } })
}

function jpegFor(url) {
  const snap = /\/addon\/snapshot\/media\/(\d+)\.jpg/.exec(url)
  if (snap) {
    const scene = SCENE_BY_ID.get(Number(snap[1])) ?? 'front-door'
    return join(FRAMES, 'scenes', `${scene}.jpg`)
  }
  const media = /\/event-media\/(?:o\/track\/)?([^/?]+)/.exec(url)
  if (media) {
    const id = decodeURIComponent(media[1] ?? '')
    const row = TRACKS.find((t) => t.trackId === id || `ev-${t.trackId}` === id)
    const crop = CROP_FOR_CLASS[row?.className ?? ''] ?? 'person'
    const file = row?.label === 'bicycle' ? 'bike' : crop
    return join(FRAMES, 'crops', `${CROPS.includes(file) ? file : 'person'}.jpg`)
  }
  return null
}

function cors(req, res) {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '*'
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-camstack-lang')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.length === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        resolve(undefined)
      }
    })
  })
}

const server = createServer(async (req, res) => {
  cors(req, res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  if (url.pathname === '/health' || url.pathname === '/trpc/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  const file = jpegFor(url.pathname + url.search)
  if (file !== null) {
    try {
      const bytes = readFileSync(file)
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' })
      res.end(bytes)
    } catch (err) {
      process.stdout.write(`jpeg ${file} ${err instanceof Error ? err.message : 'read failed'}\n`)
      res.writeHead(404)
      res.end()
    }
    return
  }
  if (url.pathname.startsWith('/trpc/')) {
    const path = decodeURIComponent(url.pathname.slice('/trpc/'.length))
    let raw = undefined
    if (req.method === 'GET') {
      const encoded = url.searchParams.get('input')
      if (encoded !== null) {
        try {
          raw = JSON.parse(encoded)
        } catch {
          raw = undefined
        }
      }
    } else {
      raw = await readBody(req)
    }
    const value = answer(path, raw)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(httpResult(value))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

const wss = new WebSocketServer({ server, path: '/trpc' })

wss.on('connection', (socket) => {
  socket.on('message', (data) => {
    const text = typeof data === 'string' ? data : data.toString('utf8')
    if (text === 'PING') {
      socket.send('PONG')
      return
    }
    if (text === 'PONG') return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    const batch = Array.isArray(message) ? message : [message]
    for (const item of batch) {
      if (item === null || typeof item !== 'object') continue
      if (item.method === 'connectionParams') continue
      if (item.method === 'subscription.stop') continue
      if (typeof item.id !== 'number' && typeof item.id !== 'string') continue
      if (item.method === 'subscription') {
        socket.send(JSON.stringify({ id: item.id, result: { type: 'started' } }))
        continue
      }
      const params = item.params ?? {}
      const path = typeof params.path === 'string' ? params.path : ''
      const value = answer(path, params.input)
      if (value !== null && typeof value === 'object' && '__error' in value) {
        socket.send(
          JSON.stringify({
            id: item.id,
            error: serialize({
              message: 'demo refusal',
              code: -32600,
              data: { code: 'BAD_REQUEST', httpStatus: 400 },
            }),
          }),
        )
        continue
      }
      socket.send(
        JSON.stringify({
          id: item.id,
          result: { type: 'data', data: serialize(value) },
        }),
      )
    }
  })
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`readme hub http://127.0.0.1:${PORT}\n`)
})
