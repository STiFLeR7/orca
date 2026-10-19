import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveAgentFileActivity, withAgentFileActivity } from './agent-file-activity'
import { normalizeHookPayload } from './agent-hook-listener'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { upsertBoundedAgentHookStatus } from './agent-hook-status-cache'
import { PANE_KEY } from './agent-hook-listener-test-harness'
import type { AgentHookSource } from './agent-hook-relay'
import {
  normalizeAgentStatusPayload,
  pickParsedAgentStatusPayload,
  type ParsedAgentStatusPayload
} from './agent-status-types'

const finishedToolKind = (toolName: string | undefined): string | undefined =>
  resolveAgentFileActivity(
    { hookEventName: 'PostToolUse', hookToolName: toolName, payload: { state: 'working' } },
    undefined,
    1
  ).fileActivityKind

describe('tool classification', () => {
  it('matches write and shell tools across agent naming styles', () => {
    for (const name of [
      'Edit',
      'Write',
      'MultiEdit',
      'Bash',
      'apply_patch',
      'write_file',
      'search_replace',
      'run_terminal_command',
      'Execute',
      'Shell',
      'replace_file_content',
      'multi_replace_file_content'
    ]) {
      expect(finishedToolKind(name)).toBeDefined()
    }
  })

  it('ignores read-only tools and missing names', () => {
    for (const name of ['Read', 'Grep', 'Glob', 'WebFetch', 'TodoWrite', 'view', undefined]) {
      expect(finishedToolKind(name)).toBeUndefined()
    }
  })
})

describe('fileActivityAt on the wire', () => {
  it('survives normalization and client projection, and rejects junk', () => {
    const parsed = normalizeAgentStatusPayload({ state: 'working', fileActivityAt: 42 })
    expect(parsed?.fileActivityAt).toBe(42)
    expect(parsed && pickParsedAgentStatusPayload(parsed).fileActivityAt).toBe(42)
    for (const junk of [-1, 0, Number.NaN, '42']) {
      expect(
        normalizeAgentStatusPayload({ state: 'working', fileActivityAt: junk })?.fileActivityAt
      ).toBeUndefined()
    }
  })
})

describe('resolveAgentFileActivity', () => {
  const row = (overrides: Partial<ParsedAgentStatusPayload>): ParsedAgentStatusPayload => ({
    state: 'working',
    prompt: '',
    ...overrides
  })

  it('stamps a finished write and carries the stamp on later rows', () => {
    const stamped = resolveAgentFileActivity(
      { hookEventName: 'PostToolUse', hookToolName: 'Edit', payload: row({ toolName: 'Edit' }) },
      row({ toolName: 'Edit' }),
      50
    )
    expect(stamped).toEqual({ fileActivityAt: 50, fileActivityKind: 'edit' })
    expect(
      resolveAgentFileActivity(
        { hookEventName: 'PreToolUse', hookToolName: 'Read', payload: row({ toolName: 'Read' }) },
        row(stamped),
        60
      )
    ).toEqual(stamped)
  })

  it('moves forward even when the host clock steps back', () => {
    expect(
      resolveAgentFileActivity(
        { hookEventName: 'Stop', payload: row({ state: 'done' }) },
        row({ fileActivityAt: 100 }),
        40
      ).fileActivityAt
    ).toBe(101)
  })

  it('does not count a replayed row again', () => {
    expect(
      resolveAgentFileActivity(
        { hookEventName: 'PostToolUse', hookToolName: 'Edit', isReplay: true, payload: row({}) },
        row({ fileActivityAt: 100 }),
        500
      ).fileActivityAt
    ).toBe(100)
  })

  it('adopts a newer stamp an upstream host already set, and ignores an older one', () => {
    const previous = row({ fileActivityAt: 100, fileActivityKind: 'edit' })
    expect(
      resolveAgentFileActivity(
        { payload: row({ fileActivityAt: 200, fileActivityKind: 'command' }) },
        previous,
        500
      )
    ).toEqual({ fileActivityAt: 200, fileActivityKind: 'command' })
    expect(
      resolveAgentFileActivity({ payload: row({ fileActivityAt: 50 }) }, previous, 500)
    ).toEqual({ fileActivityAt: 100, fileActivityKind: 'edit' })
  })
})

