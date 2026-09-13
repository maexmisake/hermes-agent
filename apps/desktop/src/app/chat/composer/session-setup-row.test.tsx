import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectInfo } from '@/hermes'
import type * as CodingStatusStore from '@/store/coding-status'
import { $showAllProfiles } from '@/store/profile'
import { $projects } from '@/store/projects'
import type * as ProjectsStore from '@/store/projects'
import { setCurrentCwdTransient, setNewChatWorkspaceTarget } from '@/store/session'

import { SessionSetupRow } from './session-setup-row'

const stores = vi.hoisted(() => ({
  isGitRepoPath: vi.fn(),
  listProjectsForProfile: vi.fn()
}))

vi.mock('@/store/projects', async importOriginal => ({
  ...(await importOriginal<typeof ProjectsStore>()),
  listProjectsForProfile: stores.listProjectsForProfile
}))

vi.mock('@/store/coding-status', async importOriginal => ({
  ...(await importOriginal<typeof CodingStatusStore>()),
  isGitRepoPath: stores.isGitRepoPath
}))

function project(id: string, folders: string[]): ProjectInfo {
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
    slug: id
  } as ProjectInfo
}

const PROJECTS = [project('pets', ['/ws/pets']), project('empty', [])]

async function openMenu(name: RegExp) {
  const trigger = screen.getByRole<HTMLButtonElement>('button', { name })

  // The bubbles stay disabled while a pick is still being applied.
  await waitFor(() => expect(trigger.disabled).toBe(false))

  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
  fireEvent.pointerUp(trigger, { button: 0, pointerType: 'mouse' })
  fireEvent.click(trigger)

  return within(await screen.findByRole('menu'))
}

beforeEach(() => {
  stores.isGitRepoPath.mockResolvedValue(false)
  stores.listProjectsForProfile.mockResolvedValue(PROJECTS)
  $projects.set(PROJECTS)
  setNewChatWorkspaceTarget(undefined)
  setCurrentCwdTransient('')
})

afterEach(() => {
  cleanup()
  $showAllProfiles.set(false)
  vi.clearAllMocks()
})

describe('SessionSetupRow', () => {
  it('offers every project and "New project…" while viewing one profile', async () => {
    render(<SessionSetupRow />)

    const menu = await openMenu(/^Project:/)

    expect(menu.getByRole('menuitem', { name: 'pets' })).toBeTruthy()
    expect(menu.getByRole('menuitem', { name: 'empty' })).toBeTruthy()
    expect(menu.getByRole('menuitem', { name: 'New project…' })).toBeTruthy()
  })

  it('in "All profiles" view still offers every project, "New project…" and "Add workspace…"', async () => {
    $showAllProfiles.set(true)
    render(<SessionSetupRow />)

    const projectMenu = await openMenu(/^Project:/)

    expect(await projectMenu.findByRole('menuitem', { name: 'pets' })).toBeTruthy()
    expect(projectMenu.getByRole('menuitem', { name: 'empty' })).toBeTruthy()
    expect(projectMenu.getByRole('menuitem', { name: 'New project…' })).toBeTruthy()

    fireEvent.click(projectMenu.getByRole('menuitem', { name: 'pets' }))

    const workspaceMenu = await openMenu(/^Workspace: pets$/)

    expect(workspaceMenu.getByRole('menuitem', { name: /^pets/ })).toBeTruthy()
    expect(workspaceMenu.getByRole('menuitem', { name: 'Add workspace…' })).toBeTruthy()
  })
})
