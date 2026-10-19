import type { ParsedAgentStatusPayload } from './agent-status-types'
import { normalizeHookEventName } from './agent-hook-listener/provider-event-names'
import { readFirstString } from './agent-hook-listener/interactive-tool'

// Lowercased hook tool names (see agent-hook-listener/tool-input-preview.ts) that can write files.
const FILE_MUTATING_AGENT_TOOLS: ReadonlySet<string> = new Set([
  'apply_patch',
  'bash',
  'create',
  'delete',
  'delete_file',
  'edit',
  'edit_file',
  'exec',
  'exec_command',
  'execute',
  'execute_code',
  'local_shell',
  'multi_replace_file_content',
  'multiedit',
  'multi_edit',
  'notebookedit',
  'patch',
  'powershell',
  'replace',
  'replace_file_content',
  'run_command',
  'run_shell_command',
  'run_terminal_cmd',
  'run_terminal_command',
  'search_replace',
  'shell',
  'shell_command',
  'str_replace',
  'str_replace_editor',
  'terminal',
  'write',
  'write_file',
  'write_to_file'
])

// Normalized (normalizeHookEventName) events that report a tool call has finished, success or failure.
const TOOL_COMPLETION_EVENTS: ReadonlySet<string> = new Set([
  'after_tool',
  'post_tool',
  'post_tool_call',
  'post_tool_use',
  'post_tool_use_failure',
  'tool_execution_end'
])

export function isFileMutatingAgentTool(toolName: string | undefined): boolean {
  return !!toolName && FILE_MUTATING_AGENT_TOOLS.has(toolName.toLowerCase())
}

type FileActivityRow = Pick<
  ParsedAgentStatusPayload,
  'state' | 'sessionBoundary' | 'turnCompletedAt' | 'fileActivityAt'
>

/** Whether this hook event is evidence the agent may just have written files in its worktree. */
export function isAgentFileActivityEvent(input: {
  eventName: unknown
  /** Tool names the event names; any one mutating tool qualifies. */
  toolNames: readonly (string | undefined)[]
  payload: FileActivityRow
  previous: FileActivityRow | undefined
}): boolean {
  const { payload, previous } = input
  if (
    TOOL_COMPLETION_EVENTS.has(normalizeHookEventName(input.eventName)) &&
    input.toolNames.some(isFileMutatingAgentTool)
  ) {
    return true
  }
  // Turn end backstops turn-level-only agents and tools not listed above (e.g. MCP).
  if (payload.state === 'done' && payload.sessionBoundary !== true) {
    return previous?.state !== 'done'
  }
  return (
    payload.turnCompletedAt !== undefined && payload.turnCompletedAt !== previous?.turnCompletedAt
  )
}

/** Stamps the pane's file-activity clock, carrying the previous value forward on rows without new evidence. */
export function withAgentFileActivity(
  payload: ParsedAgentStatusPayload,
  input: {
    eventName: unknown
    hookToolName: string | undefined
    previous: FileActivityRow | undefined
    now: number
  }
): ParsedAgentStatusPayload {
  const isActivity = isAgentFileActivityEvent({
    eventName: input.eventName,
    toolNames: [input.hookToolName, payload.toolName],
    payload,
    previous: input.previous
  })
  const previousAt = input.previous?.fileActivityAt
  // Why max: a host clock step backwards must still read as a change to subscribers.
  const fileActivityAt = isActivity
    ? Math.max(input.now, (previousAt ?? 0) + 1)
    : (payload.fileActivityAt ?? previousAt)
  return fileActivityAt === undefined ? payload : { ...payload, fileActivityAt }
}

export function stampAgentFileActivity(
  payload: ParsedAgentStatusPayload,
  eventName: unknown,
  hookPayload: Record<string, unknown>,
  previous: FileActivityRow | undefined
): ParsedAgentStatusPayload {
  return withAgentFileActivity(payload, {
    eventName,
    hookToolName: readFirstString(hookPayload, ['tool_name', 'toolName', 'name']),
    previous,
    now: Date.now()
  })
}
