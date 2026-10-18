import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { collectAgentFileActivityWorktreeIds } from '@/lib/agent-file-activity'
import {
  createAgentFileActivityPacer,
  dispatchAgentFileActivityEvent,
  type AgentFileActivityPacer
} from './agent-file-activity-event'

// Why: Explorer and editor consumers have no pacing of their own; git status keeps its 3s floor.
const AGENT_FILE_ACTIVITY_MIN_GAP_MS = 1000

export function observeAgentFileActivity(
  state: Pick<AppState, 'agentStatusByPaneKey'> & {
    tabsByWorktree: Readonly<Record<string, readonly { id: string }[]>>
  },
  previous: Pick<AppState, 'agentStatusByPaneKey'>,
  pacer: Pick<AgentFileActivityPacer, 'signal'>
): void {
  if (state.agentStatusByPaneKey === previous.agentStatusByPaneKey) {
    return
  }
  const worktreeIds = collectAgentFileActivityWorktreeIds(
    previous.agentStatusByPaneKey,
    state.agentStatusByPaneKey,
    () => {
      const worktreeIdByTabId = new Map<string, string>()
      for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
        for (const tab of tabs) {
          worktreeIdByTabId.set(tab.id, worktreeId)
        }
      }
      return worktreeIdByTabId
    }
  )
  for (const worktreeId of worktreeIds) {
    pacer.signal(worktreeId)
  }
}

/** Turns host-reported agent tool completions and turn ends into per-worktree refresh nudges. */
export function useAgentFileActivitySignal(): void {
  useEffect(() => {
    const pacer = createAgentFileActivityPacer(
      dispatchAgentFileActivityEvent,
      AGENT_FILE_ACTIVITY_MIN_GAP_MS
    )
    const unsubscribe = useAppStore.subscribe((state, previous) =>
      observeAgentFileActivity(state, previous, pacer)
    )
    return () => {
      unsubscribe()
      pacer.dispose()
    }
  }, [])
}
