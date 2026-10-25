import {
  dumpHomeConnectMessage,
  HC_ACTION,
  loadHomeConnectMessage,
  type HomeConnectMessage,
} from './home-connect-message.js'
import type { HomeConnectWire } from './home-connect-wire.js'

/** Wire that opens but never sends `/ei/initialValues` (session timeout tests). */
export function createSilentHomeConnectWire(): HomeConnectWire {
  let open = false
  const textListeners = new Set<(text: string) => void>()
  const closedListeners = new Set<() => void>()
  return {
    get open() {
      return open
    },
    async connect(): Promise<void> {
      open = true
    },
    send(): void {
      // no appliance responses
    },
    close(): void {
      open = false
      for (const fn of closedListeners) fn()
    },
    onText(listener) {
      textListeners.add(listener)
      return () => textListeners.delete(listener)
    },
    onClosed(listener) {
      closedListeners.add(listener)
      return () => closedListeners.delete(listener)
    },
  }
}

export interface ScriptedWireScript {
  readonly sid?: number
  readonly mandatoryValues?: readonly { readonly uid: number; readonly value: unknown }[]
  /** Rows answered to `GET /ro/allDescriptionChanges`. */
  readonly descriptionChanges?: readonly Readonly<Record<string, unknown>>[]
  /** Answered to `GET /ci/info` / `GET /ni/info`; the service is not announced when absent. */
  readonly ciInfo?: Readonly<Record<string, unknown>>
  readonly niInfo?: Readonly<Record<string, unknown>>
  /** Reject `connect()` (a refused socket) instead of opening. */
  readonly failConnect?: boolean
  /** Decide the answer to a POST; the default is a plain success without a code. */
  readonly respondToPost?: (msg: HomeConnectMessage) => { readonly code?: number } | undefined
}

/** A scripted appliance plus the handles a test drives it with. */
export interface ScriptedHomeConnectWire extends HomeConnectWire {
  /** Every frame the session sent, parsed. */
  readonly sent: readonly HomeConnectMessage[]
  /** The appliance pushes `NOTIFY /ro/values` rows. */
  pushValues(rows: readonly { readonly uid: number; readonly value: unknown }[]): void
  /** The appliance pushes any NOTIFY. */
  pushNotify(resource: string, data: readonly Record<string, unknown>[]): void
  /** The appliance sends a raw text frame, well-formed or not. */
  pushRaw(text: string): void
  /** The appliance side drops the socket. */
  dropFromAppliance(): void
}

/** Scripted appliance for unit tests (TLS-PSK protocol without real socket). */
export function createScriptedHomeConnectWire(script: ScriptedWireScript): ScriptedHomeConnectWire {
  const sid = script.sid ?? 42
  let msgId = 100
  let open = false
  const sent: HomeConnectMessage[] = []
  const textListeners = new Set<(text: string) => void>()
  const closedListeners = new Set<() => void>()
  const serviceVersions: Record<string, number> = {
    ci: 3,
    ei: 2,
    ro: 1,
    iz: 1,
    ...(script.niInfo !== undefined ? { ni: 1 } : {}),
  }

  function emit(text: string): void {
    for (const fn of textListeners) fn(text)
  }

  function nextId(): number {
    msgId += 1
    return msgId
  }

  function respond(
    msg: HomeConnectMessage,
    data: readonly Record<string, unknown>[],
    code?: number,
  ): void {
    emit(
      dumpHomeConnectMessage({
        sID: sid,
        msgID: msg.msgID,
        resource: msg.resource,
        version: msg.version,
        action: HC_ACTION.RESPONSE,
        data,
        ...(code !== undefined ? { code } : {}),
      }),
    )
  }

  function notify(resource: string, data: readonly Record<string, unknown>[]): void {
    emit(
      dumpHomeConnectMessage({
        sID: sid,
        msgID: nextId(),
        resource,
        version: 1,
        action: HC_ACTION.NOTIFY,
        data,
      }),
    )
  }

  function dropClosed(): void {
    if (!open) return
    open = false
    for (const fn of closedListeners) fn()
  }

  return {
    get open() {
      return open
    },
    get sent() {
      return sent
    },
    async connect(): Promise<void> {
      if (script.failConnect === true) throw new Error('scripted connect refused')
      open = true
      emit(
        dumpHomeConnectMessage({
          sID: sid,
          msgID: nextId(),
          resource: '/ei/initialValues',
          version: 2,
          action: HC_ACTION.POST,
          data: [{ edMsgID: 1000 }],
        }),
      )
    },
    send(text: string): void {
      const msg = loadHomeConnectMessage(text)
      sent.push(msg)
      if (msg.action === HC_ACTION.POST) {
        const answer = script.respondToPost?.(msg)
        respond(msg, [], answer?.code)
        return
      }
      if (msg.action !== HC_ACTION.GET) return
      switch (msg.resource) {
        case '/ci/services':
          respond(
            msg,
            Object.entries(serviceVersions).map(([service, version]) => ({ service, version })),
          )
          return
        case '/iz/info':
          respond(msg, [{}])
          return
        case '/ci/info':
          respond(msg, [script.ciInfo ?? {}])
          return
        case '/ni/info':
          respond(msg, [script.niInfo ?? {}])
          return
        case '/ro/allDescriptionChanges':
          respond(msg, [...(script.descriptionChanges ?? [])])
          return
        case '/ro/allMandatoryValues':
          respond(
            msg,
            (script.mandatoryValues ?? []).map((row) => ({ uid: row.uid, value: row.value })),
          )
          return
        default:
          return
      }
    },
    close(): void {
      dropClosed()
    },
    pushValues(rows) {
      notify(
        '/ro/values',
        rows.map((r) => ({ uid: r.uid, value: r.value })),
      )
    },
    pushNotify(resource, data) {
      notify(resource, data)
    },
    pushRaw(text) {
      emit(text)
    },
    dropFromAppliance(): void {
      dropClosed()
    },
    onText(listener) {
      textListeners.add(listener)
      return () => textListeners.delete(listener)
    },
    onClosed(listener) {
      closedListeners.add(listener)
      return () => closedListeners.delete(listener)
    },
  }
}
