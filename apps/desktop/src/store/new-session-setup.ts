import { atom, computed, type ReadableAtom } from 'nanostores'

import { NO_PROJECT_ID } from '@/app/chat/sidebar/projects/workspace-groups'
import type { ProjectInfo, SessionInfo } from '@/hermes'
import { translateNow } from '@/i18n'
import { cleanPath, comparisonPath, isUnderPath } from '@/lib/path-compare'
import { isMessagingSource, normalizeSessionSource } from '@/lib/session-source'
import { isGitRepoPath, repoStatusForCwd } from '@/store/coding-status'
import {
  $activeGatewayProfile,
  $newChatProfile,
  $newChatRoute,
  $profileScope,
  ALL_PROFILES,
  normalizeProfileKey
} from '@/store/profile'
import {
  $projectDialog,
  $projects,
  $projectScope,
  $projectTree,
  addProjectFolder,
  listProjectsForProfile,
  listRepoBranches,
  openProjectCreate,
  pickProjectFolder,
  resolveNewSessionCwd,
  startWorkInRepo
} from '@/store/projects'
import {
  $currentCwd,
  $newChatWorkspaceTarget,
  $newChatWorkspaceTargetGeneration,
  $sessions,
  getRememberedWorkspaceCwd,
  type NewChatWorkspaceTarget,
  setCurrentBranch,
  setCurrentCwd,
  setCurrentCwdTransient,
  setNewChatWorkspaceTarget
} from '@/store/session'

/**
 * What a new chat is set up to work on, chosen BEFORE its first message: a project,
 * a workspace, and — only when that workspace is a git repo — whether to keep working
 * on its current branch or start a new one.
 *
 * Every pick belongs to ONE draft. The draft's workspace-target generation ticks
 * whenever a draft starts or its workspace changes, and each remembered pick carries
 * the generation it was made in, so a pick left behind by an earlier draft is never
 * applied to a later one.
 */

/** Paths are equal across separator, trailing-slash and Windows letter-case spellings. Empty never matches. */
export function samePath(a: string, b: string): boolean {
  if (!a.trim() || !b.trim()) {
    return false
  }

  return comparisonPath(cleanPath(a)) === comparisonPath(cleanPath(b))
}

/** The project whose folder contains `workspace` (longest match, the rule the sidebar groups by), or null. */
export function projectForWorkspace(projects: ProjectInfo[], workspace: string): null | ProjectInfo {
  if (!workspace.trim()) {
    return null
  }

  let best: null | ProjectInfo = null
  let bestLength = -1

  for (const project of projects) {
    if (project.archived) {
      continue
    }

    for (const folder of project.folders) {
      const length = folder.path.trim() ? cleanPath(folder.path).length : -1

      if (length > bestLength && isUnderPath(folder.path, workspace)) {
        best = project
        bestLength = length
      }
    }
  }

  return best
}

/** The workspace a project starts a chat in: its primary folder, else its first. */
export function projectMainWorkspace(project: null | ProjectInfo): string {
  if (!project) {
    return ''
  }

  return (project.primary_path || project.folders[0]?.path || '').trim()
}

/**
 * The workspace a fresh chat will start in, by the rule `session.create` applies at
 * send: an explicit "no workspace" (null) starts detached, an explicit folder starts
 * there, and otherwise the live workspace, then the configured default.
 */
export function draftWorkspace(target: NewChatWorkspaceTarget, liveCwd: string): string {
  if (target === null) {
    return ''
  }

  if (typeof target === 'string') {
    return target.trim()
  }

  // Home is an explicit detached scope: a live folder left by the project viewed
  // before never leaks in (#84220).
  if ($projectScope.get() === NO_PROJECT_ID) {
    return ''
  }

  return liveCwd.trim() || resolveNewSessionCwd()
}

/** The bubbles show what Send will use, so they never promise a workspace the chat will not get. */
export const $newChatWorkspace: ReadableAtom<string> = computed(
  [$newChatWorkspaceTarget, $currentCwd, $projectScope, $projectTree],
  (target, liveCwd) => draftWorkspace(target, liveCwd)
)

/** The profile the new chat is created in: the draft's own route, else the profile picked for it, else the live gateway's. */
export const $newChatProfileKey: ReadableAtom<string> = computed(
  [$newChatRoute, $newChatProfile, $activeGatewayProfile],
  (route, picked, gateway) => normalizeProfileKey(route?.profile || picked || gateway)
)

