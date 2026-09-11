import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@/hermes'

import { ProjectOverviewRow } from './overview-row'
import type { SidebarProjectTree } from './workspace-groups'

afterEach(cleanup)

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      sidebar: {
        newSessionIn: (label: string) => `New session in ${label}`,
        projects: {
          enter: (label: string) => `Enter ${label}`,
          reorder: (label: string) => `Reorder ${label}`,
          toggle: (label: string, open: boolean) => `${open ? 'Show' : 'Hide'} ${label} sessions`,
          autoDiscovered: 'Auto-discovered'
        }
      }
    }
  })
}))

// `toggleSpy` lets one test observe the open/close call the row makes; every other
// test gets the default no-op.
let toggleSpy = vi.fn()

vi.mock('./model', () => ({
  PROJECT_PREVIEW_COUNT: 3,
  latestProjectSessions: () => [],
  useWorkspaceNodeOpen: () => [false, (...args: unknown[]) => toggleSpy(...args)]
}))

// ProjectMenu (the kebab) has its own dedicated test file — stub it here so
// this file only exercises overview-row's own Tip usage (the disclosure
// toggle) plus the WorkspaceAddButton wiring. ProjectContextMenu (the row's
// right-click wrapper) is stubbed as a pass-through so the row still renders.
vi.mock('./project-menu', () => ({
  ProjectContextMenu: ({ children }: { children: ReactNode }) => children,
  ProjectMenu: () => null
}))

const project = { id: 'p1', label: 'Test D' } as unknown as SidebarProjectTree

const tipTrigger = (el: HTMLElement) => el.closest('[data-slot="tooltip-trigger"]')

describe('ProjectOverviewRow', () => {
  afterEach(() => {
    toggleSpy = vi.fn()
  })

  it('wraps the "new session" add button in a Tip with the project-scoped label', () => {
    render(<ProjectOverviewRow onNewSession={vi.fn()} project={project} />)

    const button = screen.getByRole('button', { name: 'New session in Test D' })
    expect(tipTrigger(button)).toBeTruthy()
  })

  it('wraps the disclosure toggle in a Tip when there are preview sessions', () => {
    render(
      <ProjectOverviewRow
        previewSessions={[{ id: 's1' } as unknown as SessionInfo]}
        project={project}
        renderRows={() => null}
      />
    )

    // Collapsed by default, so the disclosure offers to show the sessions.
    const button = screen.getByRole('button', { name: 'Show Test D sessions' })
    expect(tipTrigger(button)).toBeTruthy()
  })

  it('does not render the disclosure toggle when there is nothing to preview', () => {
    render(<ProjectOverviewRow project={project} />)

    expect(screen.queryByRole('button', { name: 'Show Test D sessions' })).toBeNull()
  })

  it('opens the folder in place when the label is clicked, instead of drilling in', () => {
    // The drill-in this replaced scoped the whole sidebar to one project and hid every
    // other conversation. With no `onEnter`, the label is a second hit target for the
    // caret and nothing navigates.
    const toggle = vi.fn()
    toggleSpy = toggle

    render(
      <ProjectOverviewRow
        previewSessions={[{ id: 's1' } as unknown as SessionInfo]}
        project={project}
        renderRows={() => null}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Test D' }))

    expect(toggle).toHaveBeenCalled()
  })

  it('offers the "new session" add button on Home, which starts one with no folder', () => {
    const home = {
      id: '__no_project__',
      isNoProject: true,
      label: 'Home',
      path: null
    } as unknown as SidebarProjectTree

    const onNewSession = vi.fn()

    render(<ProjectOverviewRow onNewSession={onNewSession} project={home} />)
    fireEvent.click(screen.getByRole('button', { name: 'New session in Home' }))

    expect(onNewSession).toHaveBeenCalledWith(null)
  })

  it('tags the row with data-sessions-project so a skin can target one project', () => {
    const { container } = render(<ProjectOverviewRow project={project} />)

    expect(container.querySelector('[data-sessions-project="p1"]')).toBeTruthy()
  })

  it('explicit projects keep the folder-library glyph and a plain accessible name', () => {
    const explicit = { id: 'p1', label: 'Explicit' } as unknown as SidebarProjectTree

    const { container } = render(<ProjectOverviewRow project={explicit} />)

    expect(container.querySelector('.codicon-folder-library')).toBeTruthy()
    expect(container.querySelector('.codicon-repo')).toBeNull()
    // The name alone — the caret owns the show/hide verb, so the two controls in the
    // row never answer to the same accessible name.
    expect(screen.getByRole('button', { name: 'Explicit' })).toBeTruthy()
  })

  it('auto-discovered repos get the repo glyph, an "Auto-discovered" tooltip, and an accessible name that says so', () => {
    const auto = { id: '/Users/dev/my-repo', label: 'my-repo', isAuto: true } as unknown as SidebarProjectTree

    const { container } = render(<ProjectOverviewRow project={auto} />)

    expect(container.querySelector('.codicon-repo')).toBeTruthy()
    expect(container.querySelector('.codicon-folder-library')).toBeNull()

    const link = screen.getByRole('button', { name: 'my-repo (Auto-discovered)' })
    expect(tipTrigger(link)).toBeTruthy()
  })
})
