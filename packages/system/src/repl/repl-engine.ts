import * as vm from 'node:vm'
import * as util from 'node:util'
import type {
  IReplEngine,
  IReplContextProvider,
  ReplSessionContext,
  ReplResult,
} from './interfaces.js'

const EXECUTION_TIMEOUT_MS = 5000
const COMPLETION_TIMEOUT_MS = 1000

export class ReplEngine implements IReplEngine {
  constructor(private readonly contextProvider: IReplContextProvider) {}

  async execute(code: string, context: ReplSessionContext): Promise<ReplResult> {
    const start = Date.now()
    const sandbox = await this.buildSandbox(context)

    try {
      const vmContext = vm.createContext(sandbox)
      const script = new vm.Script(code)
      let result: unknown = script.runInContext(vmContext, { timeout: EXECUTION_TIMEOUT_MS })

      // If result is a Promise, await it with timeout
      if (
        result &&
        typeof result === 'object' &&
        'then' in result &&
        typeof (result as { then: unknown }).then === 'function'
      ) {
        result = await Promise.race([
          result as Promise<unknown>,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Async timeout (5s)')), EXECUTION_TIMEOUT_MS),
          ),
        ])
      }

      const duration = Date.now() - start

      if (result === undefined) {
        return { output: 'undefined', type: 'void', duration }
      }

      return {
        output: util.inspect(result, {
          depth: 4,
          colors: false,
          maxArrayLength: 50,
          maxStringLength: 1000,
        }),
        type: 'value',
        duration,
      }
    } catch (err: unknown) {
      // Errors thrown inside vm contexts may not be instanceof Error
      // because they use a different Error constructor from the sandbox
      const message =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err !== null && 'message' in err
            ? String((err as { message: unknown }).message)
            : String(err)
      return {
        output: message,
        type: 'error',
        duration: Date.now() - start,
      }
    }
  }

  async getCompletions(partial: string, context: ReplSessionContext): Promise<string[]> {
    const sandbox = await this.buildSandbox(context)
    const keys = Object.keys(sandbox)

    if (!partial) return keys

    const lastDot = partial.lastIndexOf('.')
    if (lastDot === -1) {
      return keys.filter((k) => k.startsWith(partial))
    }

    // Object property completion: "device.get" -> look up device, return matching keys
    const objPath = partial.substring(0, lastDot)
    const propPrefix = partial.substring(lastDot + 1)

    try {
      const vmContext = vm.createContext(sandbox)
      const obj: unknown = vm.runInContext(objPath, vmContext, { timeout: COMPLETION_TIMEOUT_MS })
      if (obj && typeof obj === 'object') {
        const proto: unknown = Object.getPrototypeOf(obj)
        const objKeys = Object.getOwnPropertyNames(obj)
          .concat(Object.getOwnPropertyNames(proto ?? {}))
          .filter((k) => k.startsWith(propPrefix))
        return [...new Set(objKeys)].map((k) => `${objPath}.${k}`)
      }
    } catch {
      // Ignore errors during completion
    }

    return []
  }

  private async buildSandbox(context: ReplSessionContext): Promise<Record<string, unknown>> {
    const base: Record<string, unknown> = {
      console: {
        log: (...args: unknown[]) => util.inspect(args),
        warn: (...args: unknown[]) => util.inspect(args),
      },
      JSON,
      Math,
      Date,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Map,
      Set,
      Promise,
      Buffer,
      // Blocked globals
      setTimeout: undefined,
      setInterval: undefined,
      fetch: undefined,
      require: undefined,
      process: undefined,
      // Merge user-provided variables
      ...context.variables,
    }

    switch (context.scope.type) {
      case 'system':
        return { ...base, ...(await this.contextProvider.getSystemSandbox()) }

      case 'device':
        return {
          ...base,
          ...(await this.contextProvider.getDeviceSandbox(context.scope.deviceId!)),
        }

      case 'provider':
        return {
          ...base,
          ...(await this.contextProvider.getProviderSandbox(context.scope.providerId!)),
        }

      case 'addon':
        return { ...base, ...(await this.contextProvider.getAddonSandbox(context.scope.addonId!)) }

      default:
        return base
    }
  }
}
