import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

beforeEach(() => {
  _internals.resetCachesForTests()
})
afterEach(() => {
  vi.restoreAllMocks()
})

async function postClaudeHook(
  server: AgentHookServer,
  payload: Record<string, unknown>
): Promise<void> {
  const env = server.buildPtyEnv()
  await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify(buildBody(payload))
  })
}

describe('agent file-activity stamp through the hook server', () => {
  it('publishes the stamp on a finished write and carries it on later rows', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const stamps: (number | undefined)[] = []
      server.setListener((event) => {
        stamps.push(event.payload.fileActivityAt)
      })
      await postClaudeHook(server, { hook_event_name: 'UserPromptSubmit', prompt: 'fix' })
      const toolInput = { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }
      await postClaudeHook(server, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: toolInput
      })
      await postClaudeHook(server, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: toolInput,
        tool_response: {}
      })
      await postClaudeHook(server, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/repo/b.ts' }
      })
      const [prompt, preEdit, postEdit, preRead] = stamps
      expect(stamps).toHaveLength(4)
      expect(prompt).toBeUndefined()
      expect(preEdit).toBeUndefined()
      expect(postEdit).toEqual(expect.any(Number))
      expect(preRead).toBe(postEdit)
    } finally {
      server.stop()
    }
  })

  it('publishes a lead write that finishes behind a child permission prompt', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const stamps: (number | undefined)[] = []
      server.setListener((event) => {
        stamps.push(event.payload.fileActivityAt)
      })
      await postClaudeHook(server, { hook_event_name: 'UserPromptSubmit', prompt: 'guarded' })
      await postClaudeHook(server, {
        hook_event_name: 'PermissionRequest',
        agent_id: 'a-blocked',
        agent_type: 'general-purpose',
        tool_name: 'Bash',
        tool_input: { command: 'false' }
      })
      const beforeWrite = stamps.length
      await postClaudeHook(server, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/repo/a.ts', content: 'x' },
        tool_response: {}
      })
      expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'waiting', toolName: 'Bash' })
      expect(stamps.length).toBeGreaterThan(beforeWrite)
      expect(stamps.at(-1)).toEqual(expect.any(Number))
    } finally {
      server.stop()
    }
  })

  it('keeps a relay-stamped value from an SSH host', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const listener = vi.fn()
      server.setListener(listener)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          env: 'remote',
          version: '1',
          payload: {
            state: 'working',
            paneKey: PANE,
            updatedAt: Date.now(),
            agentType: 'claude',
            fileActivityAt: 1234
          }
        },
        'conn-1'
      )
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ fileActivityAt: 1234 }) })
      )
    } finally {
      server.stop()
    }
  })

  it('stamps relayed hooks in the one store, moving forward as agents alternate in a pane', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const stamps: (number | undefined)[] = []
      server.setListener((event) => {
        stamps.push(event.payload.fileActivityAt)
      })
      let clock = Date.now()
      const relay = (
        agentType: 'claude' | 'codex',
        hookEventName: string,
        hookToolName?: string
      ): number | undefined => {
        clock += 1000
        vi.setSystemTime(clock)
        server.ingestRemote(
          {
            paneKey: PANE,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            env: 'remote',
            version: '1',
            source: agentType,
            hookEventName,
            ...(hookToolName ? { hookToolName } : {}),
            payload: {
              state: hookEventName === 'Stop' ? 'done' : 'working',
              paneKey: PANE,
              updatedAt: clock,
              agentType
            }
          },
          'conn-1'
        )
        return stamps.at(-1)
      }
      vi.useFakeTimers({ toFake: ['Date'] })
      relay('claude', 'UserPromptSubmit')
      const claudeWrite = relay('claude', 'PostToolUse', 'Edit')
      expect(claudeWrite).toEqual(expect.any(Number))
      const stopped = relay('claude', 'Stop')
      relay('codex', 'UserPromptSubmit')
      const codexWrite = relay('codex', 'PostToolUse', 'apply_patch')
      expect(stopped).toBeGreaterThan(claudeWrite ?? 0)
      expect(codexWrite).toBeGreaterThan(claudeWrite ?? 0)
      expect(relay('claude', 'PreToolUse', 'Read')).toBe(codexWrite)
      // A child's read re-sending the lead's cached shell tool is not a write.
      expect(relay('claude', 'PostToolUse', 'Read')).toBe(codexWrite)
    } finally {
      vi.useRealTimers()
      server.stop()
    }
  })

  it('keeps the classification-only tool name off stored and emitted rows', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const emitted: Record<string, unknown>[] = []
      server.setListener((event) => {
        emitted.push({ ...event })
      })
      await postClaudeHook(server, { hook_event_name: 'UserPromptSubmit', prompt: 'fix' })
      await postClaudeHook(server, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' },
        tool_response: {}
      })
      expect(emitted.at(-1)?.payload).toMatchObject({ fileActivityKind: 'edit' })
      for (const row of emitted) {
        expect(row).not.toHaveProperty('hookToolName')
      }
      expect(server.getStatusSnapshot()[0]).not.toHaveProperty('hookToolName')
    } finally {
      server.stop()
    }
  })

  it('carries the stamp across a session-identity-only row', () => {
    const server = new AgentHookServer()
    const listener = vi.fn()
    server.setListener(listener)
    const base = { paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1', source: 'pi' }
    server.ingestRemote(
      {
        ...base,
        hookEventName: 'tool_execution_end',
        hookToolName: 'write',
        payload: { state: 'working', prompt: '', agentType: 'pi' }
      },
      null
    )
    const stamped = listener.mock.lastCall?.[0]?.payload.fileActivityAt
    expect(stamped).toEqual(expect.any(Number))
    server.ingestRemote(
      {
        ...base,
        providerSession: { key: 'session_id', id: 'pi-session', transcriptPath: '/tmp/s.jsonl' },
        providerSessionOnly: true,
        payload: { state: 'done', prompt: '', agentType: 'pi' }
      },
      null
    )
    expect(listener.mock.lastCall?.[0]).toMatchObject({
      providerSessionOnly: true,
      payload: { fileActivityAt: stamped, fileActivityKind: 'edit' }
    })
  })
})
