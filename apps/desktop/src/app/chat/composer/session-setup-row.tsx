import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { composerFloatingPill } from '@/components/chat/composer-dock'
import { Codicon } from '@/components/ui/codicon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  dropdownMenuRow,
  DropdownMenuSearch,
  dropdownMenuSectionLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import type { HermesGitBranch } from '@/global'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  $newChatBranches,
  $newChatBranchesLoading,
  $newChatFolderIsRepo,
  $newChatProject,
  createNewChatBranch,
  seedNewChatSetup,
  setNewChatFolder,
  setNewChatProject,
  workOnNewChatBranch
} from '@/store/new-session-setup'
import { notifyError } from '@/store/notifications'
import { $projects, openProjectCreate, pickProjectFolder } from '@/store/projects'
import { $currentBranch, $currentCwd, $newChatWorkspaceTargetGeneration } from '@/store/session'

/**
 * The new-chat setup row: three bubbles above the composer that say what this chat is
 * about to work on, shown only until the first message is sent.
 *
 * They are an OFFER, never a form. A chat can start with all three empty, and each is
 * editable right up to the send — which is why they live here, above the composer, and
 * not in a dialog you have to get through first. After the send the chat is an ordinary
 * conversation and the row is gone; the context moves to the quiet chip by the title.
 *
 * The three are not independent. A project offers its folder, and a folder that turns
 * out to be a git repo grows a branch bubble. A plain folder never shows one: the
 * settled shape is that a project IS a folder, and git is a property that folder either
 * has or doesn't, asked fresh each time rather than recorded.
 */
export function SessionSetupRow() {
  const generation = useStore($newChatWorkspaceTargetGeneration)

  // Re-seed per draft rather than per mount: the row stays mounted when "New chat" is
  // pressed while already on a draft, and the generation is what actually ticks there.
  return <SetupBubbles key={generation} />
}

