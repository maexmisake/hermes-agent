import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HermesGitBranch } from '@/global'
import type { ProjectInfo, SessionInfo } from '@/hermes'
import type { GroupInfo } from '@/types/hermes'

vi.mock('@/store/coding-status', () => ({ isGitRepoPath: vi.fn() }))

vi.mock('@/store/notifications', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  notify: vi.fn(),
  notifyError: vi.fn()
}))

vi.mock('@/store/projects', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  listRepoBranches: vi.fn(),
  moveSessionWorkspace: vi.fn(),
  pickProjectFolder: vi.fn(),
  startWorkInRepo: vi.fn(),
  switchBranchInRepo: vi.fn()
}))

const coding = await import('@/store/coding-status')
const isGitRepoPath = vi.mocked(coding.isGitRepoPath)

const projectsStore = await import('@/store/projects')
const listRepoBranches = vi.mocked(projectsStore.listRepoBranches)
const moveSessionWorkspace = vi.mocked(projectsStore.moveSessionWorkspace)
const pickProjectFolder = vi.mocked(projectsStore.pickProjectFolder)
const startWorkInRepo = vi.mocked(projectsStore.startWorkInRepo)
const switchBranchInRepo = vi.mocked(projectsStore.switchBranchInRepo)
const { $groups, $projects } = projectsStore

const { SessionContextChip } = await import('./session-context-chip')

const session = (overrides: Partial<SessionInfo> = {}): SessionInfo =>
  ({
    cwd: '/repo/app',
    git_branch: 'main',
    git_repo_root: '/repo/app',
    id: 'sess-1',
    ...overrides
  }) as SessionInfo

const project = (overrides: Partial<ProjectInfo> = {}): ProjectInfo =>
  ({
    archived: false,
    folders: [{ path: '/repo/app' }],
    id: 'p_app',
    name: 'App',
    primary_path: '/repo/app',
    ...overrides
  }) as ProjectInfo

const branch = (overrides: Partial<HermesGitBranch> = {}): HermesGitBranch => ({
  checkedOut: false,
  isDefault: false,
  isRemote: false,
  name: 'feature',
  worktreePath: null,
  ...overrides
})

beforeEach(() => {
  vi.clearAllMocks()
  $projects.set([])
  $groups.set([])
  isGitRepoPath.mockResolvedValue(false)
  listRepoBranches.mockResolvedValue([])
  moveSessionWorkspace.mockResolvedValue()
  switchBranchInRepo.mockResolvedValue()
  startWorkInRepo.mockResolvedValue(null)
})

afterEach(cleanup)

const openChip = () => fireEvent.keyDown(screen.getByRole('button', { name: /^App|^app|^Tidying/ }), { key: 'Enter' })

describe('the context chip beside a chat title', () => {
  it('reads the project it is FILED under, not the folder it runs in', () => {
    // The two can differ, and that is the point of filing: a chat can be kept with
    // the App project while running in a scratch folder. The caption follows the
    // filing, because that is the answer to "what is this chat about".
    $projects.set([project()])

    render(<SessionContextChip session={session({ cwd: '/scratch/vps', project_id: 'p_app' })} />)

    expect(screen.getByRole('button', { name: 'App, on main' })).toBeTruthy()
  })

  it('names a group over a project, matching where the sidebar drew it', () => {
    $projects.set([project()])
    $groups.set([{ id: 'g_1', name: 'Tidying' } as GroupInfo])

    render(<SessionContextChip session={session({ group_id: 'g_1', project_id: 'p_app' })} />)

    expect(screen.getByRole('button', { name: 'Tidying, on main' })).toBeTruthy()
  })

  it('falls back to the folder name when nothing filed it', () => {
    render(<SessionContextChip session={session()} />)

    expect(screen.getByRole('button', { name: 'app, on main' })).toBeTruthy()
  })

  it('renders nothing at all for a chat with no place and no branch', () => {
    const { container } = render(<SessionContextChip session={session({ cwd: '', git_branch: '', git_repo_root: '' })} />)

    // An empty chip would be a caption saying nothing. The title stands alone.
    expect(container.textContent).toBe('')
  })

  it('shows the full path for inspection, which is what it is mostly opened for', async () => {
    $projects.set([project()])
    render(<SessionContextChip session={session({ cwd: '/repo/app/packages/ui', project_id: 'p_app' })} />)

    openChip()

    expect(await screen.findByText('/repo/app/packages/ui')).toBeTruthy()
  })

  it('switches branch in place rather than re-homing the chat', async () => {
    isGitRepoPath.mockResolvedValue(true)
    listRepoBranches.mockResolvedValue([branch({ isDefault: true, name: 'main' }), branch({ name: 'feature' })])

    render(<SessionContextChip session={session()} />)

    await waitFor(() => expect(listRepoBranches).toHaveBeenCalledWith('/repo/app'))

    openChip()
    fireEvent.keyDown(await screen.findByRole('menuitem', { name: /Branch/ }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /feature/ }))

    // The conversation is already anchored here: changing branch means this
    // checkout, not a new folder underneath it.
    await waitFor(() => expect(switchBranchInRepo).toHaveBeenCalledWith('/repo/app', 'feature'))
    expect(moveSessionWorkspace).not.toHaveBeenCalled()
  })

  it('asks before changing the folder, because that re-homes a live agent', async () => {
    pickProjectFolder.mockResolvedValue('/other/repo')
    render(<SessionContextChip session={session()} />)

    openChip()
    fireEvent.click(await screen.findByRole('menuitem', { name: /Change folder/ }))

    // Filing never asks. This one does: the chat's terminal and file tools follow.
    await waitFor(() => expect(screen.getByText(/Move this chat to another folder/)).toBeTruthy())
    expect(moveSessionWorkspace).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Change folder…' }))

    await waitFor(() => expect(moveSessionWorkspace).toHaveBeenCalledWith('sess-1', '/other/repo', undefined))
  })
})
