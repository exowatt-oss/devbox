import { CliArgumentError } from './args'
import { getOptionalStringFlag } from './flags'
import { formatDevboxStage, printDevboxResult } from './format'
import { operationKey } from './operations'
import type { CommandHandler } from './handlers'
import { clearDevboxDefaultDevice, listDevboxDevices, setDevboxDefaultDevice, showDevboxDefaultDevice } from './device-command'

export const DEVBOX_DEVICE_HANDLERS: Record<string, CommandHandler> = {
  device: async ({ flags, service, json }) => {
    const requested = flags.get('default')
    const clear = flags.get('clear-default') === true
    if (clear && requested !== undefined) {
      throw new CliArgumentError('devbox device accepts either --default [<alias>] or --clear-default, not both.')
    }
    if (clear) {
      printResult('device default', 'device.default.clear', clearDevboxDefaultDevice(service), flags, json)
      return
    }
    if (typeof requested === 'string') {
      printResult('device default', 'device.default.set', setDevboxDefaultDevice(service, requested), flags, json)
      return
    }
    if (requested === true) {
      printResult('device default', 'device.default.show', showDevboxDefaultDevice(service), flags, json)
      return
    }
    printResult('device ls', 'device.list', listDevboxDevices(service), flags, json)
  },
  'device ls': async ({ flags, service, json }) => {
    printResult('device ls', 'device.list', listDevboxDevices(service), flags, json)
  },
  'device default': async ({ flags, service, json }) => {
    printResult('device default', 'device.default.show', showDevboxDefaultDevice(service), flags, json)
  }
}

function printResult(command: string, operation: string, value: unknown, flags: Map<string, string | boolean>, json: boolean): void {
  printDevboxResult(command, operation, value, operationKey(operation, value, getOptionalStringFlag(flags, 'operation-key')), json, formatDevboxStage)
}
