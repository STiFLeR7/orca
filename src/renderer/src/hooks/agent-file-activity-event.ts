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
  /** `minGapMs` is the shortest spacing this activity may have from the worktree's last emit. */
  signal: (worktreeId: string, minGapMs: number) => void
  dispose: () => void
}

type PacerSlot = {
  lastEmitAt: number
  pendingGapMs: number | null
  timer: ReturnType<typeof setTimeout> | null
  dueAt: number
}

/** Leading-edge emit per worktree; later activity waits out its own gap, coalesced into one emit. */
export function createAgentFileActivityPacer(
  emit: (worktreeId: string) => void
): AgentFileActivityPacer {
  const slots = new Map<string, PacerSlot>()
  const fire = (worktreeId: string, slot: PacerSlot): void => {
    if (slot.timer) {
      clearTimeout(slot.timer)
    }
    slot.timer = null
    slot.pendingGapMs = null
    slot.lastEmitAt = Date.now()
    emit(worktreeId)
  }
  return {
    signal: (worktreeId, minGapMs) => {
      let slot = slots.get(worktreeId)
      if (!slot) {
        slot = { lastEmitAt: Number.NEGATIVE_INFINITY, pendingGapMs: null, timer: null, dueAt: 0 }
        slots.set(worktreeId, slot)
      }
      const gapMs = Math.min(slot.pendingGapMs ?? minGapMs, minGapMs)
      const dueAt = slot.lastEmitAt + gapMs
      const now = Date.now()
      if (dueAt <= now) {
        fire(worktreeId, slot)
        return
      }
      slot.pendingGapMs = gapMs
      if (slot.timer && slot.dueAt <= dueAt) {
        return
      }
      if (slot.timer) {
        clearTimeout(slot.timer)
      }
      const current = slot
      current.dueAt = dueAt
      current.timer = setTimeout(() => fire(worktreeId, current), dueAt - now)
    },
    dispose: () => {
      for (const slot of slots.values()) {
        if (slot.timer) {
          clearTimeout(slot.timer)
        }
      }
      slots.clear()
    }
  }
}
