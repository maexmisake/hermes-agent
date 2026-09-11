import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { DROPDOWN_KIT } from '@/components/ui/actions-menu'
import { Codicon } from '@/components/ui/codicon'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  dropdownMenuRow,
  dropdownMenuSectionLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import type { HermesGitBranch } from '@/global'
import type { SessionInfo } from '@/hermes'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { isGitRepoPath } from '@/store/coding-status'
import { notify, notifyError } from '@/store/notifications'
import {
  $groups,
  $projects,
  listRepoBranches,
  moveSessionWorkspace,
  pickProjectFolder,
  startWorkInRepo
} from '@/store/projects'

import { liveSessionProjectId } from './sidebar/projects/workspace-groups'
import { AddToGroupItems } from './sidebar/session-actions-menu'

/** One destination for the "work in" list: a project's folder, or a folder picked by hand. */
interface FolderTarget {
  folder: string
  label: string
}

/**
 * The live chat's context, beside its title: the project it works in and the branch it is
 * on, with a menu to inspect or change either.
 *
 * The project shown is the one that owns the chat's folder — there is no second, stored
 * answer that could disagree, because a project IS a working folder.
 *
 * Deliberately quiet. It is the same information the setup bubbles carried before the
 * first message, but this is a conversation now, not a decision being made, so it reads as
 * a caption on the title rather than a control competing with it.
 *
 * The menu's two halves are NOT the same weight, and the copy says so. Adding to a group
 * is organization: instant, reversible, and it moves nothing. Changing the project moves
 * the conversation — the agent's terminal and file tools start acting on a different
 * folder — so it asks first. That asymmetry is why the sidebar's row menu offers groups
 * only: the heavy action belongs here, where moving is what you came to do.
 */
