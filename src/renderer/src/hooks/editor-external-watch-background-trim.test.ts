import { describe, expect, it, vi } from 'vitest'
import {
  selectEditorExternalWatchTargets,
  type EditorExternalWatchTargetState
} from './editor-external-watch-targets'
import { WARM_RECURSIVE_WATCH_WORKSPACE_COUNT } from './editor-external-watch-scope'
import { getWorktreeVisitKey } from '@/lib/worktree-visit-recency'
import { getDefaultSettings } from '../../../shared/constants'
import {
  makeFolderWorkspace,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/worktrees-slice-test-fixtures'

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))

type Repo = EditorExternalWatchTargetState['repos'][number]
type Worktree = EditorExternalWatchTargetState['worktreesByRepo'][string][number]
type OpenFile = EditorExternalWatchTargetState['openFiles'][number]
type FolderWorkspace = EditorExternalWatchTargetState['folderWorkspaces'][number]

const repo = (id: string, connectionId: string | null = null): Repo => ({
  ...TEST_REPO,
  id,
  path: `/${id}`,
  kind: 'git',
  connectionId
})

const worktree = (repoId: string, id: string, path = `/${repoId}/${id}`): Worktree =>
  makeWorktree({ id, repoId, path })

const tab = (worktreeId: string, extra: Partial<OpenFile> = {}): OpenFile => ({
  id: `${worktreeId}-file`,
  worktreeId,
  filePath: `/x/${worktreeId}/a.ts`,
  relativePath: 'a.ts',
  language: 'typescript',
  mode: 'edit',
  isDirty: false,
  ...extra
})

function makeState(args: {
  worktrees: Worktree[]
  repos?: Repo[]
  openFiles: OpenFile[]
  activeWorktreeId?: string | null
  visits?: Record<string, number>
  trim?: boolean | undefined
  folderWorkspaces?: FolderWorkspace[]
}): EditorExternalWatchTargetState {
  const worktreesByRepo: EditorExternalWatchTargetState['worktreesByRepo'] = {}
  for (const wt of args.worktrees) {
    ;(worktreesByRepo[wt.repoId] ??= []).push(wt)
  }
  return {
    openFiles: args.openFiles,
    worktreesByRepo,
    repos: args.repos ?? [repo('r')],
    activeWorktreeId: args.activeWorktreeId ?? null,
    lastVisitedAtByWorktreeId: args.visits ?? {},
    rightSidebarOpen: false,
    rightSidebarTab: 'explorer',
    rightSidebarExplorerView: 'files',
    gitStatusHugeByWorktree: {},
    sshConnectionStates: new Map(),
    folderWorkspaces: args.folderWorkspaces ?? [],
    projectGroups: [],
    settings: { ...getDefaultSettings('/tmp'), trimBackgroundWorkspaceWatches: args.trim }
  }
}

const watchedIds = (state: EditorExternalWatchTargetState): string[] =>
  selectEditorExternalWatchTargets(state).targets.map((target) => target.worktreeId)

