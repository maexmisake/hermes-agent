import { useStore } from '@nanostores/react'
import type * as React from 'react'
import { useEffect, useRef } from 'react'

import { type NewSessionSplitHandler, startNewSessionDrag } from '@/app/chat/new-session-drag'
import { Codicon } from '@/components/ui/codicon'
import { FadeText } from '@/components/ui/fade-text'
import { Tip } from '@/components/ui/tooltip'
import type { SessionInfo } from '@/hermes'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { $sidebarProjectReveal } from '@/store/layout'

import {
  SIDEBAR_LEAD_ICON_SIZE,
  SidebarGroupRow,
  SidebarRowGrab,
  SidebarRowLabel,
  SidebarRowLead,
  SidebarRowLeadGlyph,
  SidebarRowLink,
  SidebarRowNest
} from '../chrome'

import { latestProjectSessions, useWorkspaceNodeOpen } from './model'
import { ProjectContextMenu, ProjectMenu } from './project-menu'
import type { SidebarProjectTree } from './workspace-groups'
import { WorkspaceAddButton } from './workspace-header'

// A bare color dot (no icon) or an icon glyph — tinted by `color` when set, else
// the lead's default tertiary. The glyph wrapper centers + caps size either way.
// Auto-discovered repos (git lanes Desktop found by scanning disk, not rows in
// projects.db) get the `repo` glyph so a glance tells explicit projects
// (`folder-library`) apart from incidental disk/session findings.
export function projectIcon({ color, icon, isAuto, isNoProject }: SidebarProjectTree) {
  if (color && !icon) {
    return (
      <SidebarRowLeadGlyph>
        <span aria-hidden="true" className="size-1 rounded-full" style={{ backgroundColor: color }} />
      </SidebarRowLeadGlyph>
    )
  }

  return (
    <SidebarRowLeadGlyph style={color ? { color } : undefined}>
      <Codicon
        name={icon || (isNoProject ? 'home' : isAuto ? 'repo' : 'folder-library')}
        size={SIDEBAR_LEAD_ICON_SIZE}
      />
    </SidebarRowLeadGlyph>
  )
}

interface ProjectOverviewRowProps {
  project: SidebarProjectTree
  onNewSession?: (path: null | string) => void
  /** Drag the project's "+" onto a chat zone: create a new session pinned to
   *  this project's cwd, placed exactly where it's dropped. */
  onNewSessionSplit?: NewSessionSplitHandler
  /** Opening the folder asks for the project's complete chat list. Set only when
   *  the sidebar's tree may not hold every chat. */
  onNeedAllSessions?: (id: string) => void
  renderRows?: (sessions: SessionInfo[]) => React.ReactNode
  activeProjectId?: null | string
  previewSessions?: SessionInfo[]
  reorderable?: boolean
  dragging?: boolean
  dragHandleProps?: React.HTMLAttributes<HTMLElement>
  ref?: React.Ref<HTMLDivElement>
  style?: React.CSSProperties
}

