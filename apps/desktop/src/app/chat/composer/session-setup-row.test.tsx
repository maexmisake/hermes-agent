import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HermesGitBranch } from '@/global'
import type { ProjectInfo } from '@/hermes'

vi.mock('@/store/coding-status', () => ({ isGitRepoPath: vi.fn() }))

vi.mock('@/store/projects', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  listRepoBranches: vi.fn(),
  pickProjectFolder: vi.fn(),
  startWorkInRepo: vi.fn(),
  switchBranchInRepo: vi.fn()
}))

const coding = await import('@/store/coding-status')
const isGitRepoPath = vi.mocked(coding.isGitRepoPath)

const projectsStore = await import('@/store/projects')
const listRepoBranches = vi.mocked(projectsStore.listRepoBranches)
const pickProjectFolder = vi.mocked(projectsStore.pickProjectFolder)
const startWorkInRepo = vi.mocked(projectsStore.startWorkInRepo)
const { $projects } = projectsStore

const { $currentCwd, $newChatWorkspaceTarget, setCurrentBranch, setNewChatWorkspaceTarget } =
  await import('@/store/session')

const { $newChatBranches, $newChatFolderIsRepo, $newChatProjectId } = await import('@/store/new-session-setup')

const { SessionSetupRow } = await import('./session-setup-row')

const project = (overrides: Partial<ProjectInfo> = {}): ProjectInfo => ({
  archived: false,
  board_slug: null,
  color: null,
  created_at: 0,
  description: null,
  folders: [],
  icon: null,
  id: 'p_app',
  name: 'App',
  primary_path: '/repo/app',
  slug: 'app',
  ...overrides
})

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
  window.localStorage.clear()
  $newChatProjectId.set('')
  $projects.set([])
  $currentCwd.set('')
  setCurrentBranch('')
  setNewChatWorkspaceTarget(undefined)
  $newChatFolderIsRepo.set(false)
  $newChatBranches.set([])
  isGitRepoPath.mockResolvedValue(false)
  listRepoBranches.mockResolvedValue([])
})

afterEach(cleanup)

/** Radix opens on keyboard too, and jsdom has no real pointer — Enter is the door. */
const openMenu = (target: HTMLElement | RegExp | string) =>
  fireEvent.keyDown(typeof target === 'object' && 'tagName' in target ? target : screen.getByRole('button', { name: target }), {
    key: 'Enter'
  })

const choose = async (name: RegExp | string) => fireEvent.click(await screen.findByRole('menuitem', { name }))

describe('the setup row a chat starts with', () => {
  it('starts clean: a project, a folder, and no branch bubble at all', async () => {
    render(<SessionSetupRow />)

    // Empty is a legitimate finished state, not a form waiting to be completed.
    expect(screen.getByRole('button', { name: 'Project: No project' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Folder: No folder' })).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Branch:/ })).toBeNull())
  })

  it('opens in the project it was last told to use', async () => {
    $projects.set([project()])
    $newChatProjectId.set('p_app')

    render(<SessionSetupRow />)

    // Remembering the last DELIBERATE pick, which is a different thing from
    // inheriting whichever project the sidebar happens to be showing.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Project: App' })).toBeTruthy())
    await waitFor(() => expect($currentCwd.get()).toBe('/repo/app'))
    expect(screen.getByRole('button', { name: 'Folder: app' })).toBeTruthy()
  })

  it('picks a project and takes its folder, without locking the folder', async () => {
    $projects.set([project(), project({ id: 'p_site', name: 'Site', primary_path: '/repo/site' })])

    render(<SessionSetupRow />)

    openMenu('Project: No project')
    await choose('Site')

    await waitFor(() => expect($newChatProjectId.get()).toBe('p_site'))
    await waitFor(() => expect($newChatWorkspaceTarget.get()).toBe('/repo/site'))

    pickProjectFolder.mockResolvedValue('/scratch/vps')
    openMenu('Folder: site')
    await choose('Choose folder…')

    // Filed under Site, running in a scratch folder. Filing and workspace are
    // separate, and the row has to let you say so before the first message.
    await waitFor(() => expect($currentCwd.get()).toBe('/scratch/vps'))
    expect($newChatProjectId.get()).toBe('p_site')
  })

  it('grows a branch bubble only once the folder turns out to be a repo', async () => {
    isGitRepoPath.mockResolvedValue(true)
    listRepoBranches.mockResolvedValue([branch({ isDefault: true, name: 'main' }), branch({ name: 'feature' })])
    pickProjectFolder.mockResolvedValue('/repo/app')

    render(<SessionSetupRow />)

    expect(screen.queryByRole('button', { name: /^Branch:/ })).toBeNull()

    openMenu('Folder: No folder')
    await choose('Choose folder…')

    // Nobody was asked "is this a git project?" — it was probed and answered.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Branch: No branch' })).toBeTruthy())
  })

  it('marks a branch that already has a checkout, and reuses it', async () => {
    $currentCwd.set('/repo/app')
    isGitRepoPath.mockResolvedValue(true)
    listRepoBranches.mockResolvedValue([branch({ name: 'feature', worktreePath: '/repo/app-feature' })])

    render(<SessionSetupRow />)

    openMenu(await screen.findByRole('button', { name: 'Branch: No branch' }))

    const row = await screen.findByRole('menuitem', { name: /feature/ })

    // The one fact worth showing: this branch has a folder already, so picking it
    // continues that unfinished work instead of cloning it into a rival worktree.
    expect(row.textContent).toContain('open')

    fireEvent.click(row)

    await waitFor(() => expect($currentCwd.get()).toBe('/repo/app-feature'))
    expect(startWorkInRepo).not.toHaveBeenCalled()
  })

  it('offers to create a branch only for a name that is not already one', async () => {
    $currentCwd.set('/repo/app')
    isGitRepoPath.mockResolvedValue(true)
    listRepoBranches.mockResolvedValue([branch({ isDefault: true, name: 'main' })])

    render(<SessionSetupRow />)
    openMenu(await screen.findByRole('button', { name: 'Branch: No branch' }))

    const search = await screen.findByPlaceholderText('Find or name a branch')

    fireEvent.change(search, { target: { value: 'main' } })
    expect(screen.queryByRole('menuitem', { name: /New branch/ })).toBeNull()

    fireEvent.change(search, { target: { value: 'spike' } })

    // Typing a name is the ONLY way to reach branch creation — opening a chat
    // never gets there on its own.
    expect(await screen.findByRole('menuitem', { name: 'New branch “spike”' })).toBeTruthy()
  })
})
