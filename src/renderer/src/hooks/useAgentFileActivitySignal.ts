import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { isWindowVisible } from '@/lib/window-visibility-interval'
import type { AgentFileActivityKind } from '../../../shared/agent-status-types'
import { resolveAgentStatusWorktreeId } from '../../../shared/agent-status-worktree-attribution'
import {
  createAgentFileActivityPacer,
  dispatchAgentFileActivityEvent,
  type AgentFileActivityPacer
} from './agent-file-activity-event'

// Why: Explorer and editor re-reads have no pacing of their own (git status keeps its 3s floor);
// most shell calls only read, so they wait as long as git status does.
const EDIT_MIN_GAP_MS = 1000
const COMMAND_MIN_GAP_MS = 3000

function minGapForKind(kind: AgentFileActivityKind | undefined): number {
  return kind === 'command' ? COMMAND_MIN_GAP_MS : EDIT_MIN_GAP_MS
}

type TabsByWorktree = Readonly<Record<string, readonly { id: string }[]>>

function indexWorktreeIdByTabId(tabsByWorktree: TabsByWorktree): Map<string, string> {
  const worktreeIdByTabId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    for (const tab of tabs) {
      worktreeIdByTabId.set(tab.id, worktreeId)
    }
  }
  return worktreeIdByTabId
}

export type AgentFileActivityObserver = {
  observe: (
    state: Pick<AppState, 'agentStatusByPaneKey'> & { tabsByWorktree: TabsByWorktree },
    previous: Pick<AppState, 'agentStatusByPaneKey'>
  ) => void
  /** Replays activity that arrived while the window was hidden. */
  flushHidden: () => void
}

/** Turns new host file-activity stamps into paced per-worktree signals. The host decides what counts. */
export function createAgentFileActivityObserver(
  pacer: Pick<AgentFileActivityPacer, 'signal'>,
  isVisible: () => boolean = isWindowVisible
): AgentFileActivityObserver {
  // Why: some writers (mirrored restored/title rows) omit the stamp; only a stamp newer than the
  // pane's last known one is activity, so a drop-and-restore never reads as a change.
  const lastStampByPaneKey = new Map<string, number>()
  const hiddenGapByWorktreeId = new Map<string, number>()
  const signal = (worktreeId: string, gapMs: number): void => {
    if (isVisible()) {
      pacer.signal(worktreeId, gapMs)
      return
    }
    hiddenGapByWorktreeId.set(
      worktreeId,
      Math.min(hiddenGapByWorktreeId.get(worktreeId) ?? gapMs, gapMs)
    )
  }
  return {
    observe: (state, previous) => {
      const next = state.agentStatusByPaneKey
      if (next === previous.agentStatusByPaneKey) {
        return
      }
      for (const paneKey of lastStampByPaneKey.keys()) {
        if (!Object.hasOwn(next, paneKey)) {
          lastStampByPaneKey.delete(paneKey)
        }
      }
      let worktreeIdByTabId: Map<string, string> | undefined
      for (const [paneKey, entry] of Object.entries(next)) {
        const stamp = entry.fileActivityAt
        if (stamp === undefined) {
          continue
        }
        const previousEntry = Object.hasOwn(previous.agentStatusByPaneKey, paneKey)
          ? previous.agentStatusByPaneKey[paneKey]
          : undefined
        const known = lastStampByPaneKey.get(paneKey) ?? previousEntry?.fileActivityAt
        if (known !== undefined && stamp <= known) {
          continue
        }
        lastStampByPaneKey.set(paneKey, stamp)
        // Why: a pane first seen with a stamp (startup snapshot) carries old activity.
        if (!previousEntry && known === undefined) {
          continue
        }
        worktreeIdByTabId ??= indexWorktreeIdByTabId(state.tabsByWorktree)
        const worktreeId = resolveAgentStatusWorktreeId(entry, worktreeIdByTabId)
        if (worktreeId) {
          signal(worktreeId, minGapForKind(entry.fileActivityKind))
        }
      }
    },
    flushHidden: () => {
      if (!isVisible()) {
        return
      }
      for (const [worktreeId, gapMs] of hiddenGapByWorktreeId) {
        pacer.signal(worktreeId, gapMs)
      }
      hiddenGapByWorktreeId.clear()
    }
  }
}

/** Turns host-stamped agent file activity into per-worktree refresh nudges. */
export function useAgentFileActivitySignal(): void {
  useEffect(() => {
    const pacer = createAgentFileActivityPacer(dispatchAgentFileActivityEvent)
    const observer = createAgentFileActivityObserver(pacer)
    const unsubscribe = useAppStore.subscribe(observer.observe)
    // Why: hidden windows skip Explorer/editor reads; reveal replays what they missed.
    document.addEventListener('visibilitychange', observer.flushHidden)
    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', observer.flushHidden)
      pacer.dispose()
    }
  }, [])
}
