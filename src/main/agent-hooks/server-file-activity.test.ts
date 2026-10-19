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
})
