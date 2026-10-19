import type { AgentFileActivityKind, ParsedAgentStatusPayload } from './agent-status-types'
import { normalizeHookEventName } from './agent-hook-listener/provider-event-names'
import { readFirstString } from './agent-hook-listener/interactive-tool'

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
  const kind = classifyAgentFileActivityEvent({
    eventName: input.eventName,
    // Why: the event's own tool wins; a child's hook may re-send the lead's cached tool name.
    toolName: input.hookToolName ?? payload.toolName,
    payload,
    previous: input.previous
  })
  const previousAt = input.previous?.fileActivityAt
  if (kind) {
    // Why max: a host clock step backwards must still read as a change to subscribers.
    return {
      ...payload,
      fileActivityAt: Math.max(input.now, (previousAt ?? 0) + 1),
      fileActivityKind: kind
    }
  }
  const carried = payload.fileActivityAt !== undefined ? payload : input.previous
  return carried?.fileActivityAt === undefined
    ? payload
    : {
        ...payload,
        fileActivityAt: carried.fileActivityAt,
        ...(carried.fileActivityKind ? { fileActivityKind: carried.fileActivityKind } : {})
      }
}

export function stampAgentFileActivity(
  payload: ParsedAgentStatusPayload,
  eventName: unknown,
  hookPayload: Record<string, unknown>,
  previous: FileActivityRow | undefined
): ParsedAgentStatusPayload {
  return withAgentFileActivity(payload, {
    eventName,
    hookToolName: readFirstString(hookPayload, ['tool_name', 'toolName', 'tool', 'name']),
    previous,
    now: Date.now()
  })
}

/** A relay keeps per-agent listener state; the pane's stamp must still only move forward
 *  when agents alternate in it. `providerPreviousAt` is the provider state's prior stamp. */
export function reconcileRelayFileActivity(
  payload: ParsedAgentStatusPayload,
  providerPreviousAt: number | undefined,
  canonical: Pick<ParsedAgentStatusPayload, 'fileActivityAt' | 'fileActivityKind'> | undefined
): ParsedAgentStatusPayload {
  const canonicalAt = canonical?.fileActivityAt
  const eventAt = payload.fileActivityAt
  if (canonicalAt === undefined || (eventAt !== undefined && eventAt > canonicalAt)) {
    return payload
  }
  if (eventAt !== undefined && eventAt !== providerPreviousAt) {
    return { ...payload, fileActivityAt: canonicalAt + 1 }
  }
  return {
    ...payload,
    fileActivityAt: canonicalAt,
    ...(canonical?.fileActivityKind ? { fileActivityKind: canonical.fileActivityKind } : {})
  }
}
