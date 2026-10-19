import type { AppState } from '@/store'
import { getWorktreeIdFromVisitKey } from '@/lib/worktree-visit-recency'
import { isVirtualEditorFile } from '@/store/slices/editor/tabs/editor-tab-content-type'

// Why: recently used workspaces keep their watch so switching back needs no reload.
export const WARM_RECURSIVE_WATCH_WORKSPACE_COUNT = 3

// Why: unhydrated settings (null) keep today's watch-every-tab behaviour.
export function isBackgroundWatchTrimEnabled(settings: AppState['settings']): boolean {
  return settings?.trimBackgroundWorkspaceWatches === true
}

/** Workspaces whose open tabs keep a watch: active, the warm LRU, and any with unsaved edits. */
export function selectWatchEligibleWorkspaceIds(args: {
  activeWorktreeId: string | null
  lastVisitedAtByWorktreeId: Readonly<Record<string, number>> | undefined
  openFiles: AppState['openFiles']
  exists: (workspaceId: string) => boolean
}): ReadonlySet<string> {
  const ids = new Set<string>()
  if (args.activeWorktreeId) {
    ids.add(args.activeWorktreeId)
  }
  // Why: edits normally happen only in the active workspace; a rare background edit (mobile) just adds a watch, and the rewatch re-check covers what it missed.
  // Combined diffs stay watched: their section saves write without a disk check, and they cache bodies per path.
  for (const file of args.openFiles) {
    if (
      (file.isDirty && !isVirtualEditorFile(file)) ||
      (file.mode === 'diff' && file.diffSource?.startsWith('combined-'))
    ) {
      ids.add(file.worktreeId)
    }
  }
  // Why top-k instead of a full sort: the visit map grows with history.
  const warm: { id: string; visitedAt: number }[] = []
  for (const [key, visitedAt] of Object.entries(args.lastVisitedAtByWorktreeId ?? {})) {
    const id = getWorktreeIdFromVisitKey(key)
    // Why: `exists` keeps deleted workspaces from holding warm slots.
    if (id === args.activeWorktreeId || !args.exists(id)) {
      continue
    }
    const existing = warm.find((entry) => entry.id === id)
    if (existing) {
      existing.visitedAt = Math.max(existing.visitedAt, visitedAt)
    } else {
      warm.push({ id, visitedAt })
    }
    warm.sort((left, right) => right.visitedAt - left.visitedAt)
    warm.length = Math.min(warm.length, WARM_RECURSIVE_WATCH_WORKSPACE_COUNT)
  }
  for (const entry of warm) {
    ids.add(entry.id)
  }
  return ids
}
