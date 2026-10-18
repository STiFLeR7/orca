import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import {
  collectAgentFileActivityWorktreeIds,
  isAgentFileActivityTransition,
  isFileMutatingAgentTool
} from './agent-file-activity'

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

describe('isFileMutatingAgentTool', () => {
  it('matches write and shell tools across agent naming styles', () => {
    for (const name of ['Edit', 'Write', 'MultiEdit', 'Bash', 'apply_patch', 'write_file']) {
      expect(isFileMutatingAgentTool(name)).toBe(true)
    }
    for (const name of ['search_replace', 'run_terminal_command', 'Execute', 'Shell', 'edit']) {
      expect(isFileMutatingAgentTool(name)).toBe(true)
    }
  })

  it('ignores read-only tools and missing names', () => {
    for (const name of ['Read', 'Grep', 'Glob', 'WebFetch', 'TodoWrite', 'view', undefined]) {
      expect(isFileMutatingAgentTool(name)).toBe(false)
    }
  })
})

describe('isAgentFileActivityTransition', () => {
  it('fires once a mutating tool row is followed by a newer row', () => {
    const editStart = row({ toolName: 'Edit', updatedAt: 10 })
    expect(isAgentFileActivityTransition(editStart, row({ toolName: 'Edit', updatedAt: 11 }))).toBe(
      true
    )
    expect(isAgentFileActivityTransition(editStart, row({ toolName: 'Read', updatedAt: 11 }))).toBe(
      true
    )
  })

  it('does not fire when a mutating tool merely starts', () => {
    expect(
      isAgentFileActivityTransition(
        row({ toolName: 'Read', updatedAt: 10 }),
        row({ toolName: 'Edit', updatedAt: 11 })
      )
    ).toBe(false)
  })

  it('fires when a turn ends, but not on session boundaries', () => {
    const working = row({ updatedAt: 10 })
    expect(isAgentFileActivityTransition(working, row({ state: 'done', updatedAt: 11 }))).toBe(true)
    expect(
      isAgentFileActivityTransition(
        working,
        row({ state: 'done', updatedAt: 11, sessionBoundary: true })
      )
    ).toBe(false)
    expect(
      isAgentFileActivityTransition(
        row({ state: 'done', updatedAt: 10 }),
        row({ state: 'done', updatedAt: 11 })
      )
    ).toBe(false)
  })

  it('ignores new panes and rewrites that do not advance the update clock', () => {
    expect(isAgentFileActivityTransition(undefined, row({ state: 'done', updatedAt: 11 }))).toBe(
      false
    )
    const editStart = row({ toolName: 'Edit', updatedAt: 10 })
    expect(isAgentFileActivityTransition(editStart, { ...editStart })).toBe(false)
  })
})

describe('collectAgentFileActivityWorktreeIds', () => {
  it('attributes changed panes through their tab and the host-stamped worktree', () => {
    const previous = {
      'tab-1:11111111-1111-4111-8111-111111111111': row({
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        toolName: 'Bash',
        updatedAt: 10
      }),
      'tab-2:11111111-1111-4111-8111-111111111111': row({
        paneKey: 'tab-2:11111111-1111-4111-8111-111111111111',
        updatedAt: 10,
        worktreeId: 'wt-ssh',
        connectionId: 'conn-1'
      }),
      'tab-3:11111111-1111-4111-8111-111111111111': row({
        paneKey: 'tab-3:11111111-1111-4111-8111-111111111111',
        toolName: 'Edit',
        updatedAt: 10
      })
    }
    const next = {
      'tab-1:11111111-1111-4111-8111-111111111111': row({
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        updatedAt: 11
      }),
      'tab-2:11111111-1111-4111-8111-111111111111': row({
        paneKey: 'tab-2:11111111-1111-4111-8111-111111111111',
        state: 'done',
        updatedAt: 11,
        worktreeId: 'wt-ssh',
        connectionId: 'conn-1'
      }),
      // Unchanged identity: an unrelated publication must not refresh tab-3's worktree.
      'tab-3:11111111-1111-4111-8111-111111111111':
        previous['tab-3:11111111-1111-4111-8111-111111111111']
    }
    let lookups = 0
    const ids = collectAgentFileActivityWorktreeIds(previous, next, () => {
      lookups += 1
      return new Map([
        ['tab-1', 'wt-local'],
        ['tab-3', 'wt-other']
      ])
    })
    expect([...ids].sort()).toEqual(['wt-local', 'wt-ssh'])
    expect(lookups).toBe(1)
  })

  it('skips the tab lookup when nothing qualifies', () => {
    const entry = row({ updatedAt: 10 })
    const ids = collectAgentFileActivityWorktreeIds(
      { 'tab-1:11111111-1111-4111-8111-111111111111': entry },
      { 'tab-1:11111111-1111-4111-8111-111111111111': row({ updatedAt: 11 }) },
      () => {
        throw new Error('lookup should be lazy')
      }
    )
    expect(ids.size).toBe(0)
  })
})
