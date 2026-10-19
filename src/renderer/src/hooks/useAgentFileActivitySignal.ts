import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { isWindowVisible } from '@/lib/window-visibility-interval'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { resolveAgentStatusWorktreeId } from '../../../shared/agent-status-worktree-attribution'
import {
  createAgentFileActivityPacer,
  dispatchAgentFileActivityEvent,
  type AgentFileActivityPacer
} from './agent-file-activity-event'

// Why: Explorer and editor consumers have no pacing of their own; git status keeps its 3s floor.
const AGENT_FILE_ACTIVITY_MIN_GAP_MS = 1000

type TabsByWorktree = Readonly<Record<string, readonly { id: string }[]>>

/** Worktrees whose panes report a new host file-activity stamp. The host decides what counts. */
export function collectAgentFileActivityWorktreeIds(
  previous: Readonly<Record<string, AgentStatusEntry>>,
  next: Readonly<Record<string, AgentStatusEntry>>,
  tabsByWorktree: TabsByWorktree
): Set<string> {
  const worktreeIds = new Set<string>()
  let worktreeIdByTabId: Map<string, string> | undefined
  for (const [paneKey, entry] of Object.entries(next)) {
    const previousEntry = Object.hasOwn(previous, paneKey) ? previous[paneKey] : undefined
    // Why require a previous row: a pane first seen (startup snapshot) carries old activity.
    if (
      !previousEntry ||
      entry.fileActivityAt === undefined ||
      entry.fileActivityAt === previousEntry.fileActivityAt
    ) {
      continue
    }
    worktreeIdByTabId ??= indexWorktreeIdByTabId(tabsByWorktree)
    const worktreeId = resolveAgentStatusWorktreeId(entry, worktreeIdByTabId)
    if (worktreeId) {
      worktreeIds.add(worktreeId)
    }
  }
  return worktreeIds
}

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

export function createAgentFileActivityObserver(
  pacer: Pick<AgentFileActivityPacer, 'signal'>,
  isVisible: () => boolean = isWindowVisible
): AgentFileActivityObserver {
  const hiddenWorktreeIds = new Set<string>()
  return {
    observe: (state, previous) => {
      if (state.agentStatusByPaneKey === previous.agentStatusByPaneKey) {
        return
      }
      const worktreeIds = collectAgentFileActivityWorktreeIds(
        previous.agentStatusByPaneKey,
        state.agentStatusByPaneKey,
        state.tabsByWorktree
      )
      const visible = isVisible()
      for (const worktreeId of worktreeIds) {
        if (visible) {
          pacer.signal(worktreeId)
        } else {
          hiddenWorktreeIds.add(worktreeId)
        }
      }
    },
    flushHidden: () => {
      if (!isVisible()) {
        return
      }
      for (const worktreeId of hiddenWorktreeIds) {
        pacer.signal(worktreeId)
      }
      hiddenWorktreeIds.clear()
    }
  }
}

/** Turns host-stamped agent file activity into per-worktree refresh nudges. */
export function useAgentFileActivitySignal(): void {
  useEffect(() => {
    const pacer = createAgentFileActivityPacer(
      dispatchAgentFileActivityEvent,
      AGENT_FILE_ACTIVITY_MIN_GAP_MS
    )
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
