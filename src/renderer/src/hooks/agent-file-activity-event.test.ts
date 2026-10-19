import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { createAgentFileActivityPacer } from './agent-file-activity-event'
import { createAgentFileActivityObserver } from './useAgentFileActivitySignal'

describe('createAgentFileActivityPacer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits immediately, then coalesces a burst into one trailing emit', () => {
    const emit = vi.fn()
    const pacer = createAgentFileActivityPacer(emit)

    pacer.signal('wt-1', 1000)
    expect(emit).toHaveBeenCalledTimes(1)
    pacer.signal('wt-1', 1000)
    pacer.signal('wt-1', 1000)
    expect(emit).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1000)
    expect(emit).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1000)
    expect(emit).toHaveBeenCalledTimes(2)

    pacer.signal('wt-1', 1000)
    expect(emit).toHaveBeenCalledTimes(3)
  })

  it('holds shell-only activity to its longer gap but lets an edit through sooner', () => {
    const emit = vi.fn()
    const pacer = createAgentFileActivityPacer(emit)
    pacer.signal('wt-1', 3000)
    pacer.signal('wt-1', 3000)
    vi.advanceTimersByTime(2000)
    expect(emit).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(emit).toHaveBeenCalledTimes(2)

    pacer.signal('wt-1', 3000)
    vi.advanceTimersByTime(500)
    pacer.signal('wt-1', 1000)
    vi.advanceTimersByTime(499)
    expect(emit).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1)
    expect(emit).toHaveBeenCalledTimes(3)
  })

  it('paces each worktree independently', () => {
    const emit = vi.fn()
    const pacer = createAgentFileActivityPacer(emit)
    pacer.signal('wt-1', 1000)
    pacer.signal('wt-2', 1000)
    expect(emit.mock.calls).toEqual([['wt-1'], ['wt-2']])
  })

  it('drops pending trailing emits on dispose', () => {
    const emit = vi.fn()
    const pacer = createAgentFileActivityPacer(emit)
    pacer.signal('wt-1', 1000)
    pacer.signal('wt-1', 1000)
    pacer.dispose()
    vi.advanceTimersByTime(5000)
    expect(emit).toHaveBeenCalledTimes(1)
  })
})

describe('createAgentFileActivityObserver', () => {
  const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
  const tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
  function row(overrides: Partial<AgentStatusEntry>): AgentStatusEntry {
    return {
      state: 'working',
      prompt: '',
      updatedAt: 1,
      stateStartedAt: 1,
      paneKey: PANE,
      stateHistory: [],
      ...overrides
    }
  }

  it('signals when the host stamps new file activity', () => {
    const signal = vi.fn()
    createAgentFileActivityObserver({ signal }, () => true).observe(
      {
        agentStatusByPaneKey: { [PANE]: row({ updatedAt: 2, fileActivityAt: 20 }) },
        tabsByWorktree
      },
      { agentStatusByPaneKey: { [PANE]: row({ fileActivityAt: 10 }) } }
    )
    expect(signal).toHaveBeenCalledExactlyOnceWith('wt-1', 1000)
  })

  it('ignores re-sent rows that keep the same stamp, whatever their tool name', () => {
    const signal = vi.fn()
    createAgentFileActivityObserver({ signal }, () => true).observe(
      {
        agentStatusByPaneKey: {
          [PANE]: row({ updatedAt: 3, toolName: 'Bash', fileActivityAt: 10 })
        },
        tabsByWorktree
      },
      {
        agentStatusByPaneKey: {
          [PANE]: row({ updatedAt: 2, toolName: 'Bash', fileActivityAt: 10 })
        }
      }
    )
    expect(signal).not.toHaveBeenCalled()
  })

  it('still signals when a batch folds the write into a later waiting row', () => {
    const signal = vi.fn()
    createAgentFileActivityObserver({ signal }, () => true).observe(
      {
        agentStatusByPaneKey: {
          [PANE]: row({
            state: 'waiting',
            updatedAt: 5,
            toolName: 'AskUserQuestion',
            fileActivityAt: 4
          })
        },
        tabsByWorktree
      },
      { agentStatusByPaneKey: { [PANE]: row({ toolName: 'Read' }) } }
    )
    expect(signal).toHaveBeenCalledExactlyOnceWith('wt-1', 1000)
  })

  it('skips panes first seen with a stamp', () => {
    const signal = vi.fn()
    createAgentFileActivityObserver({ signal }, () => true).observe(
      { agentStatusByPaneKey: { [PANE]: row({ fileActivityAt: 10 }) }, tabsByWorktree },
      { agentStatusByPaneKey: {} }
    )
    expect(signal).not.toHaveBeenCalled()
  })

  it('holds activity while hidden and replays it once on reveal', () => {
    const signal = vi.fn()
    let visible = false
    const observer = createAgentFileActivityObserver({ signal }, () => visible)
    observer.observe(
      {
        agentStatusByPaneKey: { [PANE]: row({ updatedAt: 2, fileActivityAt: 20 }) },
        tabsByWorktree
      },
      { agentStatusByPaneKey: { [PANE]: row({}) } }
    )
    observer.flushHidden()
    expect(signal).not.toHaveBeenCalled()
    visible = true
    observer.flushHidden()
    observer.flushHidden()
    expect(signal).toHaveBeenCalledExactlyOnceWith('wt-1', 1000)
  })

  it('paces shell-only activity at the slower gap', () => {
    const signal = vi.fn()
    createAgentFileActivityObserver({ signal }, () => true).observe(
      {
        agentStatusByPaneKey: {
          [PANE]: row({ updatedAt: 2, fileActivityAt: 20, fileActivityKind: 'command' })
        },
        tabsByWorktree
      },
      { agentStatusByPaneKey: { [PANE]: row({}) } }
    )
    expect(signal).toHaveBeenCalledExactlyOnceWith('wt-1', 3000)
  })

  it('does not read a mirrored row that drops the stamp, then restores it, as new activity', () => {
    const signal = vi.fn()
    const observer = createAgentFileActivityObserver({ signal }, () => true)
    const stamped = { [PANE]: row({ updatedAt: 2, fileActivityAt: 20 }) }
    const unstamped = { [PANE]: row({ updatedAt: 3 }) }
    const restamped = { [PANE]: row({ updatedAt: 4, fileActivityAt: 20 }) }
    observer.observe(
      { agentStatusByPaneKey: stamped, tabsByWorktree },
      { agentStatusByPaneKey: { [PANE]: row({}) } }
    )
    observer.observe(
      { agentStatusByPaneKey: unstamped, tabsByWorktree },
      { agentStatusByPaneKey: stamped }
    )
    observer.observe(
      { agentStatusByPaneKey: restamped, tabsByWorktree },
      { agentStatusByPaneKey: unstamped }
    )
    expect(signal).toHaveBeenCalledTimes(1)
  })
})
