// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileExplorerOperationOwner } from './file-explorer-types'
import type { InlineInput } from './file-explorer-inline-input-row'
import { dispatchAgentFileActivityEvent } from '@/hooks/agent-file-activity-event'
import { useFileExplorerWatch } from './useFileExplorerWatch'

const owner = vi.hoisted((): { current: FileExplorerOperationOwner } => ({
  current: { kind: 'local' }
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector({}), {
    getState: () => ({})
  })
}))
vi.mock('./file-explorer-operation-owner', () => ({
  getFileExplorerOperationOwner: () => owner.current,
  getFileExplorerOperationOwnerFromState: () => owner.current
}))

const refreshDir = vi.fn(async () => {})
const refreshTree = vi.fn(async () => 'refreshed' as const)
function renderWatch(inlineInput: InlineInput | null = null) {
  return renderHook(
    ({ input }: { input: InlineInput | null }) =>
      useFileExplorerWatch({
        worktreePath: '/repo',
        activeWorktreeId: 'wt',
        dirCache: { '/repo': { children: [] } },
        setDirCache: vi.fn(),
        expanded: new Set(['/repo/src']),
        setSelectedPath: vi.fn(),
        refreshDir,
        refreshTree,
        inlineInput: input,
        dragSourcePath: null,
        isNativeDragOver: false
      }),
    { initialProps: { input: inlineInput } }
  )
}
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  owner.current = { kind: 'local' }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { fs: { onFsChanged: vi.fn(() => vi.fn()) } }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('file explorer agent activity refresh', () => {
  it('rereads the tree when an agent edits the shown worktree', async () => {
    renderWatch()
    act(() => dispatchAgentFileActivityEvent('wt-other'))
    await settle()
    expect(refreshTree).not.toHaveBeenCalled()

    act(() => dispatchAgentFileActivityEvent('wt'))
    await settle()
    expect(refreshTree).toHaveBeenCalledOnce()
  })

  it('also refreshes runtime-hosted worktrees', async () => {
    owner.current = { kind: 'runtime', environmentId: 'host-a', executionHostId: 'runtime:host-a' }
    renderWatch()
    act(() => dispatchAgentFileActivityEvent('wt'))
    await settle()
    expect(refreshTree).toHaveBeenCalledOnce()
  })

  it('spaces remote rereads at least 3s apart but keeps local ones immediate', async () => {
    renderWatch()
    act(() => dispatchAgentFileActivityEvent('wt'))
    await settle()
    act(() => dispatchAgentFileActivityEvent('wt'))
    await settle()
    expect(refreshTree).toHaveBeenCalledTimes(2)
    cleanup()
    refreshTree.mockClear()

    owner.current = { kind: 'ssh', connectionId: 'conn-1' }
    renderWatch()
    act(() => dispatchAgentFileActivityEvent('wt'))
    await settle()
    act(() => dispatchAgentFileActivityEvent('wt'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_999)
    })
    expect(refreshTree).toHaveBeenCalledOnce()
    // The paced reread lands at 3s; the tree scheduler then needs a few more turns to run it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(refreshTree).toHaveBeenCalledTimes(2)
  })

  it('defers the refresh while an inline rename is open', async () => {
    const hook = renderWatch({ parentPath: '/repo', type: 'file', depth: 0 })
    act(() => dispatchAgentFileActivityEvent('wt'))
    await settle()
    expect(refreshTree).not.toHaveBeenCalled()

    hook.rerender({ input: null })
    await settle()
    expect(refreshTree).toHaveBeenCalledOnce()
  })

  it('stops listening on unmount', async () => {
    const hook = renderWatch()
    hook.unmount()
    act(() => dispatchAgentFileActivityEvent('wt'))
    await settle()
    expect(refreshTree).not.toHaveBeenCalled()
  })
})
