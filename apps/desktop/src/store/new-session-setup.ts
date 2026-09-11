import { atom, computed, type ReadableAtom } from 'nanostores'

import type { HermesGitBranch } from '@/global'
import type { ProjectInfo } from '@/hermes'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { isGitRepoPath } from '@/store/coding-status'
import { $projects, listRepoBranches, startWorkInRepo, switchBranchInRepo } from '@/store/projects'
import { $currentCwd, setCurrentBranch, setCurrentCwd, setNewChatWorkspaceTarget } from '@/store/session'

/**
 * What a chat is set up to work on, chosen BEFORE its first message.
 *
 * Three things, in the order they constrain each other: a project files the chat, a
 * folder is where it runs, and a branch is which checkout of that folder. Each is
 * optional and a chat can start with none of them — that is the clean default, not a
 * state to be filled in.
 *
 * The split that makes this safe is the same one the sidebar uses: FILING and
 * WORKSPACE are different things. The project here is filing (a `project_id` on the
 * session row, organization only); the folder is the workspace (the `cwd` an agent's
 * terminal and file tools actually run in). Picking a project OFFERS its folder,
 * because that is almost always what you meant, but the two stay independently
 * editable until the first message — and filing a chat later never moves it.
 *
 * Nothing here reads the sidebar. A chat used to inherit whichever project was open,
 * so looking at a folder decided where the next conversation would run. What IS
 * remembered is the last project deliberately picked in this row, which is a
 * different thing: choosing, not viewing.
 */

const NEW_CHAT_PROJECT_STORAGE_KEY = 'hermes.desktop.newChatProject'

/**
 * The last project deliberately picked for a new chat, remembered so the next one
 * starts where the last one did. Empty means "no project", which is a real choice:
 * clearing the bubble sticks the same way picking one does.
 */
export const $newChatProjectId = persistentAtom<string>(NEW_CHAT_PROJECT_STORAGE_KEY, '', Codecs.text)

/** Whether the picked folder is a git repo — the branch bubble's whole condition. */
export const $newChatFolderIsRepo = atom(false)

/** Branches of the picked folder, empty while it is not a repo or not yet probed. */
export const $newChatBranches = atom<HermesGitBranch[]>([])
export const $newChatBranchesLoading = atom(false)

/** The remembered project, resolved against the live catalog (null when it is gone). */
export const $newChatProject: ReadableAtom<ProjectInfo | null> = computed(
  [$newChatProjectId, $projects],
  (id, projects) => (id ? (projects.find(project => project.id === id && !project.archived) ?? null) : null)
)

/**
 * The folder a project offers a new chat: its primary path, else its first folder.
 * A project with no folder at all offers nothing, which is legitimate — the user
 * settled that a project IS a folder, but a brand-new one can be named before it
 * has one.
 */
export function projectDefaultFolder(project: null | ProjectInfo): string {
  if (!project) {
    return ''
  }

  return (project.primary_path || project.folders[0]?.path || '').trim()
}

/**
 * Probe the picked folder for git and load its branches.
 *
 * This is the whole of "is this a git project?": no stored flag, asked fresh each
 * time. A plain folder that gets `git init` later simply starts answering yes, and
 * the branch bubble appears on its own without ever announcing itself — which is
 * what "notice and turn it on quietly" has to mean if nothing records the answer.
 */
export async function probeNewChatFolder(path: string): Promise<void> {
  const target = path.trim()

  if (!target) {
    $newChatFolderIsRepo.set(false)
    $newChatBranches.set([])

    return
  }

  const isRepo = await isGitRepoPath(target)

  // The folder can change while the probe is in flight (a fast second pick). Drop a
  // stale answer rather than letting it describe a folder nobody is looking at.
  if ($currentCwd.get().trim() !== target) {
    return
  }

  $newChatFolderIsRepo.set(isRepo)

  if (!isRepo) {
    $newChatBranches.set([])

    return
  }

  $newChatBranchesLoading.set(true)

  try {
    const branches = await listRepoBranches(target)

    if ($currentCwd.get().trim() === target) {
      $newChatBranches.set(branches)
    }
  } catch {
    $newChatBranches.set([])
  } finally {
    $newChatBranchesLoading.set(false)
  }
}

