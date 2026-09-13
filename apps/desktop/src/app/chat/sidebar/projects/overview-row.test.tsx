import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@/hermes'
import { revealSidebarProject } from '@/store/layout'

import { ProjectOverviewRow } from './overview-row'
import type { SidebarProjectTree } from './workspace-groups'

const folder = vi.hoisted(() => ({ open: false }))

afterEach(() => {
  cleanup()
  folder.open = false
})

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      sidebar: {
        newSessionIn: (label: string) => `New session in ${label}`,
        projects: {
          reorder: (label: string) => `Reorder ${label}`,
          toggle: (label: string, open: boolean) => `${open ? 'Show' : 'Hide'} ${label} sessions`,
          autoDiscovered: 'Auto-discovered'
        }
      }
    }
  })
}))

// The fade is its own primitive (it measures overflow); here the name is plain text.
vi.mock('@/components/ui/fade-text', () => ({
  FadeText: ({ children }: { children: ReactNode }) => <span>{children}</span>
}))

vi.mock('./model', () => ({
  latestProjectSessions: () => [],
  useWorkspaceNodeOpen: () => [folder.open, vi.fn()]
}))

// ProjectMenu (the kebab) has its own dedicated test file — stub it here so
// this file only exercises overview-row's own Tip usage plus the
// WorkspaceAddButton wiring. ProjectContextMenu (the row's right-click
// wrapper) is stubbed as a pass-through so the row still renders.
vi.mock('./project-menu', () => ({
  ProjectContextMenu: ({ children }: { children: ReactNode }) => children,
  ProjectMenu: () => null
}))

const project = { id: 'p1', label: 'Test D' } as unknown as SidebarProjectTree
const auto = { id: '/Users/dev/my-repo', label: 'my-repo', isAuto: true } as unknown as SidebarProjectTree
const chats = [{ id: 's1' } as unknown as SessionInfo]

const tipTrigger = (el: HTMLElement) => el.closest('[data-slot="tooltip-trigger"]')

describe('ProjectOverviewRow', () => {
  it('wraps the "new session" add button in a Tip with the project-scoped label', () => {
    render(<ProjectOverviewRow onNewSession={vi.fn()} project={project} />)

    const button = screen.getByRole('button', { name: 'New session in Test D' })
    expect(tipTrigger(button)).toBeTruthy()
  })

  it('has one disclosure when the project has chats: its name, which says whether the folder is open', () => {
    render(<ProjectOverviewRow previewSessions={chats} project={project} renderRows={() => null} />)

    const toggles = screen.getAllByRole('button', { name: 'Show Test D sessions' })

    expect(toggles).toHaveLength(1)
    expect(toggles[0]?.getAttribute('aria-expanded')).toBe('false')
  })

  it('does not render a disclosure when there is nothing to open', () => {
    render(<ProjectOverviewRow project={project} />)

    expect(screen.queryByRole('button', { name: 'Show Test D sessions' })).toBeNull()
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

  it('names an empty explicit project in plain text, with the folder-library glyph', () => {
    const explicit = { id: 'p1', label: 'Explicit' } as unknown as SidebarProjectTree

    const { container } = render(<ProjectOverviewRow project={explicit} />)

    expect(container.querySelector('.codicon-folder-library')).toBeTruthy()
    expect(container.querySelector('.codicon-repo')).toBeNull()
    expect(screen.getByText('Explicit')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Explicit' })).toBeNull()
  })

  it('auto-discovered repos get the repo glyph, an "Auto-discovered" tooltip, and tell screen readers so', () => {
    const { container } = render(<ProjectOverviewRow project={auto} />)

    expect(container.querySelector('.codicon-repo')).toBeTruthy()
    expect(container.querySelector('.codicon-folder-library')).toBeNull()
    expect(tipTrigger(screen.getByText('my-repo'))).toBeTruthy()
    expect(screen.getByText('(Auto-discovered)', { exact: false })).toBeTruthy()
  })

  it('an auto-discovered folder with chats says so in its disclosure name', () => {
    render(<ProjectOverviewRow previewSessions={chats} project={auto} renderRows={() => null} />)

    expect(screen.getByRole('button', { name: 'Show my-repo sessions (Auto-discovered)' })).toBeTruthy()
  })

  it('asks for the complete chat list while its folder is open', () => {
    folder.open = true
    const onNeedAllSessions = vi.fn()

    render(
      <ProjectOverviewRow
        onNeedAllSessions={onNeedAllSessions}
        previewSessions={chats}
        project={project}
        renderRows={() => null}
      />
    )

    expect(onNeedAllSessions).toHaveBeenCalledWith('p1')
  })

  it('scrolls into view when the command palette goes to it', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView

    render(<ProjectOverviewRow project={project} />)
    act(() => revealSidebarProject('p1'))

    expect(scrollIntoView).toHaveBeenCalled()
  })
})
