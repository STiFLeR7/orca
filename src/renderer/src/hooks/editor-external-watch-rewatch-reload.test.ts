import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as EditorAutosave from '@/components/editor/editor-autosave'

const { getState, notify, probePresence, listeners, callRuntimeRpc } = vi.hoisted(() => {
  const storeListeners = new Set<(state: { openFiles: readonly { id?: unknown }[] }) => void>()
  return {
    getState: vi.fn(),
    notify: vi.fn(),
    probePresence: vi.fn(),
    listeners: storeListeners,
    callRuntimeRpc: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState,
    subscribe: (listener: (state: { openFiles: readonly { id?: unknown }[] }) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}))
vi.mock('@/lib/file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: (_state: unknown, _worktreeId: string, owner?: string | null) =>
    owner ? { kind: 'environment', environmentId: owner } : { kind: 'local' }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc }))
vi.mock('@/components/editor/editor-autosave', async (importOriginal) => ({
  ...(await importOriginal<typeof EditorAutosave>()),
  notifyEditorExternalFileChange: notify
}))
vi.mock('@/components/editor/editor-restored-tab-conflict-scan', () => ({
  probeEditorTabFilePresence: probePresence
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
  tab('dirty-deleted.ts', { externalMutation: 'deleted', isDirty: true }),
  tab('changed.ts', { externalMutation: 'changed' }),
  tab('combined', { mode: 'diff', diffSource: 'combined-uncommitted' }),
  tab('checks', { mode: 'check-details' }),
  tab('other.ts', { worktreeId: 'other', lastKnownDiskSignature: 'sig' }),
  tab('runtime.ts', { runtimeEnvironmentId: 'env-1' })
]

describe('refreshing tabs after a dropped watch returns', () => {
  const setExternalMutation = vi.fn()
  const dispatchEvent = vi.fn()
  const notified = (): string[] => notify.mock.calls.map(([call]) => call.relativePath).sort()

  beforeEach(() => {
    vi.clearAllMocks()
    setExternalMutation.mockReset()
    vi.stubGlobal('window', { dispatchEvent })
    probePresence.mockResolvedValue('unknown')
    getState.mockReturnValue({ setExternalMutation, openFiles })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reloads clean file tabs and leaves dirty, marked, combined and virtual tabs alone', async () => {
    await catchUpEditorTabsAfterRewatch(target)

    expect(notified()).toEqual(['clean.ts', 'preview.md', 'staged.ts'])
    expect(notify).toHaveBeenCalledWith({
      worktreeId: 'wt',
      worktreePath: '/repo',
      relativePath: 'clean.ts',
      runtimeEnvironmentId: null
    })
    expect(setExternalMutation).not.toHaveBeenCalled()
  })

  it('nudges workspace listeners once with an overflow for the workspace', async () => {
    await catchUpEditorTabsAfterRewatch(target)

    expect(dispatchEvent).toHaveBeenCalledTimes(1)
    expect(dispatchEvent.mock.calls[0][0].detail).toEqual({
      payload: { worktreePath: '/repo', events: [{ kind: 'overflow', absolutePath: '/repo' }] },
      runtimeEnvironmentId: null
    })
  })

  it('clears a clean tombstone and reloads when the file came back while unwatched', async () => {
    probePresence.mockImplementation(async (_state, file) =>
      file.id === 'deleted.ts' || file.id === 'renamed.ts' ? 'present' : 'unknown'
    )
    await catchUpEditorTabsAfterRewatch(target)

    expect(setExternalMutation).toHaveBeenCalledWith('deleted.ts', null)
    expect(setExternalMutation).toHaveBeenCalledWith('renamed.ts', null)
    expect(setExternalMutation).not.toHaveBeenCalledWith('dirty-deleted.ts', null)
  })

  it('marks a file removed while unwatched as deleted instead of reloading it', async () => {
    probePresence.mockImplementation(async (_state, file) =>
      file.id === 'clean.ts' ? 'missing' : 'unknown'
    )
    await catchUpEditorTabsAfterRewatch(target)

    expect(setExternalMutation).toHaveBeenCalledWith('clean.ts', 'deleted')
    expect(notified()).not.toContain('clean.ts')
  })

  function setOpenFiles(next: Record<string, unknown>[]): void {
    getState.mockReturnValue({ setExternalMutation, openFiles: next })
    for (const listener of listeners) {
      listener({ openFiles: next })
    }
  }

  it('drops a probe verdict once the tab was closed and reopened under the same id', async () => {
    probePresence.mockImplementation(async (_state, file) => {
      if (file.id === 'clean.ts') {
        setOpenFiles(openFiles.filter((f) => f.id !== 'clean.ts'))
        setOpenFiles(openFiles.map((f) => (f.id === 'clean.ts' ? { ...f } : f)))
        return 'missing'
      }
      return 'unknown'
    })
    await catchUpEditorTabsAfterRewatch(target)

    expect(setExternalMutation).not.toHaveBeenCalledWith('clean.ts', 'deleted')
  })

  it('still refreshes a tab whose object was replaced by a benign update during the probe', async () => {
    probePresence.mockImplementation(async (_state, file) => {
      if (file.id === 'clean.ts') {
        // Why: a late content read stamps a new baseline, replacing the tab object.
        setOpenFiles(
          openFiles.map((f) => (f.id === 'clean.ts' ? { ...f, lastKnownDiskSignature: 'new' } : f))
        )
        return 'present'
      }
      return 'unknown'
    })
    await catchUpEditorTabsAfterRewatch(target)

    expect(notified()).toContain('clean.ts')
  })

  it('does not refresh a tab that became dirty during the probe', async () => {
    probePresence.mockImplementation(async (_state, file) => {
      if (file.id === 'clean.ts') {
        setOpenFiles(openFiles.map((f) => (f.id === 'clean.ts' ? { ...f, isDirty: true } : f)))
      }
      return 'present'
    })
    await catchUpEditorTabsAfterRewatch(target)

    expect(notified()).not.toContain('clean.ts')
  })

  it.each([
    ['clears and reloads', () => Promise.resolve({ size: 1, isDirectory: false, mtime: 0 }), true],
    ['keeps the mark when still missing', () => Promise.reject(new Error('ENOENT: gone')), false],
    [
      'keeps the mark when the host is unreachable',
      () => Promise.reject(new Error('timeout')),
      false
    ]
  ])('stats a runtime tombstone on its host: %s', async (_label, stat, cleared) => {
    const runtimeTab = tab('rt.ts', {
      filePath: '/repo/rt.ts',
      runtimeEnvironmentId: 'env-1',
      externalMutation: 'deleted'
    })
    getState.mockReturnValue({ setExternalMutation, openFiles: [runtimeTab] })
    // Why: mirror the store so the cleared mark is visible to the reload's clean check.
    setExternalMutation.mockImplementation((_id: string, mutation: string | null) =>
      getState.mockReturnValue({
        setExternalMutation,
        openFiles: [{ ...runtimeTab, externalMutation: mutation ?? undefined }]
      })
    )
    callRuntimeRpc.mockImplementation(stat)

    await catchUpEditorTabsAfterRewatch({ ...target, runtimeEnvironmentId: 'env-1' })

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'files.stat',
      expect.objectContaining({ relativePath: 'rt.ts' }),
      expect.anything()
    )
    expect(probePresence).not.toHaveBeenCalled()
    if (cleared) {
      expect(setExternalMutation).toHaveBeenCalledWith('rt.ts', null)
      expect(notified()).toEqual(['rt.ts'])
    } else {
      expect(setExternalMutation).not.toHaveBeenCalled()
      expect(notify).not.toHaveBeenCalled()
    }
  })

  it('probes at most three tabs at a time', async () => {
    getState.mockReturnValue({
      setExternalMutation,
      openFiles: Array.from({ length: 8 }, (_, index) => tab(`f${index}.ts`))
    })
    let inFlight = 0
    let peak = 0
    probePresence.mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await Promise.resolve()
      inFlight -= 1
      return 'present'
    })

    await catchUpEditorTabsAfterRewatch(target)
    expect(peak).toBe(3)
    expect(notify).toHaveBeenCalledTimes(8)
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