const NO_PROJECTS: ProjectInfo[] = []

// Projects loaded for a new chat while the sidebar shows "All profiles", a view that
// never loads the sidebar's own project list.
const $allProfilesChatProjects = atom<null | { profile: string; projects: ProjectInfo[] }>(null)

/**
 * The projects a new chat can be filed under: its profile's. Viewing one profile that
 * is the sidebar's list; in "All profiles" view it is the list loaded for the chat's
 * profile, empty until that arrives.
 */
export const $newChatProjects: ReadableAtom<ProjectInfo[]> = computed(
  [$profileScope, $projects, $allProfilesChatProjects, $newChatProfileKey],
  (scope, projects, loaded, profile) => {
    if (scope !== ALL_PROFILES) {
      return projects
    }

    return loaded?.profile === profile ? loaded.projects : NO_PROJECTS
  }
)

/** In "All profiles" view, load the chat's profile's projects. An answer for a profile the chat has since left is dropped. */
export async function loadNewChatProjects(): Promise<void> {
  if ($profileScope.get() !== ALL_PROFILES) {
    return
  }

  const profile = $newChatProfileKey.get()
  // Only the live gateway's profile can answer; a chat for any other has none to pick.
  const projects = await listProjectsForProfile(profile).catch(() => NO_PROJECTS)

  if ($profileScope.get() === ALL_PROFILES && $newChatProfileKey.get() === profile) {
    $allProfilesChatProjects.set({ profile, projects })
  }
}

/** The project picked in the PROJECT bubble, for the draft it was picked in. */
const $pickedProject = atom<null | { generation: number; id: string }>(null)

/**
 * The project the new chat is in. A project picked in the bubble stays picked while the
 * workspace is one of its folders, even a folder another project also holds. Otherwise
 * it is whichever project's folder contains the workspace.
 */
export const $newChatProject: ReadableAtom<null | ProjectInfo> = computed(
  [$newChatProjects, $newChatWorkspace, $pickedProject, $newChatWorkspaceTargetGeneration],
  (projects, workspace, picked, generation) => {
    const kept =
      picked && picked.generation === generation && workspace
        ? projects.find(
            project =>
              project.id === picked.id &&
              !project.archived &&
              project.folders.some(folder => isUnderPath(folder.path, workspace))
          )
        : undefined

    return kept ?? projectForWorkspace(projects, workspace)
  }
)

/** How many recent workspaces outside every project the WORKSPACE bubble offers under "No project". */
export const LOOSE_WORKSPACE_LIMIT = 6

// A chat that ran in a folder someone chose, not a messaging thread or a scheduled/board run.
const choseItsWorkspace = (session: SessionInfo): boolean => {
  const source = normalizeSessionSource(session.source)

  return !session.archived && !isMessagingSource(session.source) && source !== 'cron' && source !== 'kanban'
}

const sessionTime = (session: SessionInfo): number => session.last_active || session.started_at || 0

/** Recent workspaces that sit in no project: the remembered one first, then the ones recent chats used. */
export function looseWorkspaces(projects: ProjectInfo[], sessions: SessionInfo[], remembered: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()

  const consider = (path: null | string | undefined) => {
    const workspace = (path ?? '').trim()

    if (!workspace || found.length >= LOOSE_WORKSPACE_LIMIT) {
      return
    }

    const key = comparisonPath(cleanPath(workspace))

    if (seen.has(key)) {
      return
    }

    seen.add(key)

    if (!projectForWorkspace(projects, workspace)) {
      found.push(workspace)
    }
  }

  consider(remembered)

  for (const session of sessions.filter(choseItsWorkspace).sort((a, b) => sessionTime(b) - sessionTime(a))) {
    consider(session.cwd)
  }

  return found
}

export const $newChatLooseWorkspaces: ReadableAtom<string[]> = computed(
  [$newChatProjects, $sessions],
  (projects, sessions) => looseWorkspaces(projects, sessions, getRememberedWorkspaceCwd())
)

interface WorkspaceRepo {
  branch: string
  isRepo: boolean
  workspace: string
}

const $repoAnswer = atom<null | WorkspaceRepo>(null)

/** Whether the chat's workspace is a git repo and its branch: null until git answers for THIS workspace. */
export const $newChatRepo: ReadableAtom<null | WorkspaceRepo> = computed(
  [$repoAnswer, $newChatWorkspace],
  (answer, workspace) => (answer && samePath(answer.workspace, workspace) ? answer : null)
)

