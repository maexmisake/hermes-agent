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
  setSessionGroup: vi.fn(),
  startWorkInRepo: vi.fn()
}))

const coding = await import('@/store/coding-status')
const isGitRepoPath = vi.mocked(coding.isGitRepoPath)

const projectsStore = await import('@/store/projects')
const listRepoBranches = vi.mocked(projectsStore.listRepoBranches)
const moveSessionWorkspace = vi.mocked(projectsStore.moveSessionWorkspace)
const pickProjectFolder = vi.mocked(projectsStore.pickProjectFolder)
const startWorkInRepo = vi.mocked(projectsStore.startWorkInRepo)
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
  startWorkInRepo.mockResolvedValue(null)
})

afterEach(cleanup)

const openChip = () => fireEvent.keyDown(screen.getByRole('button', { name: /, on main$/ }), { key: 'Enter' })
const openSub = async (name: RegExp) => fireEvent.keyDown(await screen.findByRole('menuitem', { name }), { key: 'Enter' })

describe('the context chip beside a chat title', () => {
  it('names the project that owns the chat folder', () => {
    // One answer, derived from the folder. There is no stored id that could make this
    // say "App" while the chat's files are somewhere else entirely.
    $projects.set([project()])

    render(<SessionContextChip session={session()} />)

    expect(screen.getByRole('button', { name: 'App, on main' })).toBeTruthy()
  })

  it('falls back to the folder name when no project claims it', () => {
    render(<SessionContextChip session={session({ cwd: '/scratch/vps', git_repo_root: '' })} />)

    expect(screen.getByRole('button', { name: 'vps, on main' })).toBeTruthy()
  })

  it('renders nothing at all for a chat with no folder and no branch', () => {
    const { container } = render(
      <SessionContextChip session={session({ cwd: '', git_branch: '', git_repo_root: '' })} />
    )

    // An empty chip would be a caption saying nothing. The title stands alone.
    expect(container.textContent).toBe('')
  })

  it('shows the full path for inspection, and the group when there is one', async () => {
    $projects.set([project()])
    $groups.set([{ id: 'g_1', name: 'Tidying' } as GroupInfo])

    render(<SessionContextChip session={session({ cwd: '/repo/app/packages/ui', group_id: 'g_1' })} />)

    openChip()

    expect(await screen.findByText('/repo/app/packages/ui')).toBeTruthy()
    // A group is the other axis: it tidies the chat without moving it, so both facts
    // are true at once and the menu says both.
    expect(await screen.findByText('In Tidying')).toBeTruthy()
  })

  it('never switches a shared checkout to reach a branch', async () => {
    isGitRepoPath.mockResolvedValue(true)
    listRepoBranches.mockResolvedValue([branch({ isDefault: true, name: 'main' }), branch({ name: 'feature' })])
    startWorkInRepo.mockResolvedValue({ branch: 'feature', path: '/repo/app-feature' })

    render(<SessionContextChip session={session()} />)
    await waitFor(() => expect(listRepoBranches).toHaveBeenCalledWith('/repo/app'))

    openChip()
    await openSub(/Branch/)
    fireEvent.click(await screen.findByRole('menuitem', { name: /feature/ }))

    // The same rule as the new-chat picker: the branch gets its own checkout and THIS
    // chat moves there. Checking it out in /repo/app would change the files under any
    // other session sitting in that folder, possibly mid-turn.
    await waitFor(() => expect(startWorkInRepo).toHaveBeenCalledWith('/repo/app', { existingBranch: 'feature' }))
    await waitFor(() => expect(moveSessionWorkspace).toHaveBeenCalledWith('sess-1', '/repo/app-feature', undefined))
  })

  it('reuses a branch that already has a checkout instead of making another', async () => {
    isGitRepoPath.mockResolvedValue(true)
    listRepoBranches.mockResolvedValue([
      branch({ isDefault: true, name: 'main' }),
      branch({ name: 'feature', worktreePath: '/repo/app-feature' })
    ])

    render(<SessionContextChip session={session()} />)
    await waitFor(() => expect(listRepoBranches).toHaveBeenCalledWith('/repo/app'))

    openChip()
    await openSub(/Branch/)
    fireEvent.click(await screen.findByRole('menuitem', { name: /feature/ }))

    await waitFor(() => expect(moveSessionWorkspace).toHaveBeenCalledWith('sess-1', '/repo/app-feature', undefined))
    expect(startWorkInRepo).not.toHaveBeenCalled()
  })

  it('asks before moving the chat to another project, because that moves its files', async () => {
    $projects.set([project(), project({ id: 'p_site', name: 'Site', primary_path: '/repo/site' })])

    render(<SessionContextChip session={session()} />)

    openChip()
    await openSub(/Work in another project/)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Site' }))

    // Groups never ask. This does: the chat's terminal and file tools follow.
    await waitFor(() => expect(screen.getByText(/Move this chat\?/)).toBeTruthy())
    expect(moveSessionWorkspace).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Move it' }))

    await waitFor(() => expect(moveSessionWorkspace).toHaveBeenCalledWith('sess-1', '/repo/site', undefined))
  })

  it('also asks for a folder picked by hand', async () => {
    pickProjectFolder.mockResolvedValue('/other/repo')
    render(<SessionContextChip session={session()} />)

    openChip()
    await openSub(/Work in another project/)
    fireEvent.click(await screen.findByRole('menuitem', { name: /Choose a folder/ }))

    await waitFor(() => expect(screen.getByText(/Move this chat\?/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Move it' }))

    await waitFor(() => expect(moveSessionWorkspace).toHaveBeenCalledWith('sess-1', '/other/repo', undefined))
  })
})
