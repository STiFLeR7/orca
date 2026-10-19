import { useEffect } from 'react'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { collectLeafIdsInOrder } from './terminal-layout-leaf-ids'
import type { TerminalPaneLayoutController } from './use-terminal-pane-layout-persistence'

// Why: a host snapshot taken before it saw a local rename still carries the old name; hold the
// rename until the host echoes it, so that stale snapshot cannot undo it. Keyed `tabId\0leafId`.
const pendingLocalPaneTitles = new Map<string, string | null>()

const pendingKey = (tabId: string, leafId: string): string => `${tabId}\0${leafId}`

function isHostOwnedLayout(layout: TerminalLayoutSnapshot | undefined): boolean {
  return Object.values(layout?.ptyIdsByLeafId ?? {}).some((ptyId) => isRemoteRuntimePtyId(ptyId))
}

/** Records a user's rename of a host-owned pane until the host's published layout agrees. */
export function notePendingLocalPaneTitle(args: {
  tabId: string
  leafId: string
  title: string | null
  layout: TerminalLayoutSnapshot | undefined
}): void {
  if (isHostOwnedLayout(args.layout)) {
    pendingLocalPaneTitles.set(pendingKey(args.tabId, args.leafId), args.title)
  }
}

/** The pane titles a host published that an open pane does not show yet, by pane id. */
export function hostPaneTitleUpdates(args: {
  tabId: string
  layout: TerminalLayoutSnapshot
  panes: readonly { id: number; leafId: string }[]
  shownTitles: Readonly<Record<number, string>>
}): Map<number, string | null> {
  const updates = new Map<number, string | null>()
  // Local tabs are the window's own; only a host-owned layout is published by someone else.
  if (!isHostOwnedLayout(args.layout)) {
    return updates
  }
  const hostLeafIds = new Set(collectLeafIdsInOrder(args.layout.root))
  for (const pane of args.panes) {
    if (!hostLeafIds.has(pane.leafId)) {
      continue
    }
    const hostTitle = args.layout.titlesByLeafId?.[pane.leafId]?.trim() || null
    const key = pendingKey(args.tabId, pane.leafId)
    if (pendingLocalPaneTitles.has(key)) {
      if (pendingLocalPaneTitles.get(key) !== hostTitle) {
        continue
      }
      pendingLocalPaneTitles.delete(key)
    }
    if ((args.shownTitles[pane.id] ?? null) !== hostTitle) {
      updates.set(pane.id, hostTitle)
    }
  }
  return updates
}

/** Open panes follow pane names the host publishes, not only the ones they opened with. */
export function useHostPaneTitleSync(controller: TerminalPaneLayoutController): void {
  const { managerRef, paneLayoutRevision, paneTitlesRef, savedLayout, setPaneTitles, tabId } =
    controller
  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    const updates = hostPaneTitleUpdates({
      tabId,
      layout: savedLayout,
      panes: manager.getPanes(),
      shownTitles: paneTitlesRef.current
    })
    if (updates.size === 0) {
      return
    }
    const apply = (previous: Record<number, string>): Record<number, string> => {
      const next = { ...previous }
      for (const [paneId, title] of updates) {
        if (title === null) {
          delete next[paneId]
        } else {
          next[paneId] = title
        }
      }
      return next
    }
    // The store already holds the host's layout, so nothing is persisted or pushed back.
    paneTitlesRef.current = apply(paneTitlesRef.current)
    setPaneTitles(apply)
  }, [managerRef, paneLayoutRevision, paneTitlesRef, savedLayout, setPaneTitles, tabId])
}
