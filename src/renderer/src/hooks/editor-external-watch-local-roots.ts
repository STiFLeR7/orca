import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'

type WatchRootArgs = { worktreePath: string; connectionId: string | undefined }

type HeldWatchRoot = {
  args: WatchRootArgs
  consumers: number
  installed: Promise<void>
}

/** Local and SSH watch roots held by this renderer, counted per physical root. */
export type HeldWatchRoots = Map<string, HeldWatchRoot>

// Why: main keeps one listener per renderer and root, so two workspace ids on one directory must share one watch.
function getWatchRootKey(target: WatchRootArgs): string {
  return `${target.connectionId ?? 'local'}::${normalizeRuntimePathForComparison(target.worktreePath)}`
}

/** Resolves once the root's watch request has settled, including when another consumer started it. */
export function acquireWatchRoot(
  roots: HeldWatchRoots,
  target: EditorExternalWatchTarget,
  onError: (error: unknown) => void
): Promise<void> {
  const key = getWatchRootKey(target)
  const held = roots.get(key)
  if (held) {
    held.consumers += 1
    return held.installed
  }
  const args = { worktreePath: target.worktreePath, connectionId: target.connectionId }
  const installed = window.api.fs.watchWorktree(args).catch(onError)
  roots.set(key, { args, consumers: 1, installed })
  return installed
}

export function releaseWatchRoot(roots: HeldWatchRoots, target: EditorExternalWatchTarget): void {
  const key = getWatchRootKey(target)
  const held = roots.get(key)
  if (!held) {
    return
  }
  held.consumers -= 1
  if (held.consumers > 0) {
    return
  }
  roots.delete(key)
  void window.api.fs.unwatchWorktree(held.args)
}

export function releaseAllWatchRoots(roots: HeldWatchRoots): void {
  for (const held of roots.values()) {
    void window.api.fs.unwatchWorktree(held.args)
  }
  roots.clear()
}