function SetupBubbles() {
  const { t } = useI18n()
  const s = t.composer.setup
  const projects = useStore($projects)
  const project = useStore($newChatProject)
  const cwd = useStore($currentCwd)
  const branch = useStore($currentBranch)
  const isRepo = useStore($newChatFolderIsRepo)
  const branches = useStore($newChatBranches)
  const branchesLoading = useStore($newChatBranchesLoading)
  const [busy, setBusy] = useState(false)

  // Seed from the remembered project once this draft starts. An explicit target (the
  // sidebar's "+" on a folder) already put a cwd here and outranks the memory.
  useEffect(() => {
    void seedNewChatSetup(Boolean($currentCwd.get().trim()))
  }, [])

  const run = (action: () => Promise<void>, failure: string) => {
    setBusy(true)
    action()
      .catch(err => notifyError(err, failure))
      .finally(() => setBusy(false))
  }

  const openProjects = projects.filter(candidate => !candidate.archived)

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-slot="session-setup-row">
      <SetupBubble
        busy={busy}
        icon="folder-library"
        label={project?.name || s.noProject}
        set={Boolean(project)}
        title={s.projectTitle}
      >
        {openProjects.length > 0 && (
          <>
            <div className={cn(dropdownMenuSectionLabel, 'text-(--ui-text-quaternary)')}>{s.projectTitle}</div>
            {openProjects.map(candidate => (
              <DropdownMenuItem
                className={dropdownMenuRow}
                key={candidate.id}
                onSelect={() => run(() => setNewChatProject(candidate.id), s.projectFailed)}
              >
                <Codicon name={candidate.icon || 'folder-library'} size="0.75rem" />
                <span className="truncate">{candidate.name}</span>
                {candidate.id === project?.id && <Codicon className="ml-auto" name="check" size="0.75rem" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          className={dropdownMenuRow}
          onSelect={() => run(() => setNewChatProject(null), s.projectFailed)}
        >
          <Codicon name="circle-slash" size="0.75rem" />
          {s.noProject}
        </DropdownMenuItem>
        <DropdownMenuItem className={dropdownMenuRow} onSelect={openProjectCreate}>
          <Codicon name="add" size="0.75rem" />
          {s.newProject}
        </DropdownMenuItem>
      </SetupBubble>

      <SetupBubble busy={busy} icon="folder" label={folderLabel(cwd) || s.noFolder} set={Boolean(cwd)} title={s.folderTitle}>
        {/* A project's own folders first: picking the project offered one, and these
            are the rest of the same project, which is the likeliest second choice. */}
        {(project?.folders.length ?? 0) > 1 && (
          <>
            <div className={cn(dropdownMenuSectionLabel, 'text-(--ui-text-quaternary)')}>{project?.name}</div>
            {project?.folders.map(folder => (
              <DropdownMenuItem
                className={dropdownMenuRow}
                key={folder.path}
                onSelect={() => run(() => setNewChatFolder(folder.path), s.folderFailed)}
              >
                <Codicon name="folder" size="0.75rem" />
                <span className="truncate">{folderLabel(folder.path)}</span>
                {folder.path === cwd && <Codicon className="ml-auto" name="check" size="0.75rem" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          className={dropdownMenuRow}
          onSelect={() =>
            run(async () => {
              const picked = await pickProjectFolder()

              if (picked) {
                await setNewChatFolder(picked)
              }
            }, s.folderFailed)
          }
        >
          <Codicon name="folder-opened" size="0.75rem" />
          {s.chooseFolder}
        </DropdownMenuItem>
        <DropdownMenuItem className={dropdownMenuRow} onSelect={() => run(() => setNewChatFolder(null), s.folderFailed)}>
          <Codicon name="circle-slash" size="0.75rem" />
          {s.noFolder}
        </DropdownMenuItem>
      </SetupBubble>

      {/* Only a git folder gets one. Nothing records that a folder "is a git project":
          it is probed on every pick, so one that gets `git init` later simply starts
          showing this, and one that stops being a repo stops. */}
      {isRepo && (
        <BranchBubble
          branch={branch}
          branches={branches}
          busy={busy}
          loading={branchesLoading}
          onCreate={(name, base) => run(() => createNewChatBranch(cwd, name, base), s.branchFailed)}
          onPick={picked => run(() => workOnNewChatBranch(cwd, picked), s.branchFailed)}
        />
      )}
    </div>
  )
}

/** The last path segment — the folder's name, which is what the bubble has room for. */
function folderLabel(path: string): string {
  const trimmed = path.trim().replace(/[/\\]+$/, '')

  return trimmed ? (trimmed.split(/[/\\]/).pop() ?? trimmed) : ''
}

function SetupBubble({
  busy,
  children,
  icon,
  label,
  set,
  title
}: {
  busy: boolean
  children: React.ReactNode
  icon: string
  label: string
  set: boolean
  title: string
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${title}: ${label}`}
        className={cn(
          composerFloatingPill,
          'max-w-44',
          // An unset bubble is quieter than a set one: the row should read as an
          // offer you can ignore, not three blanks demanding to be filled.
          !set && 'text-(--ui-text-tertiary)',
          busy && 'pointer-events-none opacity-60'
        )}
        disabled={busy}
      >
        <Codicon name={icon} size="0.75rem" />
        <span className="truncate">{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto" side="top">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The branch bubble.
 *
 * Picking an existing branch never makes one: a branch with a checkout already gets
 * that folder back (so a second chat continues the same unfinished work), and one
 * without gets a worktree made for it. Making a branch is only ever reached by typing
 * a name into the last row, because opening a chat is not a request for a new branch.
 */
function BranchBubble({
  branch,
  branches,
  busy,
  loading,
  onCreate,
  onPick
}: {
  branch: string
  branches: HermesGitBranch[]
  busy: boolean
  loading: boolean
  onCreate: (name: string, base?: string) => void
  onPick: (branch: HermesGitBranch) => void
}) {
  const { t } = useI18n()
  const s = t.composer.setup
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)

  const needle = query.trim().toLowerCase()
  const matches = needle ? branches.filter(entry => entry.name.toLowerCase().includes(needle)) : branches
  // The typed name is only offered when it is not already a branch — otherwise the
  // row would propose creating something the list above it can just open.
  const canCreate = Boolean(needle) && !branches.some(entry => entry.name.toLowerCase() === needle)
  const defaultBase = branches.find(entry => entry.isDefault)?.name

  return (
    <DropdownMenu
      onOpenChange={next => {
        setOpen(next)

        if (!next) {
          setQuery('')
        }
      }}
      open={open}
    >
      <DropdownMenuTrigger
        aria-label={`${s.branchTitle}: ${branch || s.noBranch}`}
        className={cn(
          composerFloatingPill,
          'max-w-44',
          !branch && 'text-(--ui-text-tertiary)',
          busy && 'pointer-events-none opacity-60'
        )}
        disabled={busy}
      >
        <Codicon name="git-branch" size="0.75rem" />
        <span className="truncate">{branch || s.noBranch}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto" side="top">
        <DropdownMenuSearch onValueChange={setQuery} placeholder={s.branchSearch} value={query} />
        <DropdownMenuSeparator />
        {loading && (
          <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-(--ui-text-tertiary)">
            <GlyphSpinner ariaLabel={s.branchLoading} className="text-[0.6875rem]" />
            {s.branchLoading}
          </div>
        )}
        {!loading && matches.length === 0 && !canCreate && (
          <div className="px-2.5 py-1.5 text-xs text-(--ui-text-tertiary)">{s.branchEmpty}</div>
        )}
        {matches.map(entry => (
          <DropdownMenuItem className={dropdownMenuRow} key={entry.name} onSelect={() => onPick(entry)}>
            <Codicon name={entry.isRemote ? 'cloud' : 'git-branch'} size="0.75rem" />
            <span className="truncate">{entry.name}</span>
            {/* The one thing worth saying about a branch here: it already has a folder,
                so choosing it continues that work rather than starting a copy. */}
            {entry.worktreePath && (
              <span className="ml-auto shrink-0 text-[0.625rem] text-(--ui-text-quaternary)">{s.branchOpen}</span>
            )}
          </DropdownMenuItem>
        ))}
        {canCreate && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className={dropdownMenuRow}
              onSelect={() => {
                onCreate(query.trim(), defaultBase)
                setQuery('')
              }}
            >
              <Codicon name="add" size="0.75rem" />
              <span className="truncate">{s.newBranch(query.trim())}</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
