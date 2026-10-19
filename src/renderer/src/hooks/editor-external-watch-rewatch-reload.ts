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

async function catchUpTab(target: EditorExternalWatchTarget, file: OpenFile): Promise<void> {
  // Why: a tombstone only moves on proof; a plain clean tab reloads unless a stat proves it gone.
  const presence =
    file.mode === 'edit' || isTombstoned(file)
      ? await probeEditorTabFilePresence(useAppStore.getState(), file)
      : 'unknown'
  const state = useAppStore.getState()
  // Why: the same id can be closed and reopened during the probe; a verdict for the old tab must not land on the new one.
  if (state.openFiles.find((f) => f.id === file.id) !== file) {
    return
  }
  if (isTombstoned(file)) {
    if (presence !== 'present') {
      return
    }
    // Why: recreated while unwatched — mirror the watcher's create handling, then reload.
    state.setExternalMutation(file.id, null)
  } else if (presence === 'missing') {
    // Why: deleted/renamed while unwatched; mark it like a live delete event would instead of a failed reload.
    state.setExternalMutation(file.id, 'deleted')
    return
  }
  notifyIfAllMatchesClean({
    worktreeId: target.worktreeId,
    worktreePath: target.worktreePath,
    relativePath: file.relativePath,
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
