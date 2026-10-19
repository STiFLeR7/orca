import type { AgentFileActivityKind, ParsedAgentStatusPayload } from './agent-status-types'
import { normalizeHookEventName } from './agent-hook-listener/provider-event-names'

// Hook tool names that write files, compared lowercased with non-alphanumerics stripped
// (Edit, write_file, WriteFile and fs_write all fold the same way).
const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set([
  'applypatch',
  'create',
  'createfile',
  'delete',
  'deletefile',
  'edit',
  'editfile',
  'fswrite',
  'movefile',
  'multiedit',
  'multireplacefilecontent',
  'notebookedit',
  'patch',
  'renamefile',
  'replace',
  'replacefilecontent',
  'searchreplace',
  'strreplace',
  'strreplacebasededittool',
  'strreplaceeditor',
  'strreplacefile',
  'undoedit',
  'write',
  'writefile',
  'writetofile'
])

// Shell tools: they may write files, but most runs only read.
const COMMAND_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'exec',
  'execcommand',
  'execute',
  'executebash',
  'executecode',
  'localshell',
  'powershell',
  'runcommand',
  'runshellcommand',
  'runterminalcmd',
  'runterminalcommand',
  'shell',
  'shellcommand',
  'terminal'
])

// Normalized (normalizeHookEventName) events that report a tool call has finished, success or failure.
const TOOL_COMPLETION_EVENTS: ReadonlySet<string> = new Set([
  'after_tool',
  'post_tool',
  'post_tool_call',
  'post_tool_use',
  'post_tool_use_failure',
  'tool.result',
  'tool_execution_end'
])

function foldToolName(toolName: string): string {
  return toolName.replaceAll(/[^a-z0-9]/gi, '').toLowerCase()
}

export function classifyAgentTool(
  toolName: string | undefined
): Exclude<AgentFileActivityKind, 'turn'> | null {
  if (!toolName) {
    return null
  }
  const folded = foldToolName(toolName)
  return FILE_EDIT_TOOLS.has(folded) ? 'edit' : COMMAND_TOOLS.has(folded) ? 'command' : null
}

export function isFileMutatingAgentTool(toolName: string | undefined): boolean {
  return classifyAgentTool(toolName) !== null
}

type FileActivityRow = Pick<
  ParsedAgentStatusPayload,
  'state' | 'sessionBoundary' | 'turnCompletedAt' | 'fileActivityAt' | 'fileActivityKind'
>

/** What kind of file activity this hook event is evidence of, if any. */
export function classifyAgentFileActivityEvent(input: {
  eventName: unknown
  /** The tool the event itself names; a cached row's tool may belong to another agent. */
  toolName: string | undefined
  payload: FileActivityRow
  previous: FileActivityRow | undefined
}): AgentFileActivityKind | null {
  const { payload, previous } = input
  if (TOOL_COMPLETION_EVENTS.has(normalizeHookEventName(input.eventName))) {
    const toolKind = classifyAgentTool(input.toolName)
    if (toolKind) {
      return toolKind
    }
  }
  // Turn end backstops turn-level-only agents and tools not listed above (e.g. MCP).
  if (payload.state === 'done' && payload.sessionBoundary !== true) {
    // Why: a background turn already stamped when its lead ended; its all-clear repeats that turn.
    const sameBackgroundTurn =
      payload.turnCompletedAt !== undefined && payload.turnCompletedAt === previous?.turnCompletedAt
    return previous?.state !== 'done' && !sameBackgroundTurn ? 'turn' : null
  }
  return payload.turnCompletedAt !== undefined &&
    payload.turnCompletedAt !== previous?.turnCompletedAt
    ? 'turn'
    : null
}

export type AgentFileActivity = Pick<
  ParsedAgentStatusPayload,
  'fileActivityAt' | 'fileActivityKind'
>

/** The hook event being admitted into the pane's status row. */
type FileActivityEvent = {
  hookEventName?: string
  hookToolName?: string
  isReplay?: boolean
  payload: FileActivityRow & Pick<ParsedAgentStatusPayload, 'toolName'>
}

/** The pane's file-activity clock after admitting `event` on top of the stored `previous` row.
 *  Called only where the host's status store accepts a row, so every transport and every agent
 *  sharing the pane read and advance one clock. */
export function resolveAgentFileActivity(
  event: FileActivityEvent,
  previous: FileActivityRow | undefined,
  now: number
): AgentFileActivity {
  const previousAt = previous?.fileActivityAt
  const incomingAt = event.payload.fileActivityAt
  // Why skip replays: a reconnect re-sends rows the store already counted.
  const kind =
    event.isReplay === true
      ? null
      : classifyAgentFileActivityEvent({
          eventName: event.hookEventName,
          // Why: the event's own tool wins; a child's hook may re-send the lead's cached tool name.
          toolName: event.hookToolName ?? event.payload.toolName,
          payload: event.payload,
          previous
        })
  if (kind) {
    // Why max: the clock only moves forward, even across a host clock step back.
    return {
      fileActivityAt: Math.max(now, (previousAt ?? 0) + 1, incomingAt ?? 0),
      fileActivityKind: kind
    }
  }
  // An upstream host (a runtime server) may already have stamped the row.
  const source =
    incomingAt !== undefined && (previousAt === undefined || incomingAt > previousAt)
      ? event.payload
      : previous
  return source?.fileActivityAt === undefined
    ? {}
    : {
        fileActivityAt: source.fileActivityAt,
        ...(source.fileActivityKind ? { fileActivityKind: source.fileActivityKind } : {})
      }
}

export function withAgentFileActivity<T extends { payload: ParsedAgentStatusPayload }>(
  row: T,
  activity: AgentFileActivity
): T {
  if (
    row.payload.fileActivityAt === activity.fileActivityAt &&
    row.payload.fileActivityKind === activity.fileActivityKind
  ) {
    return row
  }
  const { fileActivityAt: _at, fileActivityKind: _kind, ...rest } = row.payload
  return { ...row, payload: { ...rest, ...activity } }
}
