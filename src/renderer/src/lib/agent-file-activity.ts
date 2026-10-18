import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { resolveAgentStatusWorktreeId } from '../../../shared/agent-status-worktree-attribution'

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
  'multiedit',
  'multi_edit',
  'notebookedit',
  'patch',
  'powershell',
  'replace',
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

export function isFileMutatingAgentTool(toolName: string | undefined): boolean {
  return !!toolName && FILE_MUTATING_AGENT_TOOLS.has(toolName.toLowerCase())
}

type AgentFileActivityRow = Pick<
  AgentStatusEntry,
  'state' | 'updatedAt' | 'toolName' | 'sessionBoundary'
>

/** Whether a newer row for the same pane proves the agent may have just written files. */
export function isAgentFileActivityTransition(
  previous: AgentFileActivityRow | undefined,
  next: AgentFileActivityRow
): boolean {
  if (!previous || next.updatedAt <= previous.updatedAt) {
    return false
  }
  // Why the previous row: a mutating tool's own start row precedes the write; any later row means it ran.
  if (isFileMutatingAgentTool(previous.toolName)) {
    return true
  }
  // Turn end backstops agents that only report turn-level hooks or unlisted (e.g. MCP) tools.
  return previous.state !== 'done' && next.state === 'done' && next.sessionBoundary !== true
}

export function collectAgentFileActivityWorktreeIds(
  previous: Readonly<Record<string, AgentStatusEntry>>,
  next: Readonly<Record<string, AgentStatusEntry>>,
  getWorktreeIdByTabId: () => Pick<ReadonlyMap<string, string>, 'get'>
): Set<string> {
  const worktreeIds = new Set<string>()
  let worktreeIdByTabId: Pick<ReadonlyMap<string, string>, 'get'> | undefined
  for (const [paneKey, entry] of Object.entries(next)) {
    const previousEntry = Object.hasOwn(previous, paneKey) ? previous[paneKey] : undefined
    if (entry === previousEntry || !isAgentFileActivityTransition(previousEntry, entry)) {
      continue
    }
    worktreeIdByTabId ??= getWorktreeIdByTabId()
    const worktreeId = resolveAgentStatusWorktreeId(entry, worktreeIdByTabId)
    if (worktreeId) {
      worktreeIds.add(worktreeId)
    }
  }
  return worktreeIds
}
