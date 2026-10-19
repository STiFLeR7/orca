import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isFileMutatingAgentTool, withAgentFileActivity } from './agent-file-activity'
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

describe('isFileMutatingAgentTool', () => {
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
      expect(isFileMutatingAgentTool(name)).toBe(true)
    }
  })

  it('ignores read-only tools and missing names', () => {
    for (const name of ['Read', 'Grep', 'Glob', 'WebFetch', 'TodoWrite', 'view', undefined]) {
      expect(isFileMutatingAgentTool(name)).toBe(false)
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

describe('withAgentFileActivity', () => {
  const row = (overrides: Partial<ParsedAgentStatusPayload>): ParsedAgentStatusPayload => ({
    state: 'working',
    prompt: '',
    ...overrides
  })

  it('stamps a finished write and carries the stamp on later rows', () => {
    const stamped = withAgentFileActivity(row({ toolName: 'Edit' }), {
      eventName: 'PostToolUse',
      hookToolName: 'Edit',
      previous: row({ toolName: 'Edit' }),
      now: 50
    })
    expect(stamped.fileActivityAt).toBe(50)
    const carried = withAgentFileActivity(row({ toolName: 'Read' }), {
      eventName: 'PreToolUse',
      hookToolName: 'Read',
      previous: stamped,
      now: 60
    })
    expect(carried.fileActivityAt).toBe(50)
  })

  it('moves forward even when the host clock steps back', () => {
    const stamped = withAgentFileActivity(row({ state: 'done' }), {
      eventName: 'Stop',
      hookToolName: undefined,
      previous: row({ fileActivityAt: 100 }),
      now: 40
    })
    expect(stamped.fileActivityAt).toBe(101)
  })
})

describe('hook listener file-activity stamp', () => {
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

  // Emulates the hook server: only accepted rows become the next event's previous status.
  const send = (
    payload: Record<string, unknown>,
    source: AgentHookSource = 'claude'
  ): number | undefined => {
    now += 1000
    vi.setSystemTime(now)
    const event = normalizeHookPayload(state, source, { paneKey: PANE_KEY, payload }, 'production')
    if (event) {
      upsertBoundedAgentHookStatus(state, event)
    }
    return event?.payload.fileActivityAt
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
})
