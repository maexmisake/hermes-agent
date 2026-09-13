import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectInfo, SessionInfo } from '@/hermes'
import type * as CodingStatusStore from '@/store/coding-status'
import { $showAllProfiles } from '@/store/profile'
import { $projects } from '@/store/projects'
import type * as ProjectsStore from '@/store/projects'
import { $sessions, setCurrentCwdTransient, setNewChatWorkspaceTarget } from '@/store/session'

import {
  $newChatNewBranch,
  $newChatProject,
  $newChatProjects,
  $newChatWorkspace,
  branchSlug,
  chooseNewBranch,
  draftWorkspace,
  loadNewChatProjects,
  looseWorkspaces,
  materializeNewChatBranch,
  projectForWorkspace,
  projectMainWorkspace,
  samePath,
  setNewChatProject,
  setNewChatWorkspace,
  uniqueBranchName
} from './new-session-setup'

const git = vi.hoisted(() => ({
  addProjectFolder: vi.fn(),
  isGitRepoPath: vi.fn(),
  listProjectsForProfile: vi.fn(),
  listRepoBranches: vi.fn(),
  startWorkInRepo: vi.fn()
}))

vi.mock('@/store/projects', async importOriginal => ({
  ...(await importOriginal<typeof ProjectsStore>()),
  addProjectFolder: git.addProjectFolder,
  listProjectsForProfile: git.listProjectsForProfile,
  listRepoBranches: git.listRepoBranches,
  startWorkInRepo: git.startWorkInRepo
}))

vi.mock('@/store/coding-status', async importOriginal => ({
  ...(await importOriginal<typeof CodingStatusStore>()),
  isGitRepoPath: git.isGitRepoPath
}))

function project(id: string, folders: string[], extra: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    archived: false,
    board_slug: null,
    color: null,
    created_at: 0,
    description: null,
    folders: folders.map(path => ({ added_at: 0, is_primary: false, label: null, path })),
    icon: null,
    id,
    name: id,
    primary_path: folders[0] ?? null,
    slug: id,
    ...extra
  } as ProjectInfo
}

function session(cwd: string, lastActive: number, extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    cwd,
    id: `s-${lastActive}`,
    last_active: lastActive,
    source: 'desktop',
    started_at: lastActive,
    ...extra
  } as SessionInfo
}

beforeEach(() => {
  vi.clearAllMocks()
  git.addProjectFolder.mockResolvedValue(undefined)
  git.isGitRepoPath.mockResolvedValue(false)
  git.listRepoBranches.mockResolvedValue([])
  $projects.set([])
  $sessions.set([])
  $showAllProfiles.set(false)
  // A fresh draft: every earlier pick belongs to the draft before it.
  setNewChatWorkspaceTarget(undefined)
  setCurrentCwdTransient('')
})

describe('projectForWorkspace', () => {
  const shared = project('shared', ['/ws'])
  const pets = project('pets', ['/ws/pets'])

  it('picks the project whose folder is the closest match', () => {
    expect(projectForWorkspace([shared, pets], '/ws/pets/api')?.id).toBe('pets')
    expect(projectForWorkspace([shared, pets], '/ws/scratch')?.id).toBe('shared')
  })

  it('does not treat a sibling folder with a shared prefix as inside', () => {
    expect(projectForWorkspace([pets], '/ws/pets-old')).toBeNull()
  })

  it('returns null for no workspace, no match, or an archived project', () => {
    expect(projectForWorkspace([pets], '')).toBeNull()
    expect(projectForWorkspace([pets], '/elsewhere')).toBeNull()
    expect(projectForWorkspace([project('old', ['/ws/old'], { archived: true })], '/ws/old')).toBeNull()
  })

  it('matches Windows paths regardless of slash direction and letter case', () => {
    const win = project('win', ['C:\\Users\\Me\\Agent Shared Workspace\\Pets'])

    expect(projectForWorkspace([win], 'c:/users/me/agent shared workspace/pets/api')?.id).toBe('win')
  })
})

