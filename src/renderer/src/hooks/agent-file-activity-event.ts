export const ORCA_AGENT_FILE_ACTIVITY_EVENT = 'orca:agent-file-activity'

export type AgentFileActivityEventDetail = {
  worktreeId: string
}

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- WindowEventMap requires declaration merging.
  interface WindowEventMap {
    'orca:agent-file-activity': CustomEvent<AgentFileActivityEventDetail>
  }
}

// Why: agent-status rows land in the store; a window event lets git, Explorer and
// editor consumers react without each subscribing to and diffing the status map.
export function dispatchAgentFileActivityEvent(worktreeId: string): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') {
    return
  }
  window.dispatchEvent(
    new CustomEvent<AgentFileActivityEventDetail>(ORCA_AGENT_FILE_ACTIVITY_EVENT, {
      detail: { worktreeId }
    })
  )
}

export type AgentFileActivityPacer = {
  signal: (worktreeId: string) => void
  dispose: () => void
}

/** Leading-edge emit per worktree, then at most one trailing emit per `minGapMs`. */
export function createAgentFileActivityPacer(
  emit: (worktreeId: string) => void,
  minGapMs: number
): AgentFileActivityPacer {
  const windows = new Map<string, { timer: ReturnType<typeof setTimeout>; pending: boolean }>()
  const openWindow = (worktreeId: string): void => {
    const timer = setTimeout(() => {
      const current = windows.get(worktreeId)
      windows.delete(worktreeId)
      if (current?.pending) {
        emit(worktreeId)
        openWindow(worktreeId)
      }
    }, minGapMs)
    windows.set(worktreeId, { timer, pending: false })
  }
  return {
    signal: (worktreeId) => {
      const current = windows.get(worktreeId)
      if (current) {
        current.pending = true
        return
      }
      emit(worktreeId)
      openWindow(worktreeId)
    },
    dispose: () => {
      for (const { timer } of windows.values()) {
        clearTimeout(timer)
      }
      windows.clear()
    }
  }
}
