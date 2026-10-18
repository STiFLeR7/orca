import { beforeEach, describe, expect, it, vi } from 'vitest'

type StoreFile = {
  id: string
  worktreeId: string
  worktreePath: string
  relativePath: string
  mode: 'edit'
  isDirty: boolean
  externalMutation?: 'deleted'
}

const store = vi.hoisted(() => {
  const state: { openFiles: StoreFile[]; setExternalMutation: (...args: unknown[]) => void } = {
    openFiles: [],
    setExternalMutation: () => {}
  }
  return state
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))

import { collectAgentActivityEditorReloadTargets } from './editor-external-watch-event-reconciliation'

function file(overrides: Partial<StoreFile> & Pick<StoreFile, 'id'>): StoreFile {
  return {
    worktreeId: 'wt-1',
    worktreePath: '/repo',
    relativePath: `${overrides.id}.ts`,
    mode: 'edit',
    isDirty: false,
    ...overrides
  }
}

describe('collectAgentActivityEditorReloadTargets', () => {
  beforeEach(() => {
    store.setExternalMutation = vi.fn()
  })

  it('re-reads clean tabs of the worktree but leaves tombstoned and dirty tabs alone', () => {
    store.openFiles = [
      file({ id: 'deleted', externalMutation: 'deleted' }),
      file({ id: 'dirty', isDirty: true }),
      file({ id: 'clean' }),
      file({ id: 'other', worktreeId: 'wt-2', worktreePath: '/other' })
    ]

    expect(
      collectAgentActivityEditorReloadTargets({ worktreeId: 'wt-1', worktreePath: '/repo' })
    ).toEqual([
      {
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        relativePath: 'clean.ts',
        runtimeEnvironmentId: null
      }
    ])
    expect(store.setExternalMutation).not.toHaveBeenCalled()
  })
})
