/** This file guards docs/INTEROP.md so a future change fails loudly rather than breaking terminal hosts. */
import { describe, expect, it } from 'vitest'
import { buildAttachMarker, buildDetachMarker } from './shell-terminal-marker'
import {
  allocateDevboxShellId,
  buildDevboxShellAttachCommand,
  buildDevboxShellSessionName,
  devboxShellSocketName,
  devboxShellSessionPrefix,
  parseDevboxShellSessionName,
  sanitizeDevboxShellComponent
} from './shell'

const CREDENTIAL_SOURCE = `'devbox_env_path='\\''/dev/shm/devbox-roam.env'\\''; if [ "$(uname -s)" = Darwin ]; then devbox_env_path="$(getconf DARWIN_USER_TEMP_DIR)devbox-roam.env"; fi; set -a; . "$devbox_env_path" 2>/dev/null; set +a; exec $SHELL'`

describe('docs/INTEROP.md contract', () => {
  it('keeps the documented session-name scheme and sanitization rules', () => {
    expect(devboxShellSessionPrefix(' profile / one ')).toBe('devbox-profile-one-')
    expect(sanitizeDevboxShellComponent('  worker α / "one"  ')).toBe('worker-one')
    expect(sanitizeDevboxShellComponent('name with spaces')).toBe('name-with-spaces')
    expect(sanitizeDevboxShellComponent('name"quoted')).toBe('name-quoted')
    expect(() => sanitizeDevboxShellComponent(' \u2603 " ')).toThrow()
    expect(() => sanitizeDevboxShellComponent('')).toThrow()

    const long = 'x'.repeat(120)
    expect(sanitizeDevboxShellComponent(long)).toBe('x'.repeat(96))

    const sessionName = buildDevboxShellSessionName(' profile / one ', 3, ' worker / one ')
    expect(sessionName).toBe('devbox-profile-one-3-worker-one')
    expect(parseDevboxShellSessionName(' profile / one ', sessionName)).toEqual({
      id: 3,
      name: 'worker-one',
      sessionName
    })
    expect(parseDevboxShellSessionName(' profile / one ', 'devbox-other-3-worker-one')).toBeUndefined()
    expect(parseDevboxShellSessionName(' profile / one ', 'devbox-profile-one-3-')).toBeUndefined()
    expect(allocateDevboxShellId([{ id: 1 }, { id: 3 }])).toBe(2)
  })

  it('keeps the OSC 9998 terminal host marker contract stable', () => {
    expect(buildAttachMarker({
      profileId: 'roam',
      sessionId: 2,
      sessionName: 'devbox-roam-2-emufix',
      friendlyName: 'emufix',
      host: 'devbox.example',
      port: 22,
      username: 'sample',
      remoteCwd: '/home/sample/project',
      program: 'phi',
      tmuxSocket: 'devbox-01ff033d051e',
      cliVersion: '0.2.15'
    })).toContain('"event":"attach"')
    expect(buildDetachMarker({ profileId: 'roam', sessionName: 'devbox-roam-2-emufix' })).toBe(
      '{"v":1,"event":"detach","profileId":"roam","sessionName":"devbox-roam-2-emufix"}'
    )
  })

  it('starts a private server before applying the tmux option and status contract', () => {
    const sessionName = buildDevboxShellSessionName('roam', 3, 'worker')
    const socket = devboxShellSocketName('roam')
    const attach = buildDevboxShellAttachCommand(sessionName, '/remote/root', 'roam', socket)
    const lines = attach.split('\n')
    const bootstrapIndex = lines.findIndex((line) => line.includes('new-session -d -s "$bootstrap"'))
    const newSessionIndex = lines.findIndex((line) => line.includes('new-session -d -s "$session"'))
    const options = lines.slice(bootstrapIndex + 1, newSessionIndex).map((line) => line.trim())

    expect(socket).toBe('devbox-01ff033d051e')
    expect(bootstrapIndex).toBeGreaterThan(-1)
    expect(options).toEqual(expect.arrayContaining([
      'tmux -f /dev/null -L "$socket" set-option -g extended-keys on 2>/dev/null || tmux -f /dev/null -L "$socket" set-option -s extended-keys on',
      'tmux -f /dev/null -L "$socket" set-option -g mouse on 2>/dev/null || tmux -f /dev/null -L "$socket" set-option -s mouse on',
      'tmux -f /dev/null -L "$socket" set-option -g history-limit 100000',
      'tmux -f /dev/null -L "$socket" set-option -g set-clipboard on',
      'tmux -f /dev/null -L "$socket" set-option -su terminal-features 2>/dev/null || true',
      "tmux -f /dev/null -L \"$socket\" set-option -sa terminal-features 'xterm*:clipboard:ccolour:cstyle:focus:title' 2>/dev/null || true",
      'tmux -f /dev/null -L "$socket" set-option -g set-titles on',
      "tmux -f /dev/null -L \"$socket\" set-option -g set-titles-string '#{pane_title}'"
    ]))
    expect(attach).not.toContain("terminal-features 'clipboard'")
    expect(attach).not.toContain('allow-passthrough')
    expect(options.some((line) => line.includes('set-option -g history-limit 100000'))).toBe(true)
    expect(lines[newSessionIndex]).toBe(
      `  tmux -f /dev/null -L "$socket" new-session -d -s "$session" -c "$cwd" ${CREDENTIAL_SOURCE}`
    )
    expect(attach).not.toContain('extended-keys-format')
    expect(attach).toContain("bind-key -T copy-mode WheelUpPane select-pane -t = '\\;'")
    expect(attach).toContain('bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-selection-and-cancel')
    expect(attach).toContain('#{?client_prefix')
    expect(attach).toContain('#{=-40:pane_current_path}')
    expect(attach).not.toContain('MouseDown2Pane')

    const credentialAttach = buildDevboxShellAttachCommand(sessionName, '/remote/root', 'roam', socket)
    expect(credentialAttach.split('\n')[newSessionIndex]).toBe(
      `  tmux -f /dev/null -L "$socket" new-session -d -s "$session" -c "$cwd" ${CREDENTIAL_SOURCE}`
    )
  })
})
