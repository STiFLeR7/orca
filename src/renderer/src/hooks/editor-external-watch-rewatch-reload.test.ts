import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as EditorAutosave from '@/components/editor/editor-autosave'

const { getState, notify, probeMissing } = vi.hoisted(() => ({
  getState: vi.fn(),
  notify: vi.fn(),
  probeMissing: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState } }))
vi.mock('@/components/editor/editor-autosave', async (importOriginal) => ({
  ...(await importOriginal<typeof EditorAutosave>()),
  notifyEditorExternalFileChange: notify
}))
vi.mock('@/components/editor/editor-restored-tab-conflict-scan', () => ({
  probeEditorTabFileMissing: probeMissing
}))

import {
  catchUpEditorTabsAfterRewatch,
  hasBaselinedEditorTabs
} from './editor-external-watch-rewatch-reload'

const target = {
  worktreeId: 'wt',
  worktreePath: '/repo',
  connectionId: undefined,
  runtimeEnvironmentId: null
}

function tab(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    worktreeId: 'wt',
    filePath: `/repo/${id}`,
    relativePath: id,
    mode: 'edit',
    isDirty: false,
    ...extra
  }
}

const openFiles = [
  tab('dirty.ts', { isDirty: true, lastKnownDiskSignature: 'sig' }),
  tab('clean.ts', { lastKnownDiskSignature: 'sig' }),
  tab('preview.md', { mode: 'markdown-preview' }),
  tab('staged.ts', { mode: 'diff', diffSource: 'staged' }),
  tab('deleted.ts', { externalMutation: 'deleted' }),
  tab('renamed.ts', { externalMutation: 'renamed' }),
  tab('combined', { mode: 'diff', diffSource: 'combined-uncommitted' }),
  tab('checks', { mode: 'check-details' }),
  tab('other.ts', { worktreeId: 'other', lastKnownDiskSignature: 'sig' }),
  tab('runtime.ts', { runtimeEnvironmentId: 'env-1' })
]

describe('refreshing tabs after a dropped watch returns', () => {
  const setExternalMutation = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    probeMissing.mockResolvedValue(false)
    getState.mockReturnValue({ setExternalMutation, openFiles })
  })

  it('reloads clean file tabs but skips dirty, deleted, renamed, combined-diff and virtual tabs', async () => {
    await catchUpEditorTabsAfterRewatch(target)

    expect(notify.mock.calls.map(([call]) => call.relativePath).sort()).toEqual([
      'clean.ts',
      'preview.md',
      'staged.ts'
    ])
    expect(notify).toHaveBeenCalledWith({
      worktreeId: 'wt',
      worktreePath: '/repo',
      relativePath: 'clean.ts',
      runtimeEnvironmentId: null
    })
  })

  it('skips a tab that became dirty before its turn', async () => {
    probeMissing.mockImplementation(async (_state, file) => {
      if (file.id === 'clean.ts') {
        getState.mockReturnValue({
          setExternalMutation,
          openFiles: openFiles.map((f) => (f.id === 'clean.ts' ? { ...f, isDirty: true } : f))
        })
      }
      return false
    })
    await catchUpEditorTabsAfterRewatch(target)

    expect(notify.mock.calls.map(([call]) => call.relativePath)).not.toContain('clean.ts')
  })

  it('probes at most three tabs at a time', async () => {
    getState.mockReturnValue({
      setExternalMutation,
      openFiles: Array.from({ length: 8 }, (_, index) => tab(`f${index}.ts`))
    })
    let inFlight = 0
    let peak = 0
    probeMissing.mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await Promise.resolve()
      inFlight -= 1
      return false
    })

    await catchUpEditorTabsAfterRewatch(target)
    expect(peak).toBe(3)
    expect(notify).toHaveBeenCalledTimes(8)
  })

  it('marks a file removed while unwatched as deleted instead of reloading it', async () => {
    probeMissing.mockImplementation(async (_state, file) => file.id === 'clean.ts')
    await catchUpEditorTabsAfterRewatch(target)

    expect(setExternalMutation).toHaveBeenCalledWith('clean.ts', 'deleted')
    expect(notify.mock.calls.map(([call]) => call.relativePath)).not.toContain('clean.ts')
  })

  it('scopes the refresh to the target host owner', async () => {
    await catchUpEditorTabsAfterRewatch({ ...target, runtimeEnvironmentId: 'env-1' })

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'runtime.ts', runtimeEnvironmentId: 'env-1' })
    )
  })

  it('reports whether a target has previously loaded tabs', () => {
    expect(hasBaselinedEditorTabs(target)).toBe(true)
    expect(hasBaselinedEditorTabs({ ...target, worktreeId: 'none' })).toBe(false)
  })
})