describe('background workspace watch trim', () => {
  const ids = ['wt0', 'wt1', 'wt2', 'wt3', 'wt4']
  const worktrees = ids.map((id) => worktree('r', id))

  it('watches the active workspace and drops clean background ones', () => {
    const state = makeState({
      worktrees,
      openFiles: [tab('wt0'), tab('wt1')],
      activeWorktreeId: 'wt0',
      trim: true
    })
    expect(watchedIds(state)).toEqual(['wt0'])
    expect([...selectEditorExternalWatchTargets(state).unwatchedTargetKeys]).toEqual([
      'wt1::/r/wt1::local::client::literal'
    ])
  })

  it.each([false, undefined])(
    'watches every workspace with a tab when the setting is %s',
    (trim) => {
      const state = makeState({
        worktrees,
        openFiles: [tab('wt0'), tab('wt1')],
        activeWorktreeId: 'wt0',
        trim
      })
      expect(watchedIds(state)).toEqual(['wt0', 'wt1'])
      expect(selectEditorExternalWatchTargets(state).unwatchedTargetKeys.size).toBe(0)
    }
  )

  it(`keeps the ${WARM_RECURSIVE_WATCH_WORKSPACE_COUNT} most recently visited workspaces and evicts older ones`, () => {
    const state = makeState({
      worktrees,
      openFiles: ids.map((id) => tab(id)),
      activeWorktreeId: 'wt0',
      // Why: mixes host-qualified and legacy bare keys, as persisted sessions do.
      visits: {
        wt0: 50,
        [getWorktreeVisitKey('wt1', 'local')]: 1,
        wt2: 2,
        [getWorktreeVisitKey('wt3', 'local')]: 3,
        wt4: 4
      },
      trim: true
    })
    expect(watchedIds(state)).toEqual(['wt0', 'wt2', 'wt3', 'wt4'])
  })

  it('does not let a deleted workspace hold a warm slot', () => {
    const state = makeState({
      worktrees,
      openFiles: ids.map((id) => tab(id)),
      activeWorktreeId: 'wt0',
      visits: { gone: 100, 'also-gone': 99, wt1: 1, wt2: 2, wt3: 3 },
      trim: true
    })
    expect(watchedIds(state)).toEqual(['wt0', 'wt1', 'wt2', 'wt3'])
  })

  it('keeps a background workspace with an unsaved tab and releases it once clean', () => {
    const dirty = makeState({
      worktrees,
      openFiles: [tab('wt0'), tab('wt1', { isDirty: true })],
      activeWorktreeId: 'wt0',
      trim: true
    })
    expect(watchedIds(dirty)).toEqual(['wt0', 'wt1'])

    const saved = makeState({
      worktrees,
      openFiles: [tab('wt0'), tab('wt1')],
      activeWorktreeId: 'wt0',
      trim: true
    })
    expect(watchedIds(saved)).toEqual(['wt0'])
  })

  it('keeps a background workspace with a combined diff tab watched', () => {
    const state = makeState({
      worktrees,
      openFiles: [
        tab('wt0'),
        tab('wt1', { id: 'combined', mode: 'diff', diffSource: 'combined-uncommitted' }),
        tab('wt2')
      ],
      activeWorktreeId: 'wt0',
      trim: true
    })
    expect(watchedIds(state)).toEqual(['wt0', 'wt1'])
  })

  it('ignores a dirty virtual tab when deciding eligibility', () => {
    const state = makeState({
      worktrees,
      openFiles: [tab('wt1', { mode: 'check-details', isDirty: true }), tab('wt1', { id: 'b' })],
      activeWorktreeId: 'wt0',
      trim: true
    })
    expect(watchedIds(state)).toEqual([])
  })

  it('recomputes when the setting or the visit map changes', () => {
    const base = {
      worktrees,
      openFiles: [tab('wt0'), tab('wt1')],
      activeWorktreeId: 'wt0'
    }
    const state = makeState({ ...base, trim: true })
    expect(watchedIds(state)).toEqual(['wt0'])
    expect(
      watchedIds({ ...state, settings: makeState({ ...base, trim: false }).settings })
    ).toEqual(['wt0', 'wt1'])
    expect(watchedIds({ ...state, lastVisitedAtByWorktreeId: { wt1: 1 } })).toEqual(['wt0', 'wt1'])
  })

  it('applies the same policy to SSH, runtime-owned and WSL workspaces', () => {
    const sshRepo = repo('ssh-repo', 'ssh-1')
    const sshWorktree = worktree('ssh-repo', 'wt-ssh', '/remote/wt-ssh')
    const wslWorktree = worktree('r', 'wt-wsl', '\\\\wsl.localhost\\Ubuntu\\home\\me\\wt')
    const openFiles = [
      tab('wt0'),
      tab('wt-ssh'),
      tab('wt1', { id: 'runtime-tab', runtimeEnvironmentId: 'env-1' }),
      tab('wt-wsl')
    ]
    const state = makeState({
      worktrees: [...worktrees, sshWorktree, wslWorktree],
      repos: [repo('r'), sshRepo],
      openFiles,
      activeWorktreeId: 'wt0',
      trim: true
    })
    expect(watchedIds(state)).toEqual(['wt0'])

    const dirty = makeState({
      worktrees: [...worktrees, sshWorktree, wslWorktree],
      repos: [repo('r'), sshRepo],
      openFiles: openFiles.map((file) => ({ ...file, isDirty: file.worktreeId !== 'wt0' })),
      activeWorktreeId: 'wt0',
      trim: true
    })
    expect(selectEditorExternalWatchTargets(dirty).targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ worktreeId: 'wt-ssh', connectionId: 'ssh-1' }),
        expect.objectContaining({ worktreeId: 'wt1', runtimeEnvironmentId: 'env-1' }),
        expect.objectContaining({ worktreeId: 'wt-wsl' })
      ])
    )
  })

  it('treats folder workspaces like worktrees', () => {
    const folder = (id: string): FolderWorkspace =>
      makeFolderWorkspace({
        id,
        projectGroupId: 'g',
        folderPath: `/folders/${id}`,
        executionHostId: 'local'
      })
    const state = makeState({
      worktrees: [],
      folderWorkspaces: [folder('a'), folder('b')],
      openFiles: [tab('folder:a'), tab('folder:b', { id: 'b' })],
      activeWorktreeId: 'folder:a',
      trim: true
    })
    expect(watchedIds(state)).toEqual(['folder:a'])
    expect(watchedIds({ ...state, activeWorktreeId: 'folder:b' })).toEqual(['folder:b'])
    expect(watchedIds({ ...state, lastVisitedAtByWorktreeId: { 'folder:b': 1 } })).toEqual([
      'folder:a',
      'folder:b'
    ])
  })
})
