import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const holder = vi.hoisted(() => {
  const state: { store: { getState: () => unknown } | null } = { store: null }
  return state
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => holder.store?.getState() } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))

import { attachEditorAutosaveController } from '@/components/editor/editor-autosave-controller'
import {
  createEditorStore,
  createFakeEditorDisk,
  stubEditorWindowWithDisk
} from '@/components/editor/editor-autosave-controller-test-fixture'
import { getDiskBaselineSignature } from '@/components/editor/diff-content-signature'
import { __clearSelfWriteRegistryForTests } from '@/components/editor/editor-self-write-registry'
import { buildEditorExternalWatchEventHandler } from './editor-external-watch-event-reconciliation'

const FILE = '/repo/a.ts'

describe('editing a stale tab right after its workspace is watched again', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    __clearSelfWriteRegistryForTests()
    holder.store = null
  })

  it('refuses the autosave and shows changed-on-disk instead of overwriting the newer file', async () => {
    // Why: the tab loaded v1, then an agent wrote v2 while the workspace was unwatched.
    const disk = stubEditorWindowWithDisk(createFakeEditorDisk({ [FILE]: 'v2 agent write' }))
    const store = createEditorStore()
    holder.store = store
    store.getState().openFile({
      filePath: FILE,
      relativePath: 'a.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().setLastKnownDiskSignature(FILE, getDiskBaselineSignature('v1'))
    const detach = attachEditorAutosaveController(store)
    try {
      // Switched back; the catch-up has not landed yet when the user types.
      store.getState().setEditorDraft(FILE, 'typed on stale v1')
      store.getState().markFileDirty(FILE, true)
      await vi.advanceTimersByTimeAsync(1500)

      const file = store.getState().openFiles.find((f) => f.id === FILE)
      expect(disk.files.get(FILE)).toBe('v2 agent write')
      expect(file?.externalMutation).toBe('changed')
      expect(file?.isDirty).toBe(true)

      // The late re-watch resync (an overflow, as on reconnect) leaves the dirty tab and its banner alone.
      const { handleFsChanged, dispose } = buildEditorExternalWatchEventHandler(() => ({
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        connectionId: undefined,
        runtimeEnvironmentId: null
      }))
      handleFsChanged({
        worktreePath: '/repo',
        events: [{ kind: 'overflow', absolutePath: '/repo' }]
      })
      dispose()
      await vi.advanceTimersByTimeAsync(500)
      expect(store.getState().openFiles.find((f) => f.id === FILE)?.externalMutation).toBe(
        'changed'
      )
      expect(store.getState().editorDrafts[FILE]).toBe('typed on stale v1')
      expect(disk.files.get(FILE)).toBe('v2 agent write')
    } finally {
      detach()
    }
  })
})
