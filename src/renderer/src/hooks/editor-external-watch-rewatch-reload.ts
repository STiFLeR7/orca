import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import {
  getOpenFilesForExternalFileChange,
  isExternalReloadableEditorTab,
  notifyEditorExternalFileChange,
  type EditorPathMutationTarget
} from '@/components/editor/editor-autosave'
import { probeEditorTabFileMissing } from '@/components/editor/editor-restored-tab-conflict-scan'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
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

/** True when the target has tabs loaded before, so writes made while it was unwatched could be missed. */
export function hasBaselinedEditorTabs(target: EditorExternalWatchTarget): boolean {
  return useAppStore
    .getState()
    .openFiles.some((file) => isTargetTab(file, target) && !!file.lastKnownDiskSignature)
}

// Why: this is a catch-up, not change evidence; a dirty or tombstoned match would be wrongly marked changed or force-reloaded into a load error.
function notifyIfAllMatchesClean(notification: EditorPathMutationTarget): void {
  const matches = getOpenFilesForExternalFileChange(useAppStore.getState().openFiles, notification)
  if (matches.every((file) => !file.isDirty && !file.externalMutation)) {
    notifyEditorExternalFileChange(notification)
  }
}

/**
 * Best-effort freshness for a workspace watched again: clean tabs re-read disk. A stale tab
 * edited before this lands is caught at save time by the disk precondition, not here.
 */
export async function catchUpEditorTabsAfterRewatch(
  target: EditorExternalWatchTarget
): Promise<void> {
  const files = useAppStore
    .getState()
    .openFiles.filter(
      (file) =>
        isTargetTab(file, target) &&
        !file.isDirty &&
        !file.externalMutation &&
        isExternalReloadableEditorTab(file)
    )
  await mapWithConcurrency(files, MAX_CONCURRENT_CATCH_UP_PROBES, async (file) => {
    if (file.mode === 'edit' && (await probeEditorTabFileMissing(useAppStore.getState(), file))) {
      const live = useAppStore.getState()
      const liveFile = live.openFiles.find((f) => f.id === file.id)
      // Why: deleted/renamed while unwatched; mark it like a live delete event would instead of a failed reload.
      if (liveFile && !liveFile.isDirty && !liveFile.externalMutation) {
        live.setExternalMutation(file.id, 'deleted')
      }
      return
    }
    notifyIfAllMatchesClean({
      worktreeId: target.worktreeId,
      worktreePath: target.worktreePath,
      relativePath: file.relativePath,
      runtimeEnvironmentId: target.runtimeEnvironmentId,
      ...getLocalWindowsWslAliasOption(target)
    })
  })
}