describe('file-activity stamp as the status store admits hook rows', () => {
  let state: HookListenerState
  let now = 1_700_000_000_000

  beforeEach(() => {
    state = createHookListenerState()
    vi.useFakeTimers()
    vi.setSystemTime(now)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Emulates the hook server's admission: stamp against the stored row, then store.
  const send = (
    payload: Record<string, unknown>,
    source: AgentHookSource = 'claude'
  ): number | undefined => {
    now += 1000
    vi.setSystemTime(now)
    const event = normalizeHookPayload(state, source, { paneKey: PANE_KEY, payload }, 'production')
    if (!event) {
      return undefined
    }
    const previous = state.lastStatusByPaneKey.get(PANE_KEY)?.payload
    const stamped = withAgentFileActivity(event, resolveAgentFileActivity(event, previous, now))
    upsertBoundedAgentHookStatus(state, stamped)
    return stamped.payload.fileActivityAt
  }

  it('stamps only when a write tool finishes, not when it starts or awaits permission', () => {
    send({ hook_event_name: 'UserPromptSubmit', prompt: 'fix it' })
    const toolInput = { file_path: '/repo/a.ts' }
    expect(send({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: toolInput })).toBe(
      undefined
    )
    expect(
      send({ hook_event_name: 'PermissionRequest', tool_name: 'Edit', tool_input: toolInput })
    ).toBe(undefined)
    const finished = send({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: toolInput
    })
    expect(finished).toBe(now)
    expect(send({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: toolInput })).toBe(
      finished
    )
  })

  it('does not restamp when subagent hooks re-send the lead row with its last write tool', () => {
    send({ hook_event_name: 'UserPromptSubmit', prompt: 'fan out' })
    send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })
    const finished = send({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' }
    })
    send({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'general-purpose' })
    for (let i = 0; i < 5; i += 1) {
      expect(
        send({
          hook_event_name: 'PreToolUse',
          agent_id: 'a1',
          agent_type: 'general-purpose',
          tool_name: 'Read',
          tool_input: { file_path: `/repo/${i}.ts` }
        })
      ).toBe(finished)
    }
  })

  it('stamps when a subagent finishes a write of its own', () => {
    send({ hook_event_name: 'UserPromptSubmit', prompt: 'fan out' })
    send({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'general-purpose' })
    expect(
      send({
        hook_event_name: 'PostToolUse',
        agent_id: 'a1',
        agent_type: 'general-purpose',
        tool_name: 'Write',
        tool_input: { file_path: '/repo/new.ts' }
      })
    ).toBe(now)
  })

  it('stamps a turn end once, ignoring repeated done rows', () => {
    send({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    const ended = send({ hook_event_name: 'Stop', background_tasks: [] })
    expect(ended).toBe(now)
    expect(send({ hook_event_name: 'Stop', background_tasks: [] })).toBe(ended)
  })

  it('stamps finished writes reported by other agents', () => {
    send({ hook_event_name: 'BeforeAgent', prompt: 'go' }, 'gemini')
    expect(
      send({ hook_event_name: 'AfterTool', tool_name: 'write_file', tool_input: {} }, 'gemini')
    ).toBe(now)
    send({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }, 'codex')
    expect(
      send({ hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: {} }, 'codex')
    ).toBe(now)
  })

  it('ignores a child tool finishing when the cached lead row still names a shell tool', () => {
    send({ hook_event_name: 'UserPromptSubmit', prompt: 'fan out' })
    const finished = send({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' }
    })
    send({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'general-purpose' })
    expect(
      send({
        hook_event_name: 'PostToolUse',
        agent_id: 'a1',
        agent_type: 'general-purpose',
        tool_name: 'Read',
        tool_input: { file_path: '/repo/a.ts' }
      })
    ).toBe(finished)
  })

  it('stamps a background turn once, not again on its all-clear', () => {
    send({ hook_event_name: 'UserPromptSubmit', prompt: 'review' })
    send({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'general-purpose' })
    const leadEnded = send({
      hook_event_name: 'Stop',
      background_tasks: [
        { id: 'a1', type: 'subagent', status: 'running', agent_type: 'general-purpose' }
      ]
    })
    expect(leadEnded).toBe(now)
    expect(send({ hook_event_name: 'SubagentStop', agent_id: 'a1' })).toBe(leadEnded)
  })
})
