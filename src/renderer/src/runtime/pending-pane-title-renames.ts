import { isRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'

// Why: a host snapshot taken before it saw a local rename still carries the old name; keep the
// rename over host snapshots until the host echoes it. Leaf ids are unique, so they are the key.
const pendingTitleByLeafId = new Map<string, string | null>()

/** Records a user's rename of a host-owned pane; a window's own tabs need no hold. */
export function notePendingPaneTitleRename(args: {
  leafId: string
  title: string | null
  layout: TerminalLayoutSnapshot | undefined
}): void {
  const ptyIds = Object.values(args.layout?.ptyIdsByLeafId ?? {})
  if (ptyIds.some((ptyId) => isRemoteRuntimePtyId(ptyId))) {
    pendingTitleByLeafId.set(args.leafId, args.title)
  }
}

/** The host's pane titles with each unconfirmed local rename kept; an echo confirms one. */
export function withPendingPaneTitleRenames(
  hostTitles: Record<string, string> | undefined,
  leafIds: readonly string[]
): Record<string, string> | undefined {
  const titles = { ...hostTitles }
  for (const leafId of leafIds) {
    if (!pendingTitleByLeafId.has(leafId)) {
      continue
    }
    const pending = pendingTitleByLeafId.get(leafId) ?? null
    if ((titles[leafId]?.trim() || null) === pending) {
      pendingTitleByLeafId.delete(leafId)
    } else if (pending === null) {
      delete titles[leafId]
    } else {
      titles[leafId] = pending
    }
  }
  return Object.keys(titles).length > 0 ? titles : undefined
}
