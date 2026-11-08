import {
  asRecord,
  commandTitle,
  keyValue,
  resultStatus,
  roamingSection,
  renderResult,
  section,
  stringValue,
  syncSection,
  table
} from './format-sections'
import { renderDevboxShellReconnectAll } from './format-shell'
import { renderShellSessionsStage } from './format-shell-sessions'
import { renderShellDevicesStage } from './format-shell-devices'
import { renderShellLsStatic } from './format-shell-ls'
import { unicodeEnabled } from './presentation-ansi'
import { renderMutagenStage } from './format-mutagen'
import { renderWorkspaceStage } from './format-workspace'
import { renderPasteStage } from './format-paste'
import { renderProfileCreateStage } from './format-profile-create'
import { renderDeviceStage } from './format-device'
import { createPresentation, type PresentationOptions } from './presentation'

export function formatDevboxStage(
  value: unknown,
  operationId: string,
  command: string,
  options: PresentationOptions = {}
): string {
  const presentation = createPresentation(options)
  const record = asRecord(value)
  if (command === 'shell ls' && record.scope === 'all-devices') {
    return renderShellLsStatic(presentation, record, (options.isTTY ?? options.output?.isTTY ?? process.stdout.isTTY) === true && unicodeEnabled(options))
  }
  const body: string[] = []
  let title = commandTitle(command)
  let status = resultStatus(record, command)
  let trailing: string | undefined

  if (['pair', 'status', 'disable'].includes(command)) {
    title = command === 'status' ? 'Devbox profile status' : `Devbox ${command}`
    body.push(keyValue(presentation, 'Profile', {
      profile: stringValue(record.profileId),
      state: stringValue(record.state),
      generationId: stringValue(record.generationId, 'none')
    }))
    const sync = asRecord(record.sync)
    if (Object.keys(sync).length > 0) {body.push(syncSection(presentation, sync))}
    const roaming = asRecord(record.gitRoaming)
    if (Object.keys(roaming).length > 0) {body.push(roamingSection(presentation, roaming))}
  } else if (command === 'handoff') {
    body.push(keyValue(presentation, 'Handoff', {
      profile: stringValue(record.profileId),
      owner: stringValue(record.owner),
      target: stringValue(record.targetOwner),
      transition: stringValue(record.transition),
      elapsedMs: stringValue(record.elapsedMs)
    }))
  } else if (command === 'run') {
    const job = asRecord(record.job)
    body.push(keyValue(presentation, 'Run', {
      attached: record.attached === true ? 'yes' : 'no',
      jobId: stringValue(job.id),
      jobStatus: stringValue(job.status),
      generationId: stringValue(record.generationId, 'unknown')
    }))
    if (Array.isArray(job.command) && job.command.length > 0) {
      body.push(section(presentation, 'Command', job.command.join(' ')))
    }
  } else if (command === 'jobs status' || command === 'jobs cancel') {
    const jobId = command === 'jobs status' ? record.id : record.jobId ?? record.id
    body.push(keyValue(presentation, 'Job', {
      jobId: stringValue(jobId),
      status: stringValue(record.status, command === 'jobs cancel' ? 'cancelled' : 'unknown')
    }))
  } else if (command === 'jobs log') {
    const text = typeof record.text === 'string' ? record.text : ''
    body.push(
      keyValue(presentation, 'Job', { jobId: stringValue(record.jobId) }),
      section(presentation, 'Output', text || presentation.emptyState('No log output.'))
    )
    status = text
      ? { kind: 'success', message: 'Job log available' }
      : { kind: 'muted', message: 'Job log is empty' }
  } else if (command === 'profile list') {
    const profiles = Array.isArray(record.profiles) ? record.profiles.map(asRecord) : []
    title = 'Devbox profiles'
    status = profiles.length > 0
      ? { kind: 'success', message: `${profiles.length} profile${profiles.length === 1 ? '' : 's'} available` }
      : { kind: 'muted', message: 'No profiles configured' }
    body.push(keyValue(presentation, 'Selection', {
      default: stringValue(record.defaultProfile, 'none')
    }))
    if (profiles.length === 0) {
      body.push(presentation.emptyState('No profiles configured.'))
    } else {
      body.push(section(
        presentation,
        'Profiles',
        table(presentation, {
          rows: profiles,
          columns: [
            {
              header: 'ID',
              get: (profile) => `${profile.id === record.defaultProfile ? '* ' : '  '}${stringValue(profile.id)}`,
              priority: 10
            },
            { key: 'device', header: 'DEVICE', optional: true, priority: 9 },
            { key: 'username', header: 'USER', priority: 8 },
            { key: 'host', header: 'HOST', priority: 8 },
            { key: 'displayName', header: 'NAME', optional: true, priority: 5 },
            { key: 'localRoot', header: 'LOCAL ROOT', optional: true, priority: 2 },
            { key: 'remoteRoot', header: 'REMOTE ROOT', optional: true, priority: 1 }
          ],
          gap: 2,
          headerStyle: 'section'
        })
      ))
    }
  } else if (command === 'device ls' || command === 'device default') {
    const rendered = renderDeviceStage(presentation, command, record)
    title = rendered.title
    status = rendered.status
    body.push(...rendered.body)
    trailing = rendered.trailing
  } else if (command.startsWith('profile device')) {
    body.push(keyValue(presentation, 'Device alias', {
      profile: stringValue(record.profileId),
      device: stringValue(record.device, 'none')
    }))
    status = { kind: 'success', message: record.device ? 'Device alias updated' : 'Device alias cleared' }
  } else if (command === 'profile use') {
    body.push(keyValue(presentation, 'Selection', {
      default: stringValue(record.defaultProfile, 'none')
    }))
    status = {
      kind: 'success',
      message: record.defaultProfile ? 'Default profile updated' : 'Default profile cleared'
    }
  } else if (command.startsWith('profile env-file')) {
    body.push(keyValue(presentation, 'Credential env-file', {
      profile: stringValue(record.profileId),
      path: stringValue(record.envFile, 'none')
    }))
    status = {
      kind: 'success',
      message: record.envFile ? 'Credential env-file updated' : 'Credential env-file cleared'
    }
  } else if (command.startsWith('profile shell-dir')) {
    body.push(keyValue(presentation, 'Shell directory', {
      profile: stringValue(record.profileId),
      path: stringValue(record.shellDir, 'none')
    }))
    status = {
      kind: 'success',
      message: record.shellDir ? 'Default shell directory updated' : 'Default shell directory cleared'
    }
  } else if (command.startsWith('profile proxy-command')) {
    body.push(keyValue(presentation, 'SSH proxy command', { profile: stringValue(record.profileId), command: stringValue(record.proxyCommand, 'none (direct)') }))
    status = { kind: 'success', message: command.endsWith('show') ? 'SSH proxy command' : record.proxyCommand ? 'SSH proxy command set' : 'SSH proxy command cleared' }
  } else if (command.startsWith('profile sync-max-entry-count')) {
    body.push(keyValue(presentation, 'Synchronization setting', {
      profile: stringValue(record.profileId),
      maxEntryCount: stringValue(record.maxEntryCount)
    }))
    status = { kind: 'success', message: 'Synchronization entry cap updated' }
  } else if (command.startsWith('profile sync-watch-polling-interval')) {
    body.push(keyValue(presentation, 'Synchronization setting', { profile: stringValue(record.profileId), override: typeof record.watchPollingIntervalSeconds === 'number' ? `${record.watchPollingIntervalSeconds}s` : 'none (default)', effective: `${stringValue(record.effectiveWatchPollingIntervalSeconds)}s` }))
    status = { kind: 'success', message: 'Watch polling interval updated' }
    trailing = 'Only new Mutagen sessions use this interval; disable and pair to recreate an existing session. The full configured tree and entry cap are unchanged.'
  } else if (command.startsWith('profile ignore')) {
    const patterns = Array.isArray(record.patterns) ? record.patterns.map(asRecord) : []
    body.push(keyValue(presentation, 'Ignore rules', {
      profile: stringValue(record.profileId),
      action: stringValue(record.action),
      requiresRePair: record.requiresRePair === true ? 'yes' : 'no'
    }))
    body.push(patterns.length > 0
      ? section(
        presentation,
        'Patterns',
        table(presentation, {
          rows: patterns,
          columns: [
            { key: 'pattern', header: 'PATTERN', priority: 8, minWidth: 7 },
            { key: 'rootClass', header: 'ROOT CLASS', priority: 5, optional: true, minWidth: 9 }
          ],
          gap: 2,
          headerStyle: 'section'
        })
      )
      : presentation.emptyState('No profile ignore patterns.'))
    if (typeof record.message === 'string' && record.message) {
      body.push(section(presentation, 'Note', record.message))
    }
    status = record.requiresRePair === true
      ? { kind: 'warning', message: 'Ignore rules updated; re-pair required' }
      : { kind: 'success', message: 'Ignore rules updated' }
  } else if (command.startsWith('profile credentials')) {
    const roots = Array.isArray(record.roots) ? record.roots.map(asRecord) : []
    const enabled = record.enabled === true
    body.push(keyValue(presentation, 'Credential roaming', {
      profile: stringValue(record.profileId),
      enabled: enabled ? 'yes' : 'no',
      roots: String(roots.length)
    }))
    if (enabled && roots.length > 0) {
      body.push(section(presentation, 'Roots', roots.map((root) => `${stringValue(root.id)}: ${stringValue(root.localRoot)} -> ${stringValue(root.remoteRoot)} · excludes ${Array.isArray(root.excludes) ? root.excludes.join(', ') : 'none'}`).join('\n')))
    } else {
      body.push(presentation.emptyState(enabled ? 'No credential roots configured.' : 'Credential roaming is disabled.'))
    }
    status = { kind: enabled ? 'success' : 'muted', message: enabled ? 'Credential roaming enabled' : 'Credential roaming disabled' }
    if (command === 'profile credentials enable' && enabled) {
      trailing = record.updatedExistingRoot === true
        ? `Run: devbox disable --profile ${stringValue(record.profileId)} && devbox pair --profile ${stringValue(record.profileId)}`
        : `Run: devbox pair --profile ${stringValue(record.profileId)}`
    }
  } else if (command.startsWith('profile paste')) {
    const rendered = renderPasteStage(presentation, command, record)
    body.push(...rendered.body)
    status = rendered.status
    trailing = rendered.trailing
  } else if (command === 'profile create') {
    const rendered = renderProfileCreateStage(presentation, record)
    body.push(...rendered.body)
    status = rendered.status
  } else if (command === 'ports open') {
    body.push(keyValue(presentation, 'Forwarded port', {
      profile: stringValue(record.profileId),
      localPort: stringValue(record.localPort),
      remotePort: stringValue(record.remotePort),
      address: stringValue(record.address, 'localhost')
    }))
  } else if (command === 'init' || command === 'connect') {
    const rendered = renderWorkspaceStage(presentation, command, record)
    title = rendered.title
    status = rendered.status
    body.push(...rendered.body)
    trailing = rendered.trailing
  } else if (command.startsWith('mutagen ')) {
    const rendered = renderMutagenStage(presentation, command, record)
    title = rendered.title
    status = rendered.status
    body.push(...rendered.body)
    trailing = rendered.trailing
  } else if (command === 'shell rm --unattached --all-devices') {
    const rendered = renderShellDevicesStage(presentation, record)
    if (rendered.title) {title = rendered.title}
    status = rendered.status
    body.push(...rendered.body)
  } else if (command === 'shell ls' || command === 'shell rm' || command === 'shell rm --all' || command === 'shell rm --unattached') {
    const rendered = renderShellSessionsStage(presentation, command, record)
    if (rendered.title) {title = rendered.title}
    status = rendered.status
    body.push(...rendered.body)
  } else if (command === 'shell reconnect --all') {
    const rendered = renderDevboxShellReconnectAll(presentation, record)
    title = rendered.title
    status = rendered.status
    body.push(...rendered.body)
    trailing = rendered.trailing
  } else if (Object.keys(record).length === 0) {
    body.push(presentation.emptyState('Operation completed without additional details.'))
    status = { kind: 'success', message: 'Operation completed' }
  } else {
    const entries = ['id', 'state', 'status', 'knownHostsFile']
      .filter((key) => record[key] !== undefined)
      .map((key) => ({ key, value: record[key] }))
    body.push(entries.length > 0
      ? section(presentation, 'Result', presentation.keyValue(entries))
      : presentation.emptyState('Operation completed without displayable details.'))
  }

  return renderResult(presentation, title, status, body, operationId, trailing)
}

