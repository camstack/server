import * as fs from 'node:fs'
import * as path from 'node:path'

export interface EnrichedCapability {
  readonly name: string
  readonly exportName: string
  readonly relativeFile: string
  readonly scope: 'device' | 'system'
  readonly mode?: string
  readonly internal: boolean
  readonly deviceNative: boolean
  readonly defaultActive?: boolean
  readonly mountKind?: string
  readonly deviceTypes?: readonly string[]
  readonly providerKind: string | null
  readonly methods: readonly {
    name: string
    kind: string
    deviceBound: boolean
    providerOptional: boolean
    auth?: string
  }[]
  readonly hasRuntimeState: boolean
  readonly hasStatus: boolean
}

export function getEnrichedCapability(
  workspaceRoot: string,
  name: string,
): EnrichedCapability | null {
  const needle = name.trim().toLowerCase()
  return (
    listEnrichedCapabilities(workspaceRoot).find((c) => c.name.toLowerCase() === needle) ?? null
  )
}

export function listEnrichedCapabilities(workspaceRoot: string): EnrichedCapability[] {
  const capsDir = path.join(workspaceRoot, 'packages', 'types', 'src', 'capabilities')
  if (!fs.existsSync(capsDir)) return []
  const out: EnrichedCapability[] = []
  for (const file of fs.readdirSync(capsDir).filter((f) => f.endsWith('.cap.ts'))) {
    const parsed = parseCap(workspaceRoot, path.join(capsDir, file))
    if (parsed) out.push(parsed)
  }
  return out.toSorted((a, b) => a.name.localeCompare(b.name))
}

function parseCap(workspaceRoot: string, filePath: string): EnrichedCapability | null {
  const src = fs.readFileSync(filePath, 'utf8')
  if (!/scope:\s*['"](device|system)['"]/.test(src)) return null
  const exportMatch =
    src.match(/export\s+const\s+(\w+Capability)\s*=\s*\{/) ??
    src.match(/export\s+const\s+(\w+)\s*=\s*\{/)
  if (!exportMatch) return null
  const capBlock = src.slice(exportMatch.index ?? 0)
  const scopeMatch = capBlock.match(/scope:\s*['"](device|system)['"]/)
  const nameMatch = capBlock.match(/name:\s*['"]([^'"]+)['"]/)
  if (!scopeMatch || !nameMatch) return null

  const mode = /\bmode\s*:\s*['"](singleton|collection)['"]/.exec(src)?.[1]
  const deviceNative = /^\s*deviceNative\s*:\s*true/m.test(src)
  const defaultActiveMatch = /^\s*defaultActive\s*:\s*(true|false)/m.exec(src)
  const mountKind = /^\s*mount\s*:\s*\{\s*kind\s*:\s*['"]([^'"]+)['"]/m.exec(src)?.[1]
  const deviceTypes = [...src.matchAll(/DeviceType\.(\w+)/g)].map((m) => m[1]!)
  const providerKind = /^\s*providerKind\s*:\s*['"]([^'"]+)['"]/m.exec(src)?.[1] ?? null
  const internal = /^\s*internal\s*:\s*true/m.test(src)
  const hasRuntimeState = /^\s*runtimeState\s*:/m.test(src)
  const hasStatus = /^\s*status\s*:\s*\{/m.test(src)

  const methods = parseMethods(src)

  return {
    name: nameMatch[1]!,
    exportName: exportMatch[1]!,
    relativeFile: path.relative(workspaceRoot, filePath),
    scope: scopeMatch[1] === 'device' ? 'device' : 'system',
    ...(mode ? { mode } : {}),
    internal,
    deviceNative,
    ...(defaultActiveMatch ? { defaultActive: defaultActiveMatch[1] === 'true' } : {}),
    ...(mountKind ? { mountKind } : {}),
    ...(deviceTypes.length > 0 ? { deviceTypes: [...new Set(deviceTypes)] } : {}),
    providerKind,
    methods,
    hasRuntimeState,
    hasStatus,
  }
}

function parseMethods(src: string): EnrichedCapability['methods'] {
  const scanned = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '))
  const methodsIdx = scanned.indexOf('methods:')
  if (methodsIdx === -1) return []
  const braceIdx = src.indexOf('{', methodsIdx)
  if (braceIdx === -1) return []
  let depth = 1
  let i = braceIdx + 1
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') depth--
    i++
  }
  const body = src.slice(braceIdx + 1, i - 1)
  const scannedBody = scanned.slice(braceIdx + 1, i - 1)
  const methods: EnrichedCapability['methods'][number][] = []
  const methodRegex = /^\s+(\w+)\s*:\s*(optionalMethod|systemMethod|method)\(/gm
  let m: RegExpExecArray | null
  while ((m = methodRegex.exec(body)) !== null) {
    const name = m[1]!
    const openParenIdx = body.indexOf('(', m.index + name.length)
    let pDepth = 1
    let j = openParenIdx + 1
    while (j < body.length && pDepth > 0) {
      if (body[j] === '(') pDepth++
      else if (body[j] === ')') pDepth--
      j++
    }
    const callBody = body.slice(openParenIdx + 1, j - 1)
    let kind = 'query'
    const kindMatch = callBody.match(/kind:\s*['"](query|mutation|subscription)['"]/)
    if (kindMatch) kind = kindMatch[1]!
    const auth = /auth:\s*['"](public|protected|admin)['"]/.exec(callBody)?.[1]
    const input = inputArgument(scannedBody.slice(openParenIdx + 1, j - 1))
    const deviceBound = /\bdeviceId\s*:\s*z\.number\(/.test(input)
    methods.push({
      name,
      kind,
      deviceBound,
      providerOptional: m[2] === 'optionalMethod',
      ...(auth ? { auth } : {}),
    })
  }
  return methods
}

function inputArgument(callBody: string): string {
  let depth = 0
  for (let i = 0; i < callBody.length; i++) {
    const ch = callBody[i]
    if (ch === '(' || ch === '{' || ch === '[') depth++
    else if (ch === ')' || ch === '}' || ch === ']') depth--
    else if (ch === ',' && depth === 0) return callBody.slice(0, i)
  }
  return callBody
}