export function ProjectOverviewRow({
  project,
  onNewSession,
  onNewSessionSplit,
  onNeedAllSessions,
  renderRows,
  activeProjectId,
  previewSessions,
  reorderable = false,
  dragging = false,
  dragHandleProps,
  ref,
  style
}: ProjectOverviewRowProps) {
  const { t } = useI18n()
  const s = t.sidebar
  const isActive = project.id === activeProjectId
  // A project is a folder that opens in place, closed until opened, and an open
  // one lists ALL its chats — there is no drill-in that hides the rest.
  const [open, toggleOpen] = useWorkspaceNodeOpen(project.id, false)
  // The appearance popover anchors here (the full row) so it opens flush with
  // the sidebar's content edge regardless of which side the sidebar is on.
  const rowRef = useRef<HTMLDivElement>(null)
  const reveal = useStore($sidebarProjectReveal)
  const fetched = previewSessions ?? []
  const preview = renderRows ? (fetched.length ? fetched : latestProjectSessions(project, Infinity)) : []
  const hasChats = preview.length > 0

  // ⌘K "go to project" brings this row into view.
  useEffect(() => {
    if (reveal?.id === project.id) {
      rowRef.current?.scrollIntoView?.({ block: 'nearest' })
    }
  }, [reveal, project.id])

  useEffect(() => {
    if (open && onNeedAllSessions) {
      onNeedAllSessions(project.id)
    }
  }, [open, onNeedAllSessions, project.id])

  const lead = reorderable ? (
    <SidebarRowGrab
      ariaLabel={s.projects.reorder(project.label)}
      dragging={dragging}
      dragHandleProps={dragHandleProps}
      leadClassName="overflow-visible"
    >
      {projectIcon(project)}
    </SidebarRowGrab>
  ) : (
    <SidebarRowLead>{projectIcon(project)}</SidebarRowLead>
  )

  // The label span is inline, so its `truncate` never clips: a long name runs
  // through the caret and under the row's buttons until the sidebar list cuts it
  // off at the row's edge. FadeText clips it in a block and fades it out before
  // the caret.
  const name = <FadeText fadeWidth="1rem">{project.label}</FadeText>
  // The glyph is aria-hidden and the tooltip only speaks on hover, so the
  // accessible name carries the auto-discovered cue itself.
  const autoCue = project.isAuto ? ` (${s.projects.autoDiscovered})` : ''

  // With chats, the name is the folder's one disclosure: it opens and closes the
  // folder and says whether it is open. Without chats there is nothing to open,
  // so the name is plain text.
  const label = hasChats ? (
    <SidebarRowLink
      aria-expanded={open}
      aria-label={`${s.projects.toggle(project.label, !open)}${autoCue}`}
      labelClassName={cn('hover:text-foreground hover:underline', isActive && 'text-foreground')}
      onClick={toggleOpen}
    >
      {name}
    </SidebarRowLink>
  ) : (
    <SidebarRowLabel className={cn(isActive && 'text-foreground')}>
      {name}
      {autoCue && <span className="sr-only">{autoCue}</span>}
    </SidebarRowLabel>
  )

  const shell = (
    <SidebarGroupRow
      actions={
        <>
          {/* Home is a bucket, not a record, so there's nothing to rename or
              delete — but it still starts sessions: a null path is the "no
              folder" chat. New session sits outermost: it's the one you reach
              for. */}
          {!project.isNoProject && <ProjectMenu anchorRef={rowRef} isActive={isActive} project={project} />}
          {onNewSession && (
            <WorkspaceAddButton
              label={s.newSessionIn(project.label)}
              onClick={() => onNewSession(project.path)}
              onPointerDown={
                onNewSessionSplit
                  ? event => {
                      // Drag the "+" onto a chat zone: create the session
                      // pinned to this project's cwd, exactly where it's
                      // dropped. A sub-threshold release falls through to the
                      // onClick above (ordinary new session in main).
                      startNewSessionDrag(
                        placement => {
                          onNewSessionSplit(placement.dir, {
                            anchor: placement.anchor,
                            before: placement.before,
                            cwd: project.path
                          })
                        },
                        event,
                        { cwd: project.path, label: s.newSessionIn(project.label) }
                      )
                    }
                  : undefined
              }
            />
          )}
        </>
      }
      actionsOnHover
      className={cn(dragging && 'cursor-grabbing bg-(--ui-sidebar-surface-background)')}
      data-glass-opaque={dragging ? '' : undefined}
      label={project.isAuto ? <Tip label={s.projects.autoDiscovered}>{label}</Tip> : label}
      lead={lead}
      // The label is grab surface too, not just the lead's grabber — same
      // listeners, minus the controls that keep their own gestures. A project
      // row has no rival drag (its title opens the folder on CLICK), so the
      // sortable owns the press outright.
      {...dragHandleProps}
      onPointerDown={event => {
        if ((event.target as HTMLElement).closest('[data-reorder-handle], [data-row-actions]')) {
          return
        }

        dragHandleProps?.onPointerDown?.(event)
      }}
      ref={rowRef}
      toggle={
        hasChats
          ? { ariaLabel: s.projects.toggle(project.label, !open), labelToggles: true, onToggle: toggleOpen, open }
          : undefined
      }
      totals={{ costUsd: project.totalCostUsd ?? 0, tokens: project.totalTokens ?? 0 }}
    />
  )

  return (
    // Tag each project sibling with its id so a custom skin can target one
    // project in the overview. Present on every row of the list.
    <div className={cn(dragging && 'relative z-10')} data-sessions-project={project.id} ref={ref} style={style}>
      {/* Home has no per-project actions, so it gets no right-click menu. */}
      {project.isNoProject ? (
        shell
      ) : (
        <ProjectContextMenu isActive={isActive} project={project}>
          {shell}
        </ProjectContextMenu>
      )}
      {open && hasChats && <SidebarRowNest>{renderRows?.(preview)}</SidebarRowNest>}
    </div>
  )
}
