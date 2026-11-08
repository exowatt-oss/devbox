import type { DevboxDeviceGroup, DevboxShellDevicesListResult, DevboxShellDevicesProgress } from './shell-devices'
import {
  deviceLinePrefix,
  renderShellLsDevice,
  renderShellLsFooter,
  renderShellLsSummary,
  shellLsLayout,
  type ShellLsDeviceIdentity,
  type ShellLsLayout
} from './format-shell-ls'
import { truncateText, type Presentation } from './presentation'

/**
 * TTY-only live view for `shell ls`: a spinner line per in-flight device on
 * stderr, and each device's finished block written to stdout the moment it
 * lands. Never used for --json or non-TTY output.
 */
export type ShellLsLiveOptions = {
  stdout: { write(text: string): unknown }
  stderr: { write(text: string): unknown }
  presentation: Presentation
  glyphs: boolean
  now?: () => number
  intervalMs?: number
}

export type ShellLsLiveRenderer = {
  onProgress(event: DevboxShellDevicesProgress): void
  finish(result: DevboxShellDevicesListResult): void
  stop(): void
}

type Pending = { identity: ShellLsDeviceIdentity; startedAt: number; waking?: string }

const UNICODE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
const ASCII_FRAMES = ['-', '\\', '|', '/'] as const

export function createShellLsLiveRenderer(options: ShellLsLiveOptions): ShellLsLiveRenderer {
  const now = options.now ?? Date.now
  const { presentation } = options
  const frames = options.glyphs ? UNICODE_FRAMES : ASCII_FRAMES
  const pending = new Map<string, Pending>()
  let layout: ShellLsLayout | undefined
  let defaultProfileId: string | undefined
  let drawn = 0
  let frame = 0
  let timer: ReturnType<typeof setInterval> | undefined

  const erase = (): void => {
    if (drawn > 0) {options.stderr.write(`\x1b[${drawn}F\x1b[J`)}
    drawn = 0
  }
  const draw = (): void => {
    if (layout === undefined || pending.size === 0) {return}
    const spinner = frames[frame % frames.length]!
    const lines = [...pending.values()].map((entry) => {
      const seconds = `${((now() - entry.startedAt) / 1000).toFixed(1)} s`
      const state = entry.waking === undefined
        ? `${spinner} connecting ${seconds}`
        : `${spinner} ${options.glyphs ? '…' : '...'} waking box (${entry.waking}) ${seconds}`
      return truncateText(`${deviceLinePrefix(presentation, entry.identity, layout!)}${presentation.style(state, 'muted')}`, presentation.width, '')
    })
    options.stderr.write(`${lines.join('\n')}\n`)
    drawn = lines.length
  }
  const redraw = (): void => {
    erase()
    draw()
  }

  return {
    onProgress(event) {
      if (event.type === 'plan') {
        defaultProfileId = event.defaultProfileId
        layout = shellLsLayout(event.groups.map((group) => identityOf(group, defaultProfileId)), options.glyphs, now())
        timer ??= setInterval(() => {
          frame += 1
          redraw()
        }, options.intervalMs ?? 100)
        timer.unref?.()
        return
      }
      if (event.type === 'start') {
        pending.set(event.group.device, { identity: identityOf(event.group, defaultProfileId), startedAt: now() })
      } else if (event.type === 'waking') {
        const entry = pending.get(event.group.device)
        if (entry !== undefined) {entry.waking = event.message}
      } else {
        erase()
        pending.delete(event.device.device)
        if (layout !== undefined) {options.stdout.write(`${renderShellLsDevice(presentation, event.device, layout)}\n`)}
      }
      redraw()
    },
    finish(result) {
      this.stop()
      options.stdout.write(`\n${renderShellLsSummary(presentation, result)}\n${renderShellLsFooter(presentation)}\n`)
    },
    stop() {
      if (timer !== undefined) {clearInterval(timer)}
      timer = undefined
      erase()
    }
  }
}

function identityOf(group: DevboxDeviceGroup, defaultProfileId: string | undefined): ShellLsDeviceIdentity {
  return {
    device: group.device,
    username: group.username,
    host: group.host,
    port: group.port,
    default: group.profiles.some((profile) => profile.id === defaultProfileId)
  }
}