export function SessionContextChip({ session }: { session: SessionInfo }) {
  const { t } = useI18n()
  const c = t.chat.context
  const projects = useStore($projects)
  const groups = useStore($groups)
  const [branches, setBranches] = useState<HermesGitBranch[]>([])
  const [pending, setPending] = useState<FolderTarget | null>(null)

  const sessionId = session.id
  const cwd = (session.cwd || '').trim()
  const branch = (session.git_branch || '').trim()
  const repoRoot = (session.git_repo_root || '').trim() || cwd

  const group = session.group_id?.trim() ? (groups.find(entry => entry.id === session.group_id) ?? null) : null
  const projectId = liveSessionProjectId(session, projects)
  const project = projectId ? (projects.find(candidate => candidate.id === projectId) ?? null) : null

  // Branches load on demand — the chip is on screen for every chat, and probing git for
  // one that is never opened would cost a subprocess per conversation.
  useEffect(() => {
    if (!repoRoot || !branch) {
      setBranches([])

      return
    }

    let cancelled = false

    void isGitRepoPath(repoRoot)
      .then(isRepo => (isRepo ? listRepoBranches(repoRoot) : []))
      .then(next => void (cancelled || setBranches(next)))
      .catch(() => void (cancelled || setBranches([])))

    return () => {
      cancelled = true
    }
  }, [repoRoot, branch])

  // The caption names the project the folder belongs to, falling back to the folder's own
  // name when no project claims it (an auto-discovered repo, or a loose directory).
  const place = project?.name || folderName(cwd)

  // Nothing to caption: a chat with no folder and no branch. Render nothing rather than an
  // empty chip — the title stands on its own.
  if (!place && !branch) {
    return null
  }

  const moveTo = (target: FolderTarget) => {
    moveSessionWorkspace(sessionId, target.folder, session.profile)
      .then(() => notify({ durationMs: 2_000, kind: 'success', message: c.moved(target.label) }))
      .catch(err => notifyError(err, c.moveFailed))
  }

  const pickBranch = (entry: HermesGitBranch) => {
    // The SAME rule as the new-chat picker, and for the same reason: picking a branch means
    // work on that branch. A branch with a checkout gets that folder (the main checkout
    // included, so the default branch resolves to the repo itself); one without gets a
    // worktree made. What this never does is check a different branch out in the folder
    // this chat shares — another session could be sitting in it mid-turn, and its files
    // would change underneath it.
    const home = entry.worktreePath
      ? Promise.resolve(entry.worktreePath)
      : startWorkInRepo(repoRoot, { existingBranch: entry.name }).then(created => created?.path ?? '')

    home
      .then(path => (path ? moveSessionWorkspace(sessionId, path, session.profile) : undefined))
      .then(() => notify({ durationMs: 2_000, kind: 'success', message: c.branchSwitched(entry.name) }))
      .catch(err => notifyError(err, c.branchFailed))
  }

  const otherProjects = projects.filter(candidate => !candidate.archived && candidate.id !== projectId)

  return (
    <>
      <DropdownMenu>
        <Tip label={cwd || place}>
          <DropdownMenuTrigger
            aria-label={c.label(place, branch)}
            className={cn(
              'pointer-events-auto ml-1.5 inline-flex min-w-0 max-w-48 shrink items-center gap-1 rounded-md px-1',
              'text-[0.6875rem] font-normal text-(--ui-text-quaternary) transition-colors',
              'hover:bg-(--chrome-action-hover) hover:text-(--ui-text-secondary)'
            )}
          >
            <span className="truncate">{place}</span>
            {branch && (
              <>
                <span aria-hidden="true" className="opacity-50">
                  ·
                </span>
                <Codicon name="git-branch" size="0.625rem" />
                <span className="truncate">{branch}</span>
              </>
            )}
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="start" className="max-h-96 w-64 overflow-y-auto" sideOffset={6}>
          {/* Inspect first: the full path is the thing you open this for most often, and it
              answers the question without any row having to be clicked. */}
          <div className={cn(dropdownMenuSectionLabel, 'text-(--ui-text-quaternary)')}>{c.folderTitle}</div>
          <div className="px-2.5 pb-1 text-[0.6875rem] leading-snug break-all text-(--ui-text-tertiary)">
            {cwd || c.noFolder}
          </div>
          {group && (
            <div className="px-2.5 pb-1.5 text-[0.6875rem] text-(--ui-text-tertiary)">{c.inGroup(group.name)}</div>
          )}
          <DropdownMenuSeparator />

          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={dropdownMenuRow}>
              <Codicon name="inbox" size="0.75rem" />
              {c.addToGroup}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
              {/* Organization only: a group names no folder, so nothing here moves. */}
              <AddToGroupItems kit={DROPDOWN_KIT} profile={session.profile} sessionId={sessionId} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          {branches.length > 0 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={dropdownMenuRow}>
                <Codicon name="git-branch" size="0.75rem" />
                {c.branchTitle}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 w-64 overflow-y-auto">
                {branches.map(entry => (
                  <DropdownMenuItem
                    className={dropdownMenuRow}
                    disabled={entry.name === branch}
                    key={entry.name}
                    onSelect={() => pickBranch(entry)}
                  >
                    <Codicon name={entry.isRemote ? 'cloud' : 'git-branch'} size="0.75rem" />
                    <span className="truncate">{entry.name}</span>
                    {entry.name === branch && <Codicon className="ml-auto" name="check" size="0.75rem" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          <DropdownMenuSeparator />
          {/* Moving the chat to another project means moving its folder, because they are
              the same thing. Every row here goes through the confirm below. */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={dropdownMenuRow}>
              <Codicon name="folder-library" size="0.75rem" />
              {c.changeProject}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
              {otherProjects.map(candidate => (
                <DropdownMenuItem
                  className={dropdownMenuRow}
                  disabled={!projectPath(candidate)}
                  key={candidate.id}
                  onSelect={() => setPending({ folder: projectPath(candidate), label: candidate.name })}
                >
                  <Codicon name={candidate.icon || 'folder-library'} size="0.75rem" />
                  <span className="truncate">{candidate.name}</span>
                </DropdownMenuItem>
              ))}
              {otherProjects.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem
                className={dropdownMenuRow}
                onSelect={() => {
                  void pickProjectFolder().then(
                    picked => picked && setPending({ folder: picked, label: folderName(picked) })
                  )
                }}
              >
                <Codicon name="folder-opened" size="0.75rem" />
                {c.chooseFolder}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* The one thing here that changes where work happens, so it asks. Groups never do. */}
      <ConfirmDialog
        confirmLabel={c.moveConfirmLabel}
        description={c.moveConfirm(pending?.label ?? '')}
        dismissOnConfirm
        onClose={() => setPending(null)}
        onConfirm={() => void (pending && moveTo(pending))}
        open={pending !== null}
        title={c.moveTitle}
      />
    </>
  )
}

/** A project's working folder: its primary path, else its first recorded folder. */
function projectPath(project: { folders?: { path: string }[]; primary_path?: null | string }): string {
  return (project.primary_path || project.folders?.[0]?.path || '').trim()
}

/** The last path segment — a folder's name, which is what a caption has room for. */
function folderName(path: string): string {
  const trimmed = path.trim().replace(/[/\\]+$/, '')

  return trimmed ? (trimmed.split(/[/\\]/).pop() ?? trimmed) : ''
}
