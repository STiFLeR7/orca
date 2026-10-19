import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import {
  notePendingPaneTitleRename,
  withPendingPaneTitleRenames
} from './pending-pane-title-renames'

function layoutFor(leafId: string, ptyId: string): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId }
  }
}
const remotePty = toRemoteRuntimePtyId('host-pty', 'env-1')

describe('a local pane rename over host snapshots', () => {
  it('outlasts a stale host snapshot, then follows the host once it echoes', () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    notePendingPaneTitleRename({ leafId, title: 'mine', layout: layoutFor(leafId, remotePty) })

    expect(withPendingPaneTitleRenames({ [leafId]: 'old' }, [leafId])).toEqual({ [leafId]: 'mine' })
    expect(withPendingPaneTitleRenames({ [leafId]: 'mine' }, [leafId])).toEqual({
      [leafId]: 'mine'
    })
    // Echoed, so a later host change wins again.
    expect(withPendingPaneTitleRenames({ [leafId]: 'host' }, [leafId])).toEqual({
      [leafId]: 'host'
    })
  })

  it('holds a local clear the same way', () => {
    const leafId = '22222222-2222-4222-8222-222222222222'
    notePendingPaneTitleRename({ leafId, title: null, layout: layoutFor(leafId, remotePty) })

    expect(withPendingPaneTitleRenames({ [leafId]: 'old' }, [leafId])).toBeUndefined()
    expect(withPendingPaneTitleRenames(undefined, [leafId])).toBeUndefined()
    expect(withPendingPaneTitleRenames({ [leafId]: 'host' }, [leafId])).toEqual({
      [leafId]: 'host'
    })
  })

  it("holds nothing for a window's own local tab", () => {
    const leafId = '33333333-3333-4333-8333-333333333333'
    notePendingPaneTitleRename({ leafId, title: 'mine', layout: layoutFor(leafId, 'local-pty') })

    expect(withPendingPaneTitleRenames({ [leafId]: 'old' }, [leafId])).toEqual({ [leafId]: 'old' })
  })
})
