import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHookListenerState } from '../shared/agent-hook-listener/listener-state'
import { upsertBoundedAgentHookStatus } from '../shared/agent-hook-status-cache'
import { PANE_KEY } from '../shared/agent-hook-listener-test-harness'
import type { AgentHookSource } from '../shared/agent-hook-relay'
import { RelayProviderHookNormalization } from './agent-hook-provider-normalization'

describe('relay file-activity stamp across agents sharing a pane', () => {
  let now = 1_700_000_000_000
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('only moves forward when agents alternate', () => {
    const canonical = createHookListenerState()
    const relay = new RelayProviderHookNormalization()
    const send = (
      source: AgentHookSource,
      payload: Record<string, unknown>
    ): number | undefined => {
      now += 1000
      vi.setSystemTime(now)
      const event = relay.normalize(canonical, source, { paneKey: PANE_KEY, payload }, 'production')
      if (event) {
        // Emulates the relay's canonical admission of every forwarded row.
        upsertBoundedAgentHookStatus(canonical, event)
      }
      return event?.payload.fileActivityAt
    }

    send('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'one' })
    const claudeWrite = send('claude', { hook_event_name: 'PostToolUse', tool_name: 'Edit' })
    send('codex', { hook_event_name: 'UserPromptSubmit', prompt: 'two' })
    const codexWrite = send('codex', { hook_event_name: 'PostToolUse', tool_name: 'apply_patch' })
    expect(codexWrite).toBeGreaterThan(claudeWrite ?? 0)

    const claudeLater = send('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'three' })
    expect(claudeLater).toBe(codexWrite)
    const claudeWriteAgain = send('claude', { hook_event_name: 'PostToolUse', tool_name: 'Write' })
    expect(claudeWriteAgain).toBeGreaterThan(codexWrite ?? 0)
  })
})
