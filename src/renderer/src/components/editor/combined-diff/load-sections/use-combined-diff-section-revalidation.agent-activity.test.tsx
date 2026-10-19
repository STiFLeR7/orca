// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { dispatchAgentFileActivityEvent } from '@/hooks/agent-file-activity-event'
import {
  notifyEditorExternalFileChange,
  type EditorPathMutationTarget
} from '../../editor-autosave'
import type { CombinedDiffFileTreeMode } from '../resolve-changes/combined-diff-section-identity'
import { getCombinedDiffFileTreeSectionKey } from '../resolve-changes/combined-diff-section-identity'
import { useCombinedDiffSectionLoadRegistry } from './combined-diff-section-load-registry'
import { useCombinedDiffSectionRevalidation } from './use-combined-diff-section-revalidation'
import { combinedDiffViewStateCache } from '../remember-view/combined-diff-view-memory'

const combinedFile: OpenFile = {
  id: 'combined',
  filePath: '/repo',
  relativePath: '',
  worktreeId: 'wt-1',
  language: 'plaintext',
  isDirty: false,
  mode: 'diff'
}

function renderRevalidation(treeMode: CombinedDiffFileTreeMode) {
  const requestSectionReload = vi.fn()
  const sectionKey = getCombinedDiffFileTreeSectionKey('uncommitted', {
    path: 'a.ts',
    status: 'modified',
    area: 'unstaged'
  })
  renderHook(() => {
    const registry = useCombinedDiffSectionLoadRegistry([])
    registry.loadedIndicesRef.current = new Set([0, 2])
    return useCombinedDiffSectionRevalidation({
      file: combinedFile,
      gitStatusEntries: [],
      registry,
      requestSectionReload,
      sectionIndexByKeyRef: { current: new Map([[sectionKey, 0]]) },
      sectionEntries: [],
      shouldAutoReloadFromGitStatus: false,
      treeMode
    })
  })
  return requestSectionReload
}

afterEach(() => {
  cleanup()
})

describe('combined diff agent activity', () => {
  it('re-reads loaded sections when an agent may have changed the worktree', () => {
    const requestSectionReload = renderRevalidation('uncommitted')
    act(() => dispatchAgentFileActivityEvent('wt-other'))
    expect(requestSectionReload).not.toHaveBeenCalled()
    act(() => dispatchAgentFileActivityEvent('wt-1'))
    expect(requestSectionReload.mock.calls).toEqual([[0], [2]])
  })

  it('ignores a re-read scoped to another tab of the same path', () => {
    const requestSectionReload = renderRevalidation('all')
    const target: EditorPathMutationTarget = {
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      relativePath: 'a.ts',
      fileIds: ['editor-a']
    }
    act(() => notifyEditorExternalFileChange(target))
    expect(requestSectionReload).not.toHaveBeenCalled()
    act(() => notifyEditorExternalFileChange({ ...target, fileIds: undefined }))
    expect(requestSectionReload).toHaveBeenCalledWith(0)
  })

  it('keeps remembered combined views when the re-read is only a scoped nudge', () => {
    const cached = {
      entrySignature: '',
      gitStatusSignature: '',
      sections: [],
      sectionHeights: {},
      loadedIndices: [],
      scrollTop: 0,
      sideBySide: false
    }
    combinedDiffViewStateCache.set('view', {
      ...cached,
      sections: [
        {
          key: 'a',
          path: 'a.ts',
          status: 'modified',
          originalContent: '',
          modifiedContent: '',
          collapsed: false,
          loading: false,
          dirty: false,
          diffResult: null,
          largeDiffRenderLimit: null
        }
      ]
    })
    const target = { worktreeId: 'wt-1', worktreePath: '/repo', relativePath: 'a.ts' }
    notifyEditorExternalFileChange({ ...target, fileIds: ['editor-a'] })
    expect(combinedDiffViewStateCache.has('view')).toBe(true)
    notifyEditorExternalFileChange(target)
    expect(combinedDiffViewStateCache.has('view')).toBe(false)
  })
})
