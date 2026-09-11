import { atom, computed, type ReadableAtom } from 'nanostores'

import type { HermesGitBranch } from '@/global'
import type { ProjectInfo } from '@/hermes'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { isGitRepoPath } from '@/store/coding-status'
import { $projects, listRepoBranches, startWorkInRepo } from '@/store/projects'
import { $currentCwd, setCurrentBranch, setCurrentCwd, setNewChatWorkspaceTarget } from '@/store/session'

/**
 * What a chat is set up to work on, chosen BEFORE its first message.
 *
 * TWO things, not three: a project, and — only when that project's folder is a git repo —
 * a branch. Both optional; a chat can start with neither, which is the clean default
 * rather than a form left unfinished.
 *
 * A PROJECT IS A WORKING FOLDER. That is the whole model, and the reason there is no
 * third "folder" alongside it: "which project is this chat in" and "which folder does it
 * run in" are one question. Picking a project points the chat at that folder; there is no
 * second identity that could name a project the chat does not actually work in.
 *
 * Groups are the other half, and they live elsewhere (`setSessionGroup`): arbitrary
 * buckets for tidying conversations, which name no folder and move nothing.
 *
 * Nothing here reads the sidebar. A chat used to inherit whichever project was open, so
 * looking at a folder decided where the next conversation would run. What IS remembered is
 * the last project deliberately picked in this row — choosing, not viewing.
 */

const NEW_CHAT_PROJECT_STORAGE_KEY = 'hermes.desktop.newChatProject'

/**
 * The last project deliberately picked for a new chat, remembered so the next one starts
 * where the last one did. Empty means "no project", which is a real choice: clearing the
 * bubble sticks the same way picking one does.
 */
export const $newChatProjectId = persistentAtom<string>(NEW_CHAT_PROJECT_STORAGE_KEY, '', Codecs.text)

/** Whether the picked project's folder is a git repo — the branch bubble's whole condition. */
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
 * The working folder of a project: its primary path, else its first folder.
 *
 * A project with no folder at all offers nothing. That is a half-made project rather than
 * a supported shape — the project dialog asks for a folder — so the chat simply stays
 * where it is instead of being detached.
 */
export function projectFolder(project: null | ProjectInfo): string {
  if (!project) {
    return ''
  }

  return (project.primary_path || project.folders[0]?.path || '').trim()
}

/**
 * Probe the picked folder for git and load its branches.
 *
 * This is the whole of "is this a git project?": no stored flag, asked fresh each time. A
 * plain folder that gets `git init` later simply starts answering yes, and the branch
 * bubble appears on its own without ever announcing itself — which is what "notice and
 * turn it on quietly" has to mean if nothing records the answer.
 */
export async function probeNewChatFolder(path: string): Promise<void> {
  const target = path.trim()

  if (!target) {
    $newChatFolderIsRepo.set(false)
    $newChatBranches.set([])

    return
  }

  const isRepo = await isGitRepoPath(target)

  // The folder can change while the probe is in flight (a fast second pick). Drop a stale
  // answer rather than letting it describe a folder nobody is looking at.
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
 * reads, the cwd is what every workspace surface paints from. `null` means detached, which
 * is distinct from "not chosen yet" — it is an explicit no.
 *
 * Not exported as a user-facing action: the only folder a chat gets is its project's, and
 * picking a branch swaps it for that branch's checkout. Both go through here.
 */
async function pointDraftAt(path: null | string): Promise<void> {
  const target = (path ?? '').trim()

  setNewChatWorkspaceTarget(path === null ? null : target)
  setCurrentCwd(target)
  setCurrentBranch('')
  $newChatFolderIsRepo.set(false)
  $newChatBranches.set([])

  await probeNewChatFolder(target)
}

/**
 * Pick the project this chat works in — which is to say, its folder.
 *
 * `null` means no project, and therefore no folder: a detached chat, which is right for a
 * question that touches nothing. A project with no folder recorded leaves the chat where
 * it is rather than detaching it, since that is a half-made project, not a request.
 */
export async function setNewChatProject(id: null | string): Promise<void> {
  $newChatProjectId.set(id ?? '')

  if (!id) {
    await pointDraftAt(null)

    return
  }

  const folder = projectFolder($projects.get().find(candidate => candidate.id === id) ?? null)

  if (folder) {
    await pointDraftAt(folder)
  }
}

/**
 * Seed a draft from the remembered project.
 *
 * Called once per draft — the setup row keys this on the draft's workspace-target
 * generation, so clicking "New chat" again re-seeds rather than leaving the previous
 * draft's folder on screen.
 *
 * An explicit workspace target outranks the remembered project: the sidebar's "+" on a
 * folder, or a drag onto a zone, is a choice made for THIS chat, and a remembered one must
 * not overwrite it. Either way the folder is probed, because a branch bubble is owed to
 * any repo folder however it was chosen.
 */
export async function seedNewChatSetup(hasExplicitTarget: boolean): Promise<void> {
  const folder = hasExplicitTarget ? '' : projectFolder($newChatProject.get())

  await (folder ? pointDraftAt(folder) : probeNewChatFolder($currentCwd.get()))
}

/**
 * Work on `branch`: the chat runs in that branch's own checkout.
 *
 * One rule, and it is the safe one. A branch that already has a checkout gets that folder,
 * so a second chat continues the same unfinished work instead of cloning it into a rival
 * worktree — and the main checkout counts, because `git worktree list` reports it, so the
 * default branch resolves to the repo itself rather than a needless worktree beside it.
 * A branch with nowhere to live gets a worktree made for it.
 *
 * What this never does is check a different branch out in a folder someone else is using.
 * A shared checkout can have another session sitting in it mid-turn, and swapping its
 * branch would change the files under that conversation's feet. Picking a branch means
 * "work on this branch", never "make this folder be on this branch".
 *
 * It equally never invents a branch: starting a chat is not a reason to create one. Only
 * {@link createNewChatBranch}, reached by typing a name, does that.
 */
export async function workOnNewChatBranch(repoPath: string, branch: HermesGitBranch): Promise<void> {
  const home = branch.worktreePath || (await startWorkInRepo(repoPath, { existingBranch: branch.name }))?.path

  if (home) {
    await pointDraftAt(home)
    setCurrentBranch(branch.name)
  }
}

/**
 * Make `name` and work in it. The ONE path that creates a branch, and it is reached only
 * by typing a name into "New branch…" — never by starting a chat.
 */
export async function createNewChatBranch(repoPath: string, name: string, base?: string): Promise<void> {
  const branch = name.trim()

  if (!branch) {
    return
  }

  const created = await startWorkInRepo(repoPath, { base, branch })

  if (created) {
    await pointDraftAt(created.path)
    setCurrentBranch(created.branch)
  }
}
