import { describe, expect, it } from 'vitest'
import { PANE_KEY } from '../shared/agent-hook-listener-test-harness'
import { buildRelayHookEnvelope } from './agent-hook-envelope-build'

describe('buildRelayHookEnvelope', () => {
  it('forwards the tool the hook event names so the receiving store can classify it', () => {
    const envelope = buildRelayHookEnvelope(
      {
        paneKey: PANE_KEY,
        connectionId: null,
        hookEventName: 'PostToolUse',
        hookToolName: 'Edit',
        payload: { state: 'working', prompt: '', toolName: 'Bash' }
      },
      'claude'
    )
    expect(envelope).toMatchObject({ hookEventName: 'PostToolUse', hookToolName: 'Edit' })
  })
})
