import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import {
  getOpenFilesForExternalFileChange,
  isExternalReloadableEditorTab,
  notifyEditorExternalFileChange,
  type EditorPathMutationTarget
} from '@/components/editor/editor-autosave'
import { probeEditorTabFilePresence } from '@/components/editor/editor-restored-tab-conflict-scan'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
import { getRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { runtimePathExists } from '@/runtime/runtime-file-metadata-client'
import {
  ORCA_WORKTREE_FILE_CHANGE_EVENT,
  type WorktreeFileChangeEventDetail
} from './worktree-file-change-event'
import {
  getLocalWindowsWslAliasOption,
  getOpenFileRuntimeOwner,
  type EditorExternalWatchTarget
} from './editor-external-watch-targets'

// Why: matches the conflict scan's read cap so a switch-back can't fan out one stat per tab at once.
const MAX_CONCURRENT_CATCH_UP_PROBES = 3

function isTargetTab(file: OpenFile, target: EditorExternalWatchTarget): boolean {
  return (
    file.worktreeId === target.worktreeId &&
    getOpenFileRuntimeOwner(file) === target.runtimeEnvironmentId
  )
}

function isTombstoned(file: OpenFile): boolean {
  return file.externalMutation === 'deleted' || file.externalMutation === 'renamed'
}

/** True when the target has tabs loaded before, so writes made while it was unwatched could be missed. */
export function hasBaselinedEditorTabs(target: EditorExternalWatchTarget): boolean {
  return useAppStore
    .getState()
    .openFiles.some((file) => isTargetTab(file, target) && !!file.lastKnownDiskSignature)
}

// Why: this is a catch-up, not change evidence; a dirty or marked match would be wrongly marked changed or force-reloaded into a load error.
function notifyIfAllMatchesClean(notification: EditorPathMutationTarget): void {
  const matches = getOpenFilesForExternalFileChange(useAppStore.getState().openFiles, notification)
  if (matches.every((file) => !file.isDirty && !file.externalMutation)) {
    notifyEditorExternalFileChange(notification)
  }
}

async function probeTabFilePresence(
  target: EditorExternalWatchTarget,
  file: OpenFile
): Promise<'present' | 'missing' | 'unknown'> {
  const state = useAppStore.getState()
  const owner = getRuntimeTargetForFileOwner(state, file.worktreeId, file.runtimeEnvironmentId)
  if (owner?.kind !== 'environment') {
    return probeEditorTabFilePresence(state, file)
  }
  // Why: runtime-owned files are stat'ed on their host; only a transport failure stays unknown.
  try {
    const exists = await runtimePathExists(
      { target: owner, worktreeId: file.worktreeId, worktreePath: target.worktreePath },
      file.filePath
    )
    return exists ? 'present' : 'missing'
  } catch {
    return 'unknown'
  }
}

/** Runs `probe` and reports whether the tab stayed open throughout, so a close-and-reopen under the same id is caught. */
async function probeWithinTabLifetime<T>(
  fileId: string,
  probe: () => Promise<T>
): Promise<{ result: T; sameLifetime: boolean }> {
  let sameLifetime = true
  const stop = useAppStore.subscribe((state) => {
    if (!state.openFiles.some((f) => f.id === fileId)) {
      sameLifetime = false
    }
  })
  try {
    return { result: await probe(), sameLifetime }
  } finally {
    stop()
  }
}

async function catchUpTab(target: EditorExternalWatchTarget, file: OpenFile): Promise<void> {
  // Why: a tombstone only moves on proof; a plain clean tab reloads unless a stat proves it gone.
  const { result: presence, sameLifetime } =
    file.mode === 'edit' || isTombstoned(file)
      ? await probeWithinTabLifetime(file.id, () => probeTabFilePresence(target, file))
      : { result: 'unknown' as const, sameLifetime: true }
  const state = useAppStore.getState()
  // Why: benign updates (a late baseline stamp) replace the tab object; re-resolve and re-check eligibility instead.
  const live = state.openFiles.find((f) => f.id === file.id)
  if (
    !sameLifetime ||
    !live ||
    live.isDirty ||
    live.externalMutation === 'changed' ||
    live.filePath !== file.filePath ||
    getOpenFileRuntimeOwner(live) !== getOpenFileRuntimeOwner(file)
  ) {
    return
  }
  if (isTombstoned(live)) {
    if (presence !== 'present') {
      return
    }
    // Why: recreated while unwatched — mirror the watcher's create handling, then reload.
    state.setExternalMutation(live.id, null)
  } else if (presence === 'missing') {
    // Why: deleted/renamed while unwatched; mark it like a live delete event would instead of a failed reload.
    state.setExternalMutation(live.id, 'deleted')
    return
  }
  notifyIfAllMatchesClean({
    worktreeId: target.worktreeId,
    worktreePath: target.worktreePath,
    relativePath: live.relativePath,
    runtimeEnvironmentId: target.runtimeEnvironmentId,
    ...getLocalWindowsWslAliasOption(target)
  })
}

/**
 * Best-effort freshness for a workspace watched again: clean tabs re-read disk, and workspace
 * listeners (document lists, git status) get one overflow nudge. A stale tab edited before
 * this lands is caught at save time by the disk precondition, not here.
 */
export async function catchUpEditorTabsAfterRewatch(
  target: EditorExternalWatchTarget
): Promise<void> {
  window.dispatchEvent(
    new CustomEvent<WorktreeFileChangeEventDetail>(ORCA_WORKTREE_FILE_CHANGE_EVENT, {
      detail: {
        payload: {
          worktreePath: target.worktreePath,
          events: [{ kind: 'overflow', absolutePath: target.worktreePath }]
        },
        runtimeEnvironmentId: target.runtimeEnvironmentId
      }
    })
  )
  const files = useAppStore
    .getState()
    .openFiles.filter(
      (file) =>
        isTargetTab(file, target) &&
        !file.isDirty &&
        file.externalMutation !== 'changed' &&
        isExternalReloadableEditorTab(file)
    )
  await mapWithConcurrency(files, MAX_CONCURRENT_CATCH_UP_PROBES, (file) =>
    catchUpTab(target, file)
  )
}
