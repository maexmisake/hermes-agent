import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { HermesGitBranch } from '@/global'
import type { ProjectInfo } from '@/hermes'

vi.mock('@/store/coding-status', () => ({ isGitRepoPath: vi.fn() }))

vi.mock('@/store/projects', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  listRepoBranches: vi.fn(),
  startWorkInRepo: vi.fn(),
  switchBranchInRepo: vi.fn()
}))

const coding = await import('@/store/coding-status')
const isGitRepoPath = vi.mocked(coding.isGitRepoPath)

const projectsStore = await import('@/store/projects')
const listRepoBranches = vi.mocked(projectsStore.listRepoBranches)
const startWorkInRepo = vi.mocked(projectsStore.startWorkInRepo)
const switchBranchInRepo = vi.mocked(projectsStore.switchBranchInRepo)
const { $projects } = projectsStore

const { $currentBranch, $currentCwd, $newChatWorkspaceTarget, setCurrentBranch, setNewChatWorkspaceTarget } =
  await import('@/store/session')

const {
  $newChatBranches,
  $newChatFolderIsRepo,
  $newChatProject,
  $newChatProjectId,
  createNewChatBranch,
  projectDefaultFolder,
  seedNewChatSetup,
  setNewChatFolder,
  setNewChatProject,
  workOnNewChatBranch
} = await import('./new-session-setup')

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

describe('the remembered project', () => {
  it('resolves against the live catalog and forgets one that was archived', () => {
    $projects.set([project()])
    $newChatProjectId.set('p_app')

    expect($newChatProject.get()?.name).toBe('App')

    $projects.set([project({ archived: true })])

    // Not an error state: the bubble reads "No project" and the next pick sticks.
    // An id that resolves to nothing must never leave the row claiming a project
    // the user can no longer see anywhere else.
    expect($newChatProject.get()).toBeNull()
  })

  it('offers the primary path, falling back to the first folder', () => {
    expect(projectDefaultFolder(project({ primary_path: '/repo/app' }))).toBe('/repo/app')
    expect(
      projectDefaultFolder(project({ folders: [{ path: '/repo/other' }] as ProjectInfo['folders'], primary_path: null }))
    ).toBe('/repo/other')
    expect(projectDefaultFolder(project({ folders: [], primary_path: null }))).toBe('')
    expect(projectDefaultFolder(null)).toBe('')
  })
})

describe('picking a project', () => {
  it('offers the project folder as the workspace, editable after', async () => {
    $projects.set([project()])

    await setNewChatProject('p_app')

    expect($newChatProjectId.get()).toBe('p_app')
    expect($currentCwd.get()).toBe('/repo/app')
    expect($newChatWorkspaceTarget.get()).toBe('/repo/app')

    // The offer is not a lock: the folder bubble can point somewhere else while the
    // chat stays filed under the project. Filing and workspace are separate.
    await setNewChatFolder('/somewhere/else')

    expect($newChatProjectId.get()).toBe('p_app')
    expect($currentCwd.get()).toBe('/somewhere/else')
  })

  it('leaves the folder alone for a project that has none', async () => {
    $projects.set([project({ folders: [], primary_path: null })])
    await setNewChatFolder('/already/here')

    await setNewChatProject('p_app')

    // Picking a project is not a request to stop working where you are.
    expect($currentCwd.get()).toBe('/already/here')
    expect($newChatProjectId.get()).toBe('p_app')
  })

  it('remembers "no project" as firmly as it remembers a project', async () => {
    $projects.set([project()])
    await setNewChatProject('p_app')

    await setNewChatProject(null)

    expect($newChatProjectId.get()).toBe('')
    expect($newChatProject.get()).toBeNull()
  })
})

