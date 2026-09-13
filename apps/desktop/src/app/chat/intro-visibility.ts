/**
 * Whether the empty-chat intro splash renders.
 *
 * The splash is the full-height empty state of the primary chat: it belongs to
 * a fresh draft in the main window and nothing else. Auxiliary and non-primary
 * windows are scratch surfaces, a routed or active session already owns the
 * view, and any transcript at all means the conversation started.
 *
 * `enabled` is the user's Appearance toggle and outranks every other clause:
 * turning the splash off never depends on which window asks.
 */
export function shouldShowIntro(input: {
  activeSessionId: null | string
  auxiliaryWindow: boolean
  enabled: boolean
  freshDraftReady: boolean
  messagesEmpty: boolean
  primary: boolean
  routedSessionView: boolean
  selectedSessionId: null | string
}): boolean {
  return (
    input.enabled &&
    input.primary &&
    !input.auxiliaryWindow &&
    input.freshDraftReady &&
    !input.routedSessionView &&
    !input.selectedSessionId &&
    !input.activeSessionId &&
    input.messagesEmpty
  )
}

/**
 * Whether the new-chat setup bubbles (project / workspace / branch) render above the
 * composer: the same "this chat has not started yet" condition as the splash, minus the
 * Appearance toggle. Turning the wordmark off is about decoration; the bubbles are how a
 * chat is told where to work before it starts. Once a message is sent they are gone.
 */
export function shouldShowSessionSetup(input: {
  activeSessionId: null | string
  auxiliaryWindow: boolean
  freshDraftReady: boolean
  messagesEmpty: boolean
  primary: boolean
  routedSessionView: boolean
  selectedSessionId: null | string
}): boolean {
  return shouldShowIntro({ ...input, enabled: true })
}
