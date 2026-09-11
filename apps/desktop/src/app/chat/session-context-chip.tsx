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
  startWorkInRepo,
  switchBranchInRepo
} from '@/store/projects'

import { liveSessionProjectId } from './sidebar/projects/workspace-groups'
import { MoveToProjectItems } from './sidebar/session-actions-menu'

/**
 * The live chat's context, beside its title: which project it is filed under and
 * which branch it is on, and a menu to inspect or change either.
 *
 * Deliberately quiet. It is the same information the setup bubbles carried before the
 * first message, but this is a conversation now, not a decision being made — so it
 * reads as a caption on the title rather than a control competing with it.
 *
 * The menu's two halves are NOT the same weight, and the copy says so. Filing under a
 * project is organization: instant, reversible, and it moves nothing. Changing the
 * folder re-homes the conversation — the agent's terminal and file tools start acting
 * on a different checkout — so it asks first. That asymmetry is the whole reason the
 * sidebar's "move to project" files instead of moving: the heavy one belongs here,
 * where changing where the work happens is what you came to do.
 */
export function SessionContextChip({ session }: { session: SessionInfo }) {
  const { t } = useI18n()
  const c = t.chat.context
  const projects = useStore($projects)
  const groups = useStore($groups)
  const [branches, setBranches] = useState<HermesGitBranch[]>([])
  const [pendingFolder, setPendingFolder] = useState<null | string>(null)

  const sessionId = session.id
  const cwd = (session.cwd || '').trim()
  const branch = (session.git_branch || '').trim()
  const repoRoot = (session.git_repo_root || '').trim() || cwd

  const filedGroup = session.group_id?.trim()
    ? (groups.find(group => group.id === session.group_id) ?? null)
    : null

  const projectId = filedGroup ? null : liveSessionProjectId(session, projects)
  const project = projectId ? (projects.find(candidate => candidate.id === projectId) ?? null) : null

  // Branches load on demand — the chip is on screen for every chat, and probing git
  // for one that is never opened would cost a subprocess per conversation.
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

  // The place label is the FILING, which can differ from the folder — that is the
  // point of filing. Fall back to the folder's own name so a chat nobody filed still
  // says where it runs rather than showing nothing.
  const place = filedGroup?.name || project?.name || folderName(cwd)

  // Nothing to caption: an unfiled chat with no folder and no branch. Render nothing
  // rather than an empty chip — the title stands on its own.
  if (!place && !branch) {
    return null
  }

  const move = (folder: string) => {
    moveSessionWorkspace(sessionId, folder, session.profile)
      .then(() => notify({ durationMs: 2_000, kind: 'success', message: c.folderMoved(folderName(folder)) }))
      .catch(err => notifyError(err, c.folderMoveFailed))
  }

  const pickBranch = (entry: HermesGitBranch) => {
    // On a LIVE chat a branch change means this checkout, not a new worktree: the
    // conversation is already anchored to this folder, and swapping the folder under
    // it is the heavier move the folder rows below own.
    const work = entry.worktreePath
      ? moveSessionWorkspace(sessionId, entry.worktreePath, session.profile)
      : entry.isRemote
        ? startWorkInRepo(repoRoot, { existingBranch: entry.name }).then(
            created => void (created && moveSessionWorkspace(sessionId, created.path, session.profile))
          )
        : switchBranchInRepo(repoRoot, entry.name)

    work
      .then(() => notify({ durationMs: 2_000, kind: 'success', message: c.branchSwitched(entry.name) }))
      .catch(err => notifyError(err, c.branchFailed))
  }

  return (
    <>
      <DropdownMenu>
        <Tip label={cwd || place}>
          <DropdownMenuTrigger
            aria-label={c.label(place || folderName(cwd), branch)}
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
          {/* Inspect first: the full path is the thing you open this for most often,
              and it answers the question without any row having to be clicked. */}
          <div className={cn(dropdownMenuSectionLabel, 'text-(--ui-text-quaternary)')}>{c.folderTitle}</div>
          <div className="px-2.5 pb-1 text-[0.6875rem] leading-snug break-all text-(--ui-text-tertiary)">
            {cwd || c.noFolder}
          </div>
          <DropdownMenuSeparator />

          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={dropdownMenuRow}>
              <Codicon name="folder-library" size="0.75rem" />
              {c.fileUnder}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
              {/* Organization only, and the same destinations the sidebar offers —
                  one list of places, reachable from either end. */}
              <MoveToProjectItems kit={DROPDOWN_KIT} profile={session.profile} sessionId={sessionId} />
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
          <DropdownMenuItem
            className={dropdownMenuRow}
            onSelect={() => {
              void pickProjectFolder().then(picked => picked && setPendingFolder(picked))
            }}
          >
            <Codicon name="folder-opened" size="0.75rem" />
            {c.changeFolder}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* The one destructive-ish thing here, so it asks. Filing never does. */}
      <ConfirmDialog
        confirmLabel={c.changeFolder}
        description={c.folderMoveConfirm(folderName(pendingFolder ?? ''))}
        dismissOnConfirm
        onClose={() => setPendingFolder(null)}
        onConfirm={() => void (pendingFolder && move(pendingFolder))}
        open={pendingFolder !== null}
        title={c.folderMoveTitle}
      />
    </>
  )
}

/** The last path segment — a folder's name, which is what a caption has room for. */
function folderName(path: string): string {
  const trimmed = path.trim().replace(/[/\\]+$/, '')

  return trimmed ? (trimmed.split(/[/\\]/).pop() ?? trimmed) : ''
}
