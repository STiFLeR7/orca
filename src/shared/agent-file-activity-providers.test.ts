import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from './agent-hook-listener'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { upsertBoundedAgentHookStatus } from './agent-hook-status-cache'
import { PANE_KEY } from './agent-hook-listener-test-harness'
import type { AgentHookSource } from './agent-hook-relay'
import type { ParsedAgentStatusPayload } from './agent-status-types'

type Stamp = Pick<ParsedAgentStatusPayload, 'fileActivityAt' | 'fileActivityKind'> | undefined

describe('file-activity stamps from each agent’s real hook normalizer', () => {
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
  const send = (source: AgentHookSource, payload: Record<string, unknown>): Stamp => {
    now += 1000
    vi.setSystemTime(now)
    const event = normalizeHookPayload(state, source, { paneKey: PANE_KEY, payload }, 'production')
    if (!event) {
      return undefined
    }
    upsertBoundedAgentHookStatus(state, event)
    const { fileActivityAt, fileActivityKind } = event.payload
    return { fileActivityAt, fileActivityKind }
  }
  const fresh = (kind: 'edit' | 'command' | 'turn'): Stamp => ({
    fileActivityAt: now,
    fileActivityKind: kind
  })

  it('Kimi file tools', () => {
    send('kimi', { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    expect(send('kimi', { hook_event_name: 'PostToolUse', tool_name: 'WriteFile' })).toEqual(
      fresh('edit')
    )
    expect(send('kimi', { hook_event_name: 'PostToolUse', tool_name: 'StrReplaceFile' })).toEqual(
      fresh('edit')
    )
  })

  it('Kiro file and shell tools', () => {
    send('kiro', { hook_event_name: 'userPromptSubmit', prompt: 'go' })
    expect(send('kiro', { hook_event_name: 'postToolUse', tool_name: 'fs_write' })).toEqual(
      fresh('edit')
    )
    expect(send('kiro', { hook_event_name: 'postToolUse', tool_name: 'execute_bash' })).toEqual(
      fresh('command')
    )
  })

  it('Amp tool results', () => {
    send('amp', { hook_event_name: 'agent.start', prompt: 'go' })
    expect(send('amp', { hook_event_name: 'tool.result', tool: 'create_file' })).toEqual(
      fresh('edit')
    )
  })

  it('Cursor tools', () => {
    send('cursor', { hook_event_name: 'beforeSubmitPrompt', prompt: 'go' })
    expect(send('cursor', { hook_event_name: 'postToolUse', tool_name: 'Write' })).toEqual(
      fresh('edit')
    )
    expect(send('cursor', { hook_event_name: 'postToolUse', tool_name: 'Shell' })).toEqual(
      fresh('command')
    )
  })

  it('Copilot tools', () => {
    send('copilot', { hook_event_name: 'userPromptSubmitted', prompt: 'go' })
    expect(send('copilot', { hook_event_name: 'postToolUse', toolName: 'edit' })).toEqual(
      fresh('edit')
    )
  })

  it('Droid tools', () => {
    send('droid', { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    expect(send('droid', { hook_event_name: 'PostToolUse', tool_name: 'Create' })).toEqual(
      fresh('edit')
    )
    expect(send('droid', { hook_event_name: 'PostToolUse', tool_name: 'Execute' })).toEqual(
      fresh('command')
    )
  })

  it.each(['pi', 'omp'] as const)('%s tool executions', (source) => {
    send(source, { hook_event_name: 'agent_start', prompt: 'go' })
    expect(send(source, { hook_event_name: 'tool_execution_end', tool_name: 'write' })).toEqual(
      fresh('edit')
    )
    expect(send(source, { hook_event_name: 'tool_execution_end', tool_name: 'bash' })).toEqual(
      fresh('command')
    )
  })

  it('OpenCode turn ends, which carry no tool hooks', () => {
    send('opencode', { hook_event_name: 'SessionBusy' })
    expect(send('opencode', { hook_event_name: 'SessionIdle' })).toEqual(fresh('turn'))
  })
})