/** Ask git about the workspace. An answer that arrives after the workspace moved on is dropped. */
export async function probeNewChatWorkspace(path: string): Promise<void> {
  const workspace = path.trim()

  if (!workspace) {
    setCurrentBranch('')

    return
  }

  const isRepo = await isGitRepoPath(workspace)

  if (!samePath($newChatWorkspace.get(), workspace)) {
    return
  }

  const branch = isRepo ? (repoStatusForCwd(workspace).get()?.branch ?? '') : ''

  $repoAnswer.set({ branch, isRepo, workspace })
  setCurrentBranch(branch)
}

/** A "New branch" pick: made for one draft in one workspace, started from `base` ('' = where the workspace is). */
export interface NewBranchChoice {
  base: string
  generation: number
  workspace: string
}

const $branchChoice = atom<NewBranchChoice | null>(null)

/** The "New branch" pick for THIS draft in THIS workspace, or null: keep working on the current branch. */
export const $newChatNewBranch: ReadableAtom<NewBranchChoice | null> = computed(
  [$branchChoice, $newChatWorkspace, $newChatWorkspaceTargetGeneration],
  (choice, workspace, generation) =>
    choice && choice.generation === generation && samePath(choice.workspace, workspace) ? choice : null
)

/** "New branch…": nothing touches git until the first message is sent. */
export function chooseNewBranch(base: string): void {
  $branchChoice.set({
    base: base.trim(),
    generation: $newChatWorkspaceTargetGeneration.get(),
    workspace: $newChatWorkspace.get()
  })
}

/** "Keep working on <branch>": a fresh chat in the same folder. */
export function keepCurrentBranch(): void {
  $branchChoice.set(null)
}

/** The first few words of the message as a branch-safe slug: "Fix the login bug!" becomes "fix-the-login-bug". */
export function branchSlug(message: string): string {
  const words = message
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

  return words.slice(0, 4).join('-') || 'work'
}

/** `hermes/<slug>`, numbered past any branch that already has the name, so a new branch never reuses an old one. */
export function uniqueBranchName(slug: string, taken: ReadonlySet<string>): string {
  const name = `hermes/${slug}`

  if (!taken.has(name)) {
    return name
  }

  let n = 2

  while (taken.has(`${name}-${n}`)) {
    n += 1
  }

  return `${name}-${n}`
}

/**
 * Point the new chat at a workspace (or, with null, at none), optionally as a folder of
 * a picked project. A folder is remembered as the user's pick; "no workspace" is for
 * this chat only and leaves the remembered one alone. A branch pick is dropped: it
 * belonged to the previous workspace.
 */
export function setNewChatWorkspace(path: null | string, projectId?: string): void {
  const workspace = (path ?? '').trim()
  const generation = setNewChatWorkspaceTarget(path === null ? null : workspace)

  $pickedProject.set(projectId ? { generation, id: projectId } : null)
  $branchChoice.set(null)
  setCurrentBranch('')

  if (workspace) {
    setCurrentCwd(workspace)
  } else {
    setCurrentCwdTransient('')
  }
}

/**
 * Pick a project: the chat moves to its main folder. Re-picking the project the chat is
 * already in changes nothing, a project with no folder asks for one first, and
 * "No project" (null) clears the workspace.
 */
export async function setNewChatProject(project: null | ProjectInfo): Promise<void> {
  if (!project) {
    setNewChatWorkspace(null)

    return
  }

  if ($newChatProject.get()?.id === project.id) {
    return
  }

  const main = projectMainWorkspace(project)

  if (main) {
    setNewChatWorkspace(main, project.id)

    return
  }

  await addNewChatWorkspace(project)
}

/** "Add workspace…": pick a folder, save it to the project, and work there. */
export async function addNewChatWorkspace(project: ProjectInfo): Promise<void> {
  const picked = await pickProjectFolder()

  if (!picked) {
    return
  }

  await addProjectFolder(project.id, picked)
  setNewChatWorkspace(picked, project.id)
}

/** "Browse…" (no project): pick any folder for this chat. Nothing is saved to a project. */
export async function browseNewChatWorkspace(): Promise<void> {
  const picked = await pickProjectFolder()

  if (picked) {
    setNewChatWorkspace(picked)
  }
}

