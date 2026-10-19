import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'

type StoreFile = OpenFile

const store = vi.hoisted(() => {
  const state: { openFiles: StoreFile[] } = { openFiles: [] }
  return state
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))

import { getOpenFilesForExternalFileChange } from '@/components/editor/editor-autosave'
import { collectAgentActivityEditorReloads } from './editor-agent-activity-reload'

function file(
  overrides: Partial<StoreFile> & Pick<StoreFile, 'id'> & { worktreePath?: string }
): StoreFile {
  const { worktreePath = '/repo', ...rest } = overrides
  const relativePath = rest.relativePath ?? `${rest.id}.ts`
  return {
    worktreeId: 'wt-1',
    filePath: `${worktreePath}/${relativePath}`,
    language: 'typescript',
    relativePath,
    mode: 'edit',
    isDirty: false,
    ...rest
  }
}

// Mirrors what every ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT consumer sees at dispatch.
function matchedIds(): string[][] {
  return collectAgentActivityEditorReloads({ worktreeId: 'wt-1', worktreePath: '/repo' }).map(
    (notification) =>
      getOpenFilesForExternalFileChange(store.openFiles, notification).map((match) => match.id)
  )
}

describe('collectAgentActivityEditorReloads', () => {
  beforeEach(() => {
    store.openFiles = []
  })

  it('targets clean tabs of the worktree only, skipping dirty, tombstoned and other worktrees', () => {
    store.openFiles = [
      file({ id: 'deleted', externalMutation: 'deleted' }),
      file({ id: 'dirty', isDirty: true }),
      file({ id: 'clean' }),
      file({ id: 'other', worktreeId: 'wt-2', worktreePath: '/other' })
    ]
    expect(matchedIds()).toEqual([['clean']])
  })

  it('never reaches a dirty editor that shares a path with a clean diff tab', () => {
    store.openFiles = [
      file({ id: 'editor', relativePath: 'a.ts', isDirty: true }),
      file({ id: 'diff', relativePath: 'a.ts', mode: 'diff', diffSource: 'unstaged' })
    ]
    expect(matchedIds()).toEqual([['diff']])
  })

  it('drops a tab that turned dirty between collection and dispatch', () => {
    store.openFiles = [file({ id: 'clean' })]
    const [notification] = collectAgentActivityEditorReloads({
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    })
    store.openFiles = [file({ id: 'clean', isDirty: true })]
    expect(getOpenFilesForExternalFileChange(store.openFiles, notification)).toEqual([])
  })
})