/**
 * Point the draft at a folder (or at nothing).
 *
 * Sets BOTH the one-shot target and the live cwd: the target is what `session.create`
 * reads, the cwd is what every workspace surface paints from. `null` means detached,
 * which is distinct from "not chosen yet" — it is an explicit no.
 */
export async function setNewChatFolder(path: null | string): Promise<void> {
  const target = (path ?? '').trim()

  setNewChatWorkspaceTarget(path === null ? null : target)
  setCurrentCwd(target)
  setCurrentBranch('')
  $newChatFolderIsRepo.set(false)
  $newChatBranches.set([])

  await probeNewChatFolder(target)
}

/**
 * Pick a project for the new chat, and offer its folder.
 *
 * The folder is an OFFER, not a consequence: it lands in the folder bubble where it
 * can be changed or cleared before the first message. A project with no folder leaves
 * the current one alone rather than detaching the chat — picking a project is not a
 * request to stop working where you are.
 */
export async function setNewChatProject(id: null | string): Promise<void> {
  $newChatProjectId.set(id ?? '')

  const project = id ? ($projects.get().find(candidate => candidate.id === id) ?? null) : null
  const folder = projectDefaultFolder(project)

  if (folder) {
    await setNewChatFolder(folder)
  }
}

/**
 * Seed a draft from the remembered project.
 *
 * Called once per draft — the setup row keys this on the draft's workspace-target
 * generation, so clicking "New chat" again re-seeds rather than leaving the previous
 * draft's folder on screen.
 *
 * An explicit workspace target outranks the remembered project: the sidebar's "+" on
 * a folder, or a drag onto a zone, is a choice made for THIS chat, and a remembered
 * one must not overwrite it. Either way the folder is probed, because a branch bubble
 * is owed to any repo folder however it was chosen.
 */
export async function seedNewChatSetup(hasExplicitTarget: boolean): Promise<void> {
  const folder = hasExplicitTarget ? '' : projectDefaultFolder($newChatProject.get())

  await (folder ? setNewChatFolder(folder) : probeNewChatFolder($currentCwd.get()))
}

/**
 * Work on `branch`, reusing whatever checkout it already has.
 *
 * The order is the point. A branch that is already checked out somewhere gets that
 * folder back, so a second chat continues the same unfinished work instead of
 * cloning it into a rival worktree. The default branch means the repo itself, not a
 * `.worktrees/main` beside it. Only a branch with nowhere to live gets a new
 * worktree — and none of this ever invents a branch, because starting a chat is not
 * a reason to make one.
 */
export async function workOnNewChatBranch(repoPath: string, branch: HermesGitBranch): Promise<void> {
  if (branch.worktreePath) {
    await setNewChatFolder(branch.worktreePath)
    setCurrentBranch(branch.name)

    return
  }

  if (branch.isDefault) {
    await switchBranchInRepo(repoPath, branch.name)
    await setNewChatFolder(repoPath)
    setCurrentBranch(branch.name)

    return
  }

  const created = await startWorkInRepo(repoPath, { existingBranch: branch.name })

  if (created) {
    await setNewChatFolder(created.path)
    setCurrentBranch(created.branch)
  }
}

/**
 * Make `name` and work in it. The ONE path that creates a branch, and it is reached
 * only by typing a name into "New branch…" — never by starting a chat.
 */
export async function createNewChatBranch(repoPath: string, name: string, base?: string): Promise<void> {
  const branch = name.trim()

  if (!branch) {
    return
  }

  const created = await startWorkInRepo(repoPath, { base, branch })

  if (created) {
    await setNewChatFolder(created.path)
    setCurrentBranch(created.branch)
  }
}
