import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { subscribeEditorRuntimeFileWatch } from './editor-runtime-file-watch'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import type { FsChangedPayload } from '../../../shared/filesystem-entry-types'
import {
  getEditorExternalWatchTargetKey,
  selectEditorExternalWatchTargets,
  type EditorExternalWatchTarget
} from './editor-external-watch-targets'
import { buildEditorExternalWatchEventHandler } from './editor-external-watch-event-reconciliation'
import { verifyLatchedEditorMoveDestinations } from './editor-external-watch-disk-verification'
import {
  acquireWatchRoot,
  releaseAllWatchRoots,
  releaseWatchRoot,
  type HeldWatchRoots
} from './editor-external-watch-local-roots'
import {
  catchUpEditorTabsAfterRewatch,
  hasBaselinedEditorTabs
} from './editor-external-watch-rewatch-reload'

function warnExternalWatchFailure(target: EditorExternalWatchTarget, err: unknown): void {
  console.warn('[filesystem-watch] failed to watch worktree', {
    worktreeId: target.worktreeId,
    worktreePath: target.worktreePath,
    connectionId: target.connectionId,
    error: err instanceof Error ? err.message : String(err)
  })
}

/** Keeps editor filesystem subscriptions alive beyond any individual editor surface. */
export function useEditorExternalWatch(): void {
  const snapshot = useAppStore(selectEditorExternalWatchTargets)
  const targetsRef = useRef<EditorExternalWatchTarget[]>([])
  const unwatchedTargetKeysRef = useRef<ReadonlySet<string>>(new Set())
  const remoteWatchUnsubsRef = useRef(new Map<string, () => void>())
  const heldWatchRootsRef = useRef<HeldWatchRoots>(new Map())
  const fsChangedHandlerRef = useRef<
    ((payload: FsChangedPayload, runtimeEnvironmentId?: string | null) => void) | null
  >(null)

  // Why: diff targets so unchanged worktrees keep their subscription; full teardown on every store change drops events in the gap.
  useEffect(() => {
    const nextTargets = snapshot.targets
    const previousUnwatchedKeys = unwatchedTargetKeysRef.current
    unwatchedTargetKeysRef.current = snapshot.unwatchedTargetKeys
    const previousTargets = targetsRef.current
    const previousKeys = new Set(previousTargets.map(getEditorExternalWatchTargetKey))
    const nextKeys = new Set(nextTargets.map(getEditorExternalWatchTargetKey))
    const removed = previousTargets.filter(
      (target) => !nextKeys.has(getEditorExternalWatchTargetKey(target))
    )
    const added = nextTargets.filter(
      (target) => !previousKeys.has(getEditorExternalWatchTargetKey(target))
    )

    // Why: acquire before release so a root shared by an added and a removed target is never dropped in between.
    for (const target of added) {
      // Why: tabs loaded while it was unwatched (background trim) missed every write since; refresh them, best effort.
      const catchUp =
        previousUnwatchedKeys.has(getEditorExternalWatchTargetKey(target)) ||
        hasBaselinedEditorTabs(target)
      if (target.runtimeEnvironmentId) {
        // Why: the host's ready event means its watcher is installed, so nothing written after the refresh read is lost.
        subscribeRuntimeTarget(
          target,
          remoteWatchUnsubsRef.current,
          fsChangedHandlerRef,
          catchUp ? () => void catchUpEditorTabsAfterRewatch(target) : undefined
        )
        continue
      }
      const installed = acquireWatchRoot(heldWatchRootsRef.current, target, (err) => {
        // Why: SSH providers can disappear while tabs still reference the worktree; report the failure without an uncaught renderer promise.
        warnExternalWatchFailure(target, err)
      })
      if (catchUp) {
        void installed.then(() => catchUpEditorTabsAfterRewatch(target))
      }
    }
    for (const target of removed) {
      const key = getEditorExternalWatchTargetKey(target)
      const remoteUnsubscribe = remoteWatchUnsubsRef.current.get(key)
      if (remoteUnsubscribe) {
        remoteUnsubscribe()
        remoteWatchUnsubsRef.current.delete(key)
      } else {
        releaseWatchRoot(heldWatchRootsRef.current, target)
      }
    }
    targetsRef.current = nextTargets
    // Why: final unmount cleanup owns teardown so target changes remain differential.
    // Why: the selector keeps the snapshot identity until a target or unwatched key changes.
  }, [snapshot])

  // Why: one stable fs:changed listener prevents target-key changes from opening an event-loss gap.
  useEffect(() => {
    const remoteWatchUnsubs = remoteWatchUnsubsRef.current
    const heldWatchRoots = heldWatchRootsRef.current
    const { handleFsChanged, dispose } = buildEditorExternalWatchEventHandler(
      (worktreePath, runtimeEnvironmentId) =>
        targetsRef.current.find(
          (target) =>
            normalizeRuntimePathForComparison(target.worktreePath) ===
              normalizeRuntimePathForComparison(worktreePath) &&
            target.runtimeEnvironmentId === runtimeEnvironmentId
        )
    )
    const unsubscribe = window.api.fs.onFsChanged((payload) => handleFsChanged(payload, null))
    fsChangedHandlerRef.current = handleFsChanged

    return () => {
      unsubscribe()
      dispose()
      fsChangedHandlerRef.current = null
      for (const remoteUnsubscribe of remoteWatchUnsubs.values()) {
        remoteUnsubscribe()
      }
      remoteWatchUnsubs.clear()
      releaseAllWatchRoots(heldWatchRoots)
      targetsRef.current = []
      unwatchedTargetKeysRef.current = new Set()
      // Why: module-scoped reload timers survive StrictMode's synthetic cleanup; a late reload dispatch is harmless.
    }
  }, [])
}

function subscribeRuntimeTarget(
  target: EditorExternalWatchTarget,
  remoteWatchUnsubs: Map<string, () => void>,
  fsChangedHandlerRef: {
    current: ((payload: FsChangedPayload, runtimeEnvironmentId?: string | null) => void) | null
  },
  onFirstReady: (() => void) | undefined
): void {
  const runtimeEnvironmentId = target.runtimeEnvironmentId
  if (!runtimeEnvironmentId) {
    return
  }
  const key = getEditorExternalWatchTargetKey(target)
  remoteWatchUnsubs.set(
    key,
    subscribeEditorRuntimeFileWatch(
      { ...target, runtimeEnvironmentId },
      (payload) => fsChangedHandlerRef.current?.(payload, runtimeEnvironmentId),
      (error) => warnExternalWatchFailure(target, error),
      onFirstReady
    )
  )
}

export function verifyLatchedMoveDestinations(
  ...args: Parameters<typeof verifyLatchedEditorMoveDestinations>
): void {
  verifyLatchedEditorMoveDestinations(...args)
}
