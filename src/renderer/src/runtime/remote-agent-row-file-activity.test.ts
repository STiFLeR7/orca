/**
 * A paired client mirrors host status for remote panes, but when its own byte pipeline owns a pane
 * the mirror keeps the client's entry. The file-activity stamp is a host-only fact (the bytes never
 * carry it), so it must still come from the host frame, or agent edits never refresh the client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { AgentFileActivityKind } from '../../../shared/agent-status-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { getDefaultSettings } from '../../../shared/constants'
import { createTestStore, makeWorktree, seedStore } from '../store/slices/store-test-helpers'
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resetRendererOwnedAgentStatusPanesForTests
} from '../components/terminal-pane/renderer-owned-agent-status-registry'
import { applyFreshWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn(),
    getState: vi.fn(() => ({})),
    subscribe: vi.fn(() => () => {})
  }
}))

const WT = 'repo1::/path/wt1'
const ENV = 'remote-env-1'
const T0 = 1_700_000_000_000
const HOST_TAB = 'host-tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey(toWebTerminalSurfaceTabId(HOST_TAB), LEAF)

type TestStore = ReturnType<typeof createTestStore>

function hostSnapshot(
  snapshotVersion: number,
  hostNow: number,
  activity?: { at: number; kind: AgentFileActivityKind }
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'host-epoch-1',
    snapshotVersion,
    activeGroupId: 'host-group-1',
    activeTabId: `${HOST_TAB}::${LEAF}`,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `${HOST_TAB}::${LEAF}`,
        title: 'Claude Code',
        parentTabId: HOST_TAB,
        leafId: LEAF,
        isActive: true,
        launchAgent: 'claude',
        status: 'ready',
        terminal: 'terminal-1',
        agentStatus: {
          state: 'working',
          prompt: '',
          updatedAt: hostNow,
          stateStartedAt: T0 - 5_000,
          agentType: 'claude',
          paneKey: makePaneKey(HOST_TAB, LEAF),
          tabId: HOST_TAB,
          worktreeId: WT,
          stateHistory: [],
          ...(activity ? { fileActivityAt: activity.at, fileActivityKind: activity.kind } : {})
        }
      }
    ]
  }
}

function applyHostSnapshot(
  store: TestStore,
  snapshot: RuntimeMobileSessionTabsResult,
  now: number
) {
  vi.setSystemTime(now)
  const state = store.getState()
  store.setState(applyFreshWebSessionTabsSnapshot(state, snapshot, ENV, now))
}

// What pty-connection does for a remote pane: claim it, then write byte-derived status.
function writeClientByteStatus(store: TestStore, now: number): void {
  vi.setSystemTime(now)
  registerRendererOwnedAgentStatusPane(PANE, ENV)
  markRendererOwnedAgentStatusWrite(PANE)
  store
    .getState()
    .setAgentStatus(
      PANE,
      { state: 'working', prompt: '', agentType: 'claude' },
      'Claude Code',
      undefined,
      {
        tabId: toWebTerminalSurfaceTabId(HOST_TAB),
        worktreeId: WT
      }
    )
}

function seedClient(): TestStore {
  const store = createTestStore()
  seedStore(store, {
    settings: getDefaultSettings('/tmp'),
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT
  })
  return store
}

describe('paired client adopts the host file-activity stamp on panes it owns', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetRendererOwnedAgentStatusPanesForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetRendererOwnedAgentStatusPanesForTests()
  })

  it('takes a newer host stamp and never moves backwards', () => {
    const store = seedClient()
    applyHostSnapshot(store, hostSnapshot(1, T0 - 1_000, { at: 100, kind: 'edit' }), T0)
    writeClientByteStatus(store, T0 + 500)
    applyHostSnapshot(store, hostSnapshot(2, T0 + 1_000, { at: 200, kind: 'command' }), T0 + 2_000)
    expect(store.getState().agentStatusByPaneKey[PANE]).toMatchObject({
      fileActivityAt: 200,
      fileActivityKind: 'command'
    })

    writeClientByteStatus(store, T0 + 2_500)
    applyHostSnapshot(store, hostSnapshot(3, T0 + 3_000), T0 + 4_000)
    expect(store.getState().agentStatusByPaneKey[PANE]?.fileActivityAt).toBe(200)
  })
})
