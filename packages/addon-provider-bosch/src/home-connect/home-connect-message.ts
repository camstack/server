export const HC_ACTION = {
  GET: 'GET',
  POST: 'POST',
  RESPONSE: 'RESPONSE',
  NOTIFY: 'NOTIFY',
} as const

export type HomeConnectAction = (typeof HC_ACTION)[keyof typeof HC_ACTION]

export interface HomeConnectMessage {
  readonly sID: number
  readonly msgID: number
  readonly resource: string
  readonly version: number
  readonly action: HomeConnectAction
  readonly data?: readonly Record<string, unknown>[]
  readonly code?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const ACTIONS: readonly HomeConnectAction[] = Object.values(HC_ACTION)

function actionOf(raw: string): HomeConnectAction | null {
  return ACTIONS.find((a) => a === raw) ?? null
}

export function loadHomeConnectMessage(raw: string): HomeConnectMessage {
  const row: unknown = JSON.parse(raw)
  if (!isRecord(row)) throw new Error('Invalid Home Connect message')
  const sID = row['sID']
  const msgID = row['msgID']
  const resource = row['resource']
  const version = row['version']
  const action = row['action']
  if (
    typeof sID !== 'number' ||
    typeof msgID !== 'number' ||
    typeof resource !== 'string' ||
    typeof version !== 'number' ||
    typeof action !== 'string'
  ) {
    throw new Error('Invalid Home Connect message fields')
  }
  const knownAction = actionOf(action)
  if (knownAction === null) throw new Error(`Unknown Home Connect action: ${action}`)
  let data: readonly Record<string, unknown>[] | undefined
  const dataRaw = row['data']
  if (dataRaw !== undefined) {
    const list = Array.isArray(dataRaw) ? dataRaw : [dataRaw]
    data = list.filter(isRecord)
  }
  const code = row['code']
  return {
    sID,
    msgID,
    resource,
    version,
    action: knownAction,
    data,
    code: typeof code === 'number' ? code : undefined,
  }
}

export function dumpHomeConnectMessage(input: {
  readonly sID: number
  readonly msgID: number
  readonly resource: string
  readonly version: number
  readonly action: HomeConnectAction
  readonly data?: readonly Record<string, unknown>[] | Record<string, unknown>
  readonly code?: number
}): string {
  const msg: Record<string, unknown> = {
    sID: input.sID,
    msgID: input.msgID,
    resource: input.resource,
    version: input.version,
    action: input.action,
  }
  if (input.data !== undefined) {
    msg['data'] = Array.isArray(input.data) ? input.data : [input.data]
  }
  if (input.code !== undefined) msg['code'] = input.code
  return JSON.stringify(msg)
}

export function responseTo(
  init: HomeConnectMessage,
  data: Record<string, unknown>,
): HomeConnectMessage {
  return {
    sID: init.sID,
    msgID: init.msgID,
    resource: init.resource,
    version: init.version,
    action: HC_ACTION.RESPONSE,
    data: [data],
  }
}