/** "New project…": open the project dialog and, once it closes having made one, pick the new project. */
export function createProjectForNewChat(): void {
  const known = () => [...$newChatProjects.get(), ...$projects.get()]
  const existing = new Set(known().map(project => project.id))

  openProjectCreate()

  // The dialog did not open (a backend without projects says so on its own).
  if (!$projectDialog.get()) {
    return
  }

  const stop = $projectDialog.listen(dialog => {
    if (dialog) {
      return
    }

    stop()

    // "All profiles" view keeps the chat's project list apart from the sidebar's, so
    // it is reloaded to hold the new project before that project is picked.
    void loadNewChatProjects()
      .then(() => {
        const created = known().find(project => !existing.has(project.id) && !project.archived)

        return created ? setNewChatProject(created) : undefined
      })
      .catch(() => undefined)
  })
}

/** The part of `workspace` below `root` as path segments: [] when it IS the root or not below it. */
function segmentsBelow(root: string, workspace: string): string[] {
  const top = cleanPath(root)
  const inner = cleanPath(workspace)

  if (!isUnderPath(top, inner)) {
    return []
  }

  return inner.slice(top.length).split('/').filter(Boolean)
}

/**
 * The folder to work in inside a new checkout. A workspace below the repo root (a
 * project folder inside a bigger repo) keeps the same place in the new checkout, when
 * that folder exists there: git only carries committed folders.
 */
async function workspaceInCheckout(checkout: string, workspace: string): Promise<string> {
  const tree = cleanPath(checkout)
  const marker = tree.lastIndexOf('/.worktrees/')

  if (marker < 0) {
    return checkout
  }

  const below = segmentsBelow(tree.slice(0, marker), workspace)
  // A workspace that is itself another branch's folder sits under `.worktrees/<name>`;
  // the place to keep is below THAT folder.
  const inside = below[0] === '.worktrees' ? below.slice(2) : below

  if (!inside.length) {
    return checkout
  }

  const candidate = `${tree}/${inside.join('/')}`

  return (await isGitRepoPath(candidate)) ? candidate : checkout
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Called at send, with the workspace the chat will start in and its first message.
 * With a "New branch" pick for this draft and workspace, make the branch now, named
 * from the message and in its own folder inside the repo so no other chat's files
 * change, and return that folder as the chat's workspace. Otherwise return `cwd`.
 *
 * Throws when the branch cannot be made, so the chat never quietly starts in the
 * shared folder instead of the branch that was asked for.
 */
export async function materializeNewChatBranch(cwd: string, message = ''): Promise<string> {
  const workspace = cwd.trim()
  const choice = $newChatNewBranch.get()

  if (!choice || !workspace || !samePath(choice.workspace, workspace)) {
    return cwd
  }

  const project = $newChatProject.get()
  let created: null | { branch: string; path: string }

  try {
    const existing = await listRepoBranches(workspace).catch(() => [])
    const taken = new Set(existing.filter(branch => !branch.isRemote).map(branch => branch.name))
    const branch = uniqueBranchName(branchSlug(message), taken)

    created = await startWorkInRepo(workspace, {
      ...(choice.base ? { base: choice.base } : {}),
      branch,
      name: branch.slice('hermes/'.length)
    })
  } catch (error) {
    throw new Error(`${translateNow('composer.setup.branchFailed')}: ${errorText(error)}`)
  }

  if (!created) {
    throw new Error(translateNow('composer.setup.branchFailed'))
  }

  const next = await workspaceInCheckout(created.path, workspace)

  // The new folder must still file under the picked project in the sidebar. All
  // profiles view keeps projects read-only, so the folder is not saved there.
  const canEditProjects = $profileScope.get() !== ALL_PROFILES

  if (canEditProjects && project && !project.folders.some(folder => isUnderPath(folder.path, next))) {
    await addProjectFolder(project.id, next).catch(() => undefined)
  }

  $branchChoice.set(null)

  // Only the draft that asked for the branch moves there. If the user left it while
  // git was working, the folder is just handed back for the chat being created.
  if ($newChatWorkspaceTargetGeneration.get() === choice.generation) {
    const generation = setNewChatWorkspaceTarget(next)

    if (project) {
      $pickedProject.set({ generation, id: project.id })
    }

    setCurrentCwdTransient(next)
    setCurrentBranch(created.branch)
  }

  return next
}
