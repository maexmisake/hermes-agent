import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useState } from 'react'

import { composerFloatingPill } from '@/components/chat/composer-dock'
import { Codicon } from '@/components/ui/codicon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  dropdownMenuRow,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { HermesGitBranch } from '@/global'
import { useI18n } from '@/i18n'
import { displayPath } from '@/lib/display-path'
import { cn } from '@/lib/utils'
import {
  $newChatLooseWorkspaces,
  $newChatNewBranch,
  $newChatProfileKey,
  $newChatProject,
  $newChatProjects,
  $newChatRepo,
  $newChatWorkspace,
  addNewChatWorkspace,
  browseNewChatWorkspace,
  chooseNewBranch,
  createProjectForNewChat,
  keepCurrentBranch,
  loadNewChatProjects,
  probeNewChatWorkspace,
  projectMainWorkspace,
  samePath,
  setNewChatProject,
  setNewChatWorkspace
} from '@/store/new-session-setup'
import { notifyError } from '@/store/notifications'
import { $profileScope, ALL_PROFILES } from '@/store/profile'
import { listRepoBranches } from '@/store/projects'

const BUBBLE = cn(composerFloatingPill, 'max-w-44')
const MENU = 'max-h-80 w-64 overflow-y-auto'
const HINT = 'truncate text-[0.625rem] text-(--ui-text-quaternary)'

/**
 * The new-chat setup row above the composer: PROJECT, then WORKSPACE, then (only when
 * the workspace is a git repo) BRANCH. Shown until the first message is sent. Every
 * bubble reads the workspace Send will use, so what they show is what the chat gets.
 */
