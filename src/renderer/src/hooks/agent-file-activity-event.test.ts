import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { createAgentFileActivityPacer } from './agent-file-activity-event'
import { observeAgentFileActivity } from './useAgentFileActivitySignal'

describe('createAgentFileActivityPacer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits immediately, then coalesces a burst into one trailing emit', () => {
    const emit = vi.fn()
    const pacer = createAgentFileActivityPacer(emit, 1000)

    pacer.signal('wt-1')
    expect(emit).toHaveBeenCalledTimes(1)
    pacer.signal('wt-1')
    pacer.signal('wt-1')
    expect(emit).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1000)
    expect(emit).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1000)
    expect(emit).toHaveBeenCalledTimes(2)

    pacer.signal('wt-1')
    expect(emit).toHaveBeenCalledTimes(3)
  })

  it('paces each worktree independently', () => {
    const emit = vi.fn()
    const pacer = createAgentFileActivityPacer(emit, 1000)
    pacer.signal('wt-1')
    pacer.signal('wt-2')
    expect(emit.mock.calls).toEqual([['wt-1'], ['wt-2']])
  })

  it('drops pending trailing emits on dispose', () => {
    const emit = vi.fn()
    const pacer = createAgentFileActivityPacer(emit, 1000)
    pacer.signal('wt-1')
    pacer.signal('wt-1')
    pacer.dispose()
    vi.advanceTimersByTime(5000)
    expect(emit).toHaveBeenCalledTimes(1)
  })
})

describe('observeAgentFileActivity', () => {
  function row(overrides: Partial<AgentStatusEntry>): AgentStatusEntry {
    return {
      state: 'working',
      prompt: '',
      updatedAt: 1,
      stateStartedAt: 1,
      paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
      stateHistory: [],
      ...overrides
    }
  }

  it('signals the worktree that owns the agent tab', () => {
    const signal = vi.fn()
    observeAgentFileActivity(
      {
        agentStatusByPaneKey: {
          'tab-1:11111111-1111-4111-8111-111111111111': row({ updatedAt: 2 })
        },
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] }
      },
      {
        agentStatusByPaneKey: {
          'tab-1:11111111-1111-4111-8111-111111111111': row({ toolName: 'Write' })
        }
      },
      { signal }
    )
    expect(signal).toHaveBeenCalledWith('wt-1')
  })

  it('does nothing when the status map is unchanged', () => {
    const signal = vi.fn()
    const agentStatusByPaneKey = {
      'tab-1:11111111-1111-4111-8111-111111111111': row({ toolName: 'Write' })
    }
    observeAgentFileActivity(
      { agentStatusByPaneKey, tabsByWorktree: {} },
      { agentStatusByPaneKey },
      { signal }
    )
    expect(signal).not.toHaveBeenCalled()
  })
})
