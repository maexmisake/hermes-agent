import { describe, expect, it } from 'vitest'

import { shouldShowIntro, shouldShowSessionSetup } from './intro-visibility'

const showing = {
  activeSessionId: null,
  auxiliaryWindow: false,
  enabled: true,
  freshDraftReady: true,
  messagesEmpty: true,
  primary: true,
  routedSessionView: false,
  selectedSessionId: null
} as const

describe('shouldShowIntro', () => {
  it('shows on a fresh draft in the primary window', () => {
    expect(shouldShowIntro(showing)).toBe(true)
  })

  it('hides when the Appearance toggle is off', () => {
    expect(shouldShowIntro({ ...showing, enabled: false })).toBe(false)
  })

  it('keeps the toggle authoritative over every other clause', () => {
    // Off means off: no window, session, or draft state re-enables the splash.
    const inputs = [
      { ...showing, auxiliaryWindow: true, enabled: false },
      { ...showing, enabled: false, freshDraftReady: false },
      { ...showing, enabled: false, primary: false },
      { ...showing, enabled: false, messagesEmpty: false }
    ]

    for (const input of inputs) {
      expect(shouldShowIntro(input)).toBe(false)
    }
  })

  it('hides on surfaces that are not an empty primary draft', () => {
    expect(shouldShowIntro({ ...showing, primary: false })).toBe(false)
    expect(shouldShowIntro({ ...showing, auxiliaryWindow: true })).toBe(false)
    expect(shouldShowIntro({ ...showing, freshDraftReady: false })).toBe(false)
    expect(shouldShowIntro({ ...showing, routedSessionView: true })).toBe(false)
    expect(shouldShowIntro({ ...showing, selectedSessionId: 'session-1' })).toBe(false)
    expect(shouldShowIntro({ ...showing, activeSessionId: 'session-1' })).toBe(false)
    expect(shouldShowIntro({ ...showing, messagesEmpty: false })).toBe(false)
  })
})

describe('shouldShowSessionSetup', () => {
  // The same fresh draft, with the intro turned off in Appearance.
  const introOff = { ...showing, enabled: false }

  it('shows on a fresh primary draft even when the Appearance intro toggle is off', () => {
    expect(shouldShowIntro(introOff)).toBe(false)
    expect(shouldShowSessionSetup(introOff)).toBe(true)
  })

  it('hides once the chat has started or the surface is not an empty primary draft', () => {
    expect(shouldShowSessionSetup({ ...introOff, messagesEmpty: false })).toBe(false)
    expect(shouldShowSessionSetup({ ...introOff, activeSessionId: 'session-1' })).toBe(false)
    expect(shouldShowSessionSetup({ ...introOff, selectedSessionId: 'session-1' })).toBe(false)
    expect(shouldShowSessionSetup({ ...introOff, auxiliaryWindow: true })).toBe(false)
    expect(shouldShowSessionSetup({ ...introOff, primary: false })).toBe(false)
  })
})