describe('the folder', () => {
  it('detaches explicitly on "no folder" rather than falling back to a default', async () => {
    await setNewChatFolder('/repo/app')

    await setNewChatFolder(null)

    // null, not undefined: "I chose nothing" reads differently to session.create
    // than "nothing was chosen yet", and only the former stays detached.
    expect($newChatWorkspaceTarget.get()).toBeNull()
    expect($currentCwd.get()).toBe('')
  })

  it('shows the branch bubble for a repo and hides it for a plain folder', async () => {
    isGitRepoPath.mockResolvedValue(true)
    listRepoBranches.mockResolvedValue([branch({ name: 'main' })])

    await setNewChatFolder('/repo/app')

    expect($newChatFolderIsRepo.get()).toBe(true)
    expect($newChatBranches.get()).toHaveLength(1)

    isGitRepoPath.mockResolvedValue(false)
    await setNewChatFolder('/plain/notes')

    expect($newChatFolderIsRepo.get()).toBe(false)
    expect($newChatBranches.get()).toEqual([])
  })

  it('re-asks on every pick, so a folder that gains git starts offering branches', async () => {
    await setNewChatFolder('/plain/notes')
    expect($newChatFolderIsRepo.get()).toBe(false)

    // Nothing recorded "this is not a git project", so `git init` later needs no
    // migration and no announcement — the next look simply answers yes.
    isGitRepoPath.mockResolvedValue(true)
    listRepoBranches.mockResolvedValue([branch({ name: 'main' })])
    await setNewChatFolder('/plain/notes')

    expect($newChatFolderIsRepo.get()).toBe(true)
  })

  it('drops a probe answer that arrived after the folder moved on', async () => {
    let resolveFirst!: (value: boolean) => void

    isGitRepoPath.mockImplementationOnce(() => new Promise<boolean>(done => (resolveFirst = done)))
    const slow = setNewChatFolder('/repo/slow')

    isGitRepoPath.mockResolvedValue(false)
    await setNewChatFolder('/plain/fast')

    resolveFirst(true)
    await slow

    // The stale "yes it's a repo" would otherwise put a branch bubble on a folder
    // that is not one, listing branches from a repo nobody is looking at.
    expect($newChatFolderIsRepo.get()).toBe(false)
  })
})

describe('choosing a branch', () => {
  it('reuses an existing checkout so a new chat continues the same work', async () => {
    await workOnNewChatBranch('/repo/app', branch({ name: 'feature', worktreePath: '/repo/app-feature' }))

    expect($currentCwd.get()).toBe('/repo/app-feature')
    expect($currentBranch.get()).toBe('feature')
    // The whole point: no second worktree for work that already has one.
    expect(startWorkInRepo).not.toHaveBeenCalled()
  })

  it('makes a worktree only for a branch that has nowhere to live', async () => {
    startWorkInRepo.mockResolvedValue({ branch: 'feature', path: '/repo/app-feature' })

    await workOnNewChatBranch('/repo/app', branch({ name: 'feature' }))

    expect(startWorkInRepo).toHaveBeenCalledWith('/repo/app', { existingBranch: 'feature' })
    expect($currentCwd.get()).toBe('/repo/app-feature')
  })

  it('uses the repo itself for the default branch instead of a worktree beside it', async () => {
    await workOnNewChatBranch('/repo/app', branch({ isDefault: true, name: 'main' }))

    expect(switchBranchInRepo).toHaveBeenCalledWith('/repo/app', 'main')
    expect($currentCwd.get()).toBe('/repo/app')
    expect(startWorkInRepo).not.toHaveBeenCalled()
  })

  it('creates a branch ONLY when one is named', async () => {
    startWorkInRepo.mockResolvedValue({ branch: 'spike', path: '/repo/app-spike' })

    await createNewChatBranch('/repo/app', 'spike', 'main')

    expect(startWorkInRepo).toHaveBeenCalledWith('/repo/app', { base: 'main', branch: 'spike' })

    startWorkInRepo.mockClear()
    await createNewChatBranch('/repo/app', '   ')

    // Starting a chat is not a reason to make a branch, and neither is an empty box.
    expect(startWorkInRepo).not.toHaveBeenCalled()
  })
})

describe('seeding a draft', () => {
  it('starts a bare chat in the remembered project', async () => {
    $projects.set([project()])
    $newChatProjectId.set('p_app')

    await seedNewChatSetup(false)

    expect($currentCwd.get()).toBe('/repo/app')
  })

  it('leaves an explicitly targeted draft where it was put', async () => {
    $projects.set([project()])
    $newChatProjectId.set('p_app')
    $currentCwd.set('/dragged/here')

    await seedNewChatSetup(true)

    // The sidebar "+" on a folder is a choice made for THIS chat; the remembered
    // project is a default for chats nobody chose a folder for.
    expect($currentCwd.get()).toBe('/dragged/here')
  })

  it('starts detached when nothing is remembered', async () => {
    await seedNewChatSetup(false)

    expect($currentCwd.get()).toBe('')
    expect($newChatFolderIsRepo.get()).toBe(false)
  })
})