export function SessionSetupRow() {
  const { t } = useI18n()
  const s = t.composer.setup
  const projects = useStore($newChatProjects)
  const project = useStore($newChatProject)
  const workspace = useStore($newChatWorkspace)
  const repo = useStore($newChatRepo)
  const newBranch = useStore($newChatNewBranch)
  const looseWorkspaces = useStore($newChatLooseWorkspaces)
  const profileScope = useStore($profileScope)
  const draftProfile = useStore($newChatProfileKey)
  const [busy, setBusy] = useState(false)

  // Follow the workspace wherever it moves: a pick here, a new draft, a connection
  // switch, or a default folder that arrives late.
  useEffect(() => {
    void probeNewChatWorkspace(workspace)
  }, [workspace])

  // The projects to pick from are the chat's profile's: already loaded while viewing
  // one profile, fetched for this chat in "All profiles" view.
  useEffect(() => {
    void loadNewChatProjects()
  }, [profileScope, draftProfile])

  const run = (action: () => Promise<void> | void, failure: string) => {
    let pending: Promise<void> | void

    try {
      pending = action()
    } catch (error) {
      notifyError(error, failure)

      return
    }

    if (pending) {
      setBusy(true)
      void pending.catch(error => notifyError(error, failure)).finally(() => setBusy(false))
    }
  }

  // All profiles view keeps projects read-only: a folder can only be saved to a
  // project while viewing that project's profile. A project with no folder would
  // need one saved first, so it is not offered there.
  const canEditProjects = profileScope !== ALL_PROFILES

  const openProjects = projects.filter(
    candidate => !candidate.archived && (canEditProjects || Boolean(projectMainWorkspace(candidate)))
  )

  const workspaceListed = Boolean(project?.folders.some(folder => samePath(folder.path, workspace)))

  const pickWorkspace = (path: string, projectId?: string) =>
    samePath(path, workspace) ? undefined : () => run(() => setNewChatWorkspace(path, projectId), s.workspaceFailed)

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-slot="session-setup-row">
      <SetupBubble
        busy={busy}
        icon="folder-library"
        label={project?.name || s.noProject}
        onOpen={() => void loadNewChatProjects()}
        set={Boolean(project)}
        title={s.projectTitle}
      >
        {openProjects.length > 0 && (
          <>
            <DropdownMenuLabel>{s.projectTitle}</DropdownMenuLabel>
            {openProjects.map(candidate => (
              <SetupItem
                checked={candidate.id === project?.id}
                icon={candidate.icon || 'folder-library'}
                key={candidate.id}
                label={candidate.name}
                onSelect={() => run(() => setNewChatProject(candidate), s.projectFailed)}
              />
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <SetupItem
          checked={!project}
          icon="circle-slash"
          label={s.noProject}
          onSelect={() => run(() => setNewChatProject(null), s.projectFailed)}
        />
        {canEditProjects && <SetupItem icon="add" label={s.newProject} onSelect={createProjectForNewChat} />}
      </SetupBubble>

      <SetupBubble
        busy={busy}
        icon="folder"
        label={folderName(workspace) || s.noWorkspace}
        set={Boolean(workspace)}
        title={s.workspaceTitle}
      >
        {project ? (
          <>
            <DropdownMenuLabel>{project.name}</DropdownMenuLabel>
            {/* A workspace inside the project that is not one of its saved folders
                (a branch's own folder) is still where this chat works. */}
            {workspace && !workspaceListed && (
              <SetupItem checked hint={displayPath(workspace)} icon="folder" label={folderName(workspace)} />
            )}
            {project.folders.map(folder => (
              <SetupItem
                checked={samePath(folder.path, workspace)}
                hint={displayPath(folder.path)}
                icon="folder"
                key={folder.path}
                label={folderName(folder.path)}
                onSelect={pickWorkspace(folder.path, project.id)}
              />
            ))}
            {canEditProjects && (
              <>
                <DropdownMenuSeparator />
                <SetupItem
                  icon="add"
                  label={s.addWorkspace}
                  onSelect={() => run(() => addNewChatWorkspace(project), s.workspaceFailed)}
                />
              </>
            )}
          </>
        ) : (
          <>
            {looseWorkspaces.length > 0 && (
              <>
                <DropdownMenuLabel>{s.recentWorkspaces}</DropdownMenuLabel>
                {looseWorkspaces.map(path => (
                  <SetupItem
                    checked={samePath(path, workspace)}
                    hint={displayPath(path)}
                    icon="folder"
                    key={path}
                    label={folderName(path)}
                    onSelect={pickWorkspace(path)}
                  />
                ))}
                <DropdownMenuSeparator />
              </>
            )}
            <SetupItem
              icon="folder-opened"
              label={s.browseWorkspace}
              onSelect={() => run(browseNewChatWorkspace, s.workspaceFailed)}
            />
            <SetupItem
              checked={!workspace}
              icon="circle-slash"
              label={s.noWorkspace}
              onSelect={() => run(() => setNewChatWorkspace(null), s.workspaceFailed)}
            />
          </>
        )}
      </SetupBubble>

      {repo?.isRepo && (
        <BranchBubble branch={repo.branch} busy={busy} newBranchBase={newBranch?.base ?? null} workspace={workspace} />
      )}
    </div>
  )
}

/** The last path segment: the folder's name, which is what a bubble has room for. */
function folderName(path: string): string {
  const trimmed = path.trim().replace(/[/\\]+$/, '')

  return trimmed ? (trimmed.split(/[/\\]/).pop() ?? trimmed) : ''
}

function SetupBubble({
  busy,
  children,
  icon,
  label,
  onOpen,
  set,
  title
}: {
  busy: boolean
  children: ReactNode
  icon: string
  label: string
  onOpen?: () => void
  set: boolean
  title: string
}) {
  return (
    <DropdownMenu onOpenChange={open => open && onOpen?.()}>
      <DropdownMenuTrigger
        aria-label={`${title}: ${label}`}
        className={cn(BUBBLE, !set && 'text-(--ui-text-tertiary)', busy && 'pointer-events-none opacity-60')}
        disabled={busy}
      >
        <Codicon name={icon} size="0.75rem" />
        <span className="truncate">{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={MENU} side="top">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** One menu choice: a label, an optional quiet second line, and a check when it is the current one. */
function SetupItem({
  checked = false,
  hint,
  icon,
  label,
  onSelect
}: {
  checked?: boolean
  hint?: string
  icon: string
  label: string
  onSelect?: () => void
}) {
  return (
    <DropdownMenuItem className={dropdownMenuRow} onSelect={onSelect}>
      <Codicon name={icon} size="0.75rem" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{label}</span>
        {hint && <span className={HINT}>{hint}</span>}
      </span>
      {checked && <Codicon className="ml-auto shrink-0" name="check" size="0.75rem" />}
    </DropdownMenuItem>
  )
}

/**
 * BRANCH: keep working on the branch the workspace is on (a fresh chat, same folder,
 * nothing changes in git), or a new branch. A new branch is only REMEMBERED here; it is
 * made when the first message is sent, named from that message, in its own folder so
 * no other chat's files change. It starts from the workspace's branch unless another
 * is picked under "Start from".
 */
function BranchBubble({
  branch,
  busy,
  newBranchBase,
  workspace
}: {
  branch: string
  busy: boolean
  newBranchBase: null | string
  workspace: string
}) {
  const { t } = useI18n()
  const s = t.composer.setup
  const [branches, setBranches] = useState<HermesGitBranch[]>([])
  const current = branch || 'HEAD'
  const choosing = newBranchBase !== null
  const base = newBranchBase || branch
  const localBranches = branches.filter(candidate => !candidate.isRemote)

  const loadBranches = () => {
    void listRepoBranches(workspace)
      .then(setBranches)
      .catch(() => setBranches([]))
  }

  return (
    <DropdownMenu onOpenChange={open => open && loadBranches()}>
      <DropdownMenuTrigger
        aria-label={`${s.branchTitle}: ${choosing ? s.newBranchLabel : current}`}
        className={cn(BUBBLE, busy && 'pointer-events-none opacity-60')}
        disabled={busy}
      >
        <Codicon name={choosing ? 'add' : 'git-branch'} size="0.75rem" />
        <span className="truncate">{choosing ? s.newBranchLabel : current}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={MENU} side="top">
        <SetupItem
          checked={!choosing}
          hint={s.keepWorkingHint}
          icon="git-branch"
          label={s.keepWorking(current)}
          onSelect={keepCurrentBranch}
        />
        <SetupItem
          checked={choosing}
          hint={s.newBranchHint}
          icon="add"
          label={s.newBranch}
          onSelect={() => chooseNewBranch(base)}
        />
        {choosing && localBranches.length > 1 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={dropdownMenuRow}>{s.startFrom(base || current)}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
              {localBranches.map(candidate => (
                <SetupItem
                  checked={candidate.name === base}
                  icon="git-branch"
                  key={candidate.name}
                  label={candidate.name}
                  onSelect={() => chooseNewBranch(candidate.name)}
                />
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
