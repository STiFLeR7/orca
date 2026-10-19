import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import {
  isExternalReloadableEditorTab,
  notifyEditorExternalFileChange,
  type EditorPathMutationTarget
} from '@/components/editor/editor-autosave'
import {
  getLocalWindowsWslAliasOption,
  getOpenFileRuntimeOwner,
  type EditorExternalWatchTarget
} from './editor-external-watch-targets'

type AgentActivityReloadTarget = Pick<EditorExternalWatchTarget, 'worktreeId' | 'worktreePath'> &
  Partial<Pick<EditorExternalWatchTarget, 'runtimeEnvironmentId' | 'allowLocalWindowsWslAliases'>>

// Why: agent activity is "maybe changed", not path evidence — never touch dirty or tombstoned tabs.
function isAgentActivityReloadable(file: OpenFile): boolean {
  return isExternalReloadableEditorTab(file) && !file.isDirty && !file.externalMutation
}

/** One notification per eligible tab, scoped by file id so sibling tabs of the same path are untouched. */
export function collectAgentActivityEditorReloads(
  target: AgentActivityReloadTarget
): EditorPathMutationTarget[] {
  const notifications: EditorPathMutationTarget[] = []
  const runtimeEnvironmentId = target.runtimeEnvironmentId ?? null
  for (const file of useAppStore.getState().openFiles) {
    if (
      file.worktreeId !== target.worktreeId ||
      getOpenFileRuntimeOwner(file) !== runtimeEnvironmentId ||
      !isAgentActivityReloadable(file)
    ) {
      continue
    }
    const notification: EditorPathMutationTarget = {
      worktreeId: target.worktreeId,
      worktreePath: target.worktreePath,
      relativePath: file.relativePath,
      runtimeEnvironmentId,
      fileIds: [file.id],
      ...getLocalWindowsWslAliasOption(target)
    }
    // Why: consumers re-run this at dispatch, so a tab that turned dirty meanwhile is skipped, not marked.
    Object.defineProperty(notification, 'indexedOpenFiles', {
      value: {
        matches: (openFiles: OpenFile[]) =>
          openFiles.filter(
            (candidate) => candidate.id === file.id && isAgentActivityReloadable(candidate)
          )
      }
    })
    notifications.push(notification)
  }
  return notifications
}

export function reloadEditorsAfterAgentActivity(target: AgentActivityReloadTarget): void {
  for (const notification of collectAgentActivityEditorReloads(target)) {
    notifyEditorExternalFileChange(notification)
  }
}