describe('projectMainWorkspace', () => {
  it('prefers the primary folder, then the first folder, else nothing', () => {
    expect(projectMainWorkspace(project('a', ['/a', '/b'], { primary_path: '/b' }))).toBe('/b')
    expect(projectMainWorkspace(project('a', ['/a'], { primary_path: null }))).toBe('/a')
    expect(projectMainWorkspace(project('a', [], { primary_path: null }))).toBe('')
    expect(projectMainWorkspace(null)).toBe('')
  })
})

describe('samePath', () => {
  it('ignores trailing slashes, Windows spelling, and never matches an empty path', () => {
    expect(samePath('/ws/pets/', '/ws/pets')).toBe(true)
    expect(samePath('C:\\Users\\Me\\Pets\\', 'c:/users/me/pets')).toBe(true)
    expect(samePath('', '')).toBe(false)
  })
})

describe('the workspace the chat will start in', () => {
  it('is detached for "no workspace", the folder for an explicit pick, else the live folder', () => {
    expect(draftWorkspace(null, '/live')).toBe('')
    expect(draftWorkspace(' /picked ', '/live')).toBe('/picked')
    expect(draftWorkspace(undefined, ' /live ')).toBe('/live')
  })

  it('stays "no workspace" when a default folder is seeded after the pick, as Send will', () => {
    setNewChatWorkspaceTarget(null)
    setCurrentCwdTransient('/ws/pets')

    expect($newChatWorkspace.get()).toBe('')
  })
})

describe('branch names', () => {
  it('names the branch from the first words of the message', () => {
    expect(branchSlug('Fix the login bug on Windows!')).toBe('fix-the-login-bug')
    expect(branchSlug('修复登录')).toBe('work')
  })

  it('never reuses a branch that already exists', () => {
    expect(uniqueBranchName('fix', new Set())).toBe('hermes/fix')
    expect(uniqueBranchName('fix', new Set(['hermes/fix', 'hermes/fix-2']))).toBe('hermes/fix-3')
  })
})

describe('looseWorkspaces', () => {
  it('lists recent folders outside every project, the remembered one first, without messaging threads', () => {
    const sessions = [
      session('/scratch', 3),
      session('/ws/pets/api', 5),
      session('/notes', 4, { source: 'telegram' }),
      session('/scratch/', 2),
      session('/tmp/old', 1)
    ]

    expect(looseWorkspaces([project('pets', ['/ws/pets'])], sessions, '/remembered')).toEqual([
      '/remembered',
      '/scratch',
      '/tmp/old'
    ])
  })
})

describe('picks belong to one draft', () => {
  it('keeps a picked project when its folder is shared with another project', async () => {
    $projects.set([project('shared', ['/ws/shared']), project('pets', ['/ws/pets', '/ws/shared'])])

    await setNewChatProject($projects.get()[1])
    setNewChatWorkspace('/ws/shared', 'pets')

    expect($newChatProject.get()?.id).toBe('pets')
  })

  it('drops a New branch pick once a new draft starts, even in the same folder', () => {
    setNewChatWorkspace('/repo')
    chooseNewBranch('main')
    expect($newChatNewBranch.get()?.base).toBe('main')

    // The sidebar "+" or Ctrl+N starts another draft.
    setNewChatWorkspaceTarget(undefined)
    setCurrentCwdTransient('/repo')

    expect($newChatNewBranch.get()).toBeNull()
  })

  it('re-picking the project the chat is already in keeps the branch pick', async () => {
    $projects.set([project('app', ['/repo'])])

    await setNewChatProject($projects.get()[0])
    chooseNewBranch('main')
    await setNewChatProject($projects.get()[0])

    expect($newChatNewBranch.get()).not.toBeNull()
  })
})

describe('materializeNewChatBranch', () => {
  it('does nothing without a New branch pick for this draft', async () => {
    setNewChatWorkspace('/repo')

    await expect(materializeNewChatBranch('/repo', 'hi')).resolves.toBe('/repo')
    expect(git.startWorkInRepo).not.toHaveBeenCalled()
  })

  it('makes a new, uniquely named branch from where the pick said and moves the draft there', async () => {
    $projects.set([project('app', ['/repo'])])
    await setNewChatProject($projects.get()[0])
    chooseNewBranch('feature')
    git.listRepoBranches.mockResolvedValue([
      { checkedOut: false, isDefault: false, isRemote: false, name: 'hermes/fix-login', worktreePath: null }
    ])
    git.startWorkInRepo.mockResolvedValue({ branch: 'hermes/fix-login-2', path: '/repo/.worktrees/fix-login-2' })

    await expect(materializeNewChatBranch('/repo', 'Fix login')).resolves.toBe('/repo/.worktrees/fix-login-2')

    expect(git.startWorkInRepo).toHaveBeenCalledWith('/repo', {
      base: 'feature',
      branch: 'hermes/fix-login-2',
      name: 'fix-login-2'
    })
    expect($newChatWorkspace.get()).toBe('/repo/.worktrees/fix-login-2')
    expect($newChatProject.get()?.id).toBe('app')
    expect($newChatNewBranch.get()).toBeNull()
    expect(git.addProjectFolder).not.toHaveBeenCalled()
  })

  it('hands the folder back without repointing a draft the user already left', async () => {
    setNewChatWorkspace('/repo')
    chooseNewBranch('')
    git.startWorkInRepo.mockImplementation(async () => {
      setNewChatWorkspace('/elsewhere')

      return { branch: 'hermes/work', path: '/repo/.worktrees/work' }
    })

    await expect(materializeNewChatBranch('/repo')).resolves.toBe('/repo/.worktrees/work')
    expect($newChatWorkspace.get()).toBe('/elsewhere')
  })

  it('keeps a project folder inside a bigger repo at the same place in the new checkout', async () => {
    $projects.set([project('pets', ['/repo/pets'])])
    await setNewChatProject($projects.get()[0])
    chooseNewBranch('main')
    git.startWorkInRepo.mockResolvedValue({ branch: 'hermes/work', path: '/repo/.worktrees/work' })
    git.isGitRepoPath.mockResolvedValue(true)

    await expect(materializeNewChatBranch('/repo/pets')).resolves.toBe('/repo/.worktrees/work/pets')
    expect(git.addProjectFolder).toHaveBeenCalledWith('pets', '/repo/.worktrees/work/pets')
  })

  it('files that place under the picked project in "All profiles" view too', async () => {
    $showAllProfiles.set(true)
    git.listProjectsForProfile.mockResolvedValue([project('pets', ['/repo/pets'])])
    await loadNewChatProjects()
    await setNewChatProject($newChatProjects.get()[0])
    chooseNewBranch('main')
    git.startWorkInRepo.mockResolvedValue({ branch: 'hermes/work', path: '/repo/.worktrees/work' })
    git.isGitRepoPath.mockResolvedValue(true)

    await expect(materializeNewChatBranch('/repo/pets')).resolves.toBe('/repo/.worktrees/work/pets')
    expect(git.addProjectFolder).toHaveBeenCalledWith('pets', '/repo/.worktrees/work/pets')
  })

  it('stops the send with a readable error when git refuses', async () => {
    setNewChatWorkspace('/repo')
    chooseNewBranch('')
    git.startWorkInRepo.mockRejectedValue(new Error('fatal: invalid reference'))

    await expect(materializeNewChatBranch('/repo', 'x')).rejects.toThrow(
      'Could not create the branch: fatal: invalid reference'
    )
  })
})

describe('the projects a new chat can pick', () => {
  beforeEach(() => {
    git.listProjectsForProfile.mockResolvedValue([])
  })

  it('are the sidebar projects while viewing one profile', async () => {
    $projects.set([project('pets', ['/ws/pets'])])

    await loadNewChatProjects()

    expect($newChatProjects.get().map(candidate => candidate.id)).toEqual(['pets'])
    expect(git.listProjectsForProfile).not.toHaveBeenCalled()
  })

  it('are loaded for the chat\'s profile in "All profiles" view, which never loads the sidebar list', async () => {
    $showAllProfiles.set(true)
    git.listProjectsForProfile.mockResolvedValue([project('pets', ['/ws/pets'])])

    await loadNewChatProjects()

    expect(git.listProjectsForProfile).toHaveBeenCalledWith('default')
    expect($newChatProjects.get().map(candidate => candidate.id)).toEqual(['pets'])

    await setNewChatProject($newChatProjects.get()[0])

    expect($newChatWorkspace.get()).toBe('/ws/pets')
    expect($newChatProject.get()?.id).toBe('pets')
  })
})
