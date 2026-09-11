import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NO_PROJECT_ID, type SidebarProjectTree } from '@/app/chat/sidebar/projects/workspace-groups'
import { $sidebarProjectsOpen, workspaceNodeOpen } from '@/store/layout'
import { $activeGatewayProfile, $profileScope, ALL_PROFILES, setShowAllProfiles } from '@/store/profile'
import { $currentCwd, $selectedStoredSessionId, $sessions, applyConfiguredDefaultProjectDir } from '@/store/session'

import {
  $activeProjectId,
  $groupTree,
  $projects,
  $projectsRpcAvailable,
  $projectTree,
  $worktreeRefreshToken,
  createProject,
  fetchProjectSessions,
  fileSession,
  fileSessionUnderNode,
  openProjectCreate,
  pickProjectFolder,
  projectIdForCwd,
  projectNameForCwd,
  refreshProjects,
  refreshProjectTree,
  refreshWorktrees,
  resolveNewSessionCwd,
  revealProject,
  scanAndRecordRepos,
  startWorkInRepo
} from './projects'
import {
  $removedSessionIds,
  $sessionMutationsInFlight,
  beginSessionMutation,
  endSessionMutation,
  tombstoneSessions
} from './session-removal'

vi.mock('@/i18n', () => ({
  translateNow: (key: string) => key
}))

vi.mock('@/store/notifications', () => ({
  notify: vi.fn()
}))

vi.mock('@/lib/desktop-fs', () => ({
  desktopDefaultCwd: vi.fn(),
  isDesktopFsRemoteMode: vi.fn(),
  selectDesktopPaths: vi.fn(),
  writeDesktopFileText: vi.fn()
}))

vi.mock('@/store/gateway', () => ({
  $gateway: atom(null),
  activeGateway: vi.fn(),
  ensureActiveGatewayOpen: vi.fn()
}))

vi.mock('@/lib/desktop-git', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  desktopGit: vi.fn()
}))

vi.mock('@/hermes', () => ({
  getHermesConfig: vi.fn(),
  getProfiles: vi.fn(),
  hermesApi: vi.fn(),
  setApiRequestProfile: vi.fn(),
  STARTUP_REQUEST_TIMEOUT_MS: 1000
}))

const fs = await import('@/lib/desktop-fs')
const desktopDefaultCwd = vi.mocked(fs.desktopDefaultCwd)
const isDesktopFsRemoteMode = vi.mocked(fs.isDesktopFsRemoteMode)
const selectDesktopPaths = vi.mocked(fs.selectDesktopPaths)

const gw = await import('@/store/gateway')
const activeGateway = vi.mocked(gw.activeGateway)
const gatewayAtom = gw.$gateway

const git = await import('@/lib/desktop-git')
const desktopGit = vi.mocked(git.desktopGit)

const hermes = await import('@/hermes')
const getHermesConfig = vi.mocked(hermes.getHermesConfig)
const notifications = await import('@/store/notifications')
const notify = vi.mocked(notifications.notify)

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(done => {
    resolve = done
  })

  return { promise, resolve }
}

describe('revealProject', () => {
  // There is no project SCOPE any more. Revealing a project opens its folder in the one
  // list; it must never narrow the sidebar to that project the way entering used to.
  beforeEach(() => {
    window.localStorage.clear()
    $sidebarProjectsOpen.set(false)
  })

  it('opens the folder and un-folds the Projects section that holds it', () => {
    // setActiveProject fires best-effort (no gateway in test → it rejects and is
    // swallowed); the synchronous view change is what matters here.
    revealProject('p_123')

    expect($sidebarProjectsOpen.get()).toBe(true)
    expect(workspaceNodeOpen('p_123')).toBe(true)
  })

  it('reveals the synthetic Home bucket the same way', () => {
    revealProject(NO_PROJECT_ID)

    expect(workspaceNodeOpen(NO_PROJECT_ID)).toBe(true)
  })

  it('leaves no persisted scope behind for a new chat to inherit', () => {
    revealProject('p_abc')

    expect(window.localStorage.getItem('hermes.desktop.projectScope')).toBeNull()
  })
})

describe('projects RPC profile forwarding', () => {
  it('distinguishes a failed drill-in from an empty project', async () => {
    const failure = new Error('gateway read failed')
    const request = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({ project: null })
    activeGateway.mockReturnValue({ connectionState: 'open', request } as unknown as ReturnType<typeof activeGateway>)
    await expect(fetchProjectSessions('p_123')).rejects.toBe(failure)
    await expect(fetchProjectSessions('p_123')).resolves.toBeNull()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    $activeGatewayProfile.set('default')
    $activeProjectId.set(null)
    $projectTree.set([])
    setShowAllProfiles(false)
  })

  it('forwards the normalized active profile to project read RPCs', async () => {
    const request = vi.fn(async () => ({ active_id: null, projects: [], scoped_session_ids: [] }))
    const gateway = { connectionState: 'open', request }
    activeGateway.mockReturnValue(gateway as never)
    gatewayAtom.set(gateway as never)
    $activeGatewayProfile.set('  coder  ')

    await refreshProjects()
    await refreshProjectTree()
    await fetchProjectSessions('p_123')

    expect(request).toHaveBeenNthCalledWith(1, 'projects.list', { profile: 'coder' })
    expect(request).toHaveBeenNthCalledWith(2, 'projects.tree', { preview_limit: 12, profile: 'coder' })
    expect(request).toHaveBeenNthCalledWith(3, 'projects.project_sessions', {
      profile: 'coder',
      project_id: 'p_123'
    })
  })

  it('skips project reads in the all-profiles view rather than forwarding its sentinel', async () => {
    const request = vi.fn()
    const gateway = { connectionState: 'open', request }
    activeGateway.mockReturnValue(gateway as never)
    gatewayAtom.set(gateway as never)
    setShowAllProfiles(true)

    await refreshProjects()
    await refreshProjectTree()
    await fetchProjectSessions('p_123')

    expect(request).not.toHaveBeenCalled()
    setShowAllProfiles(false)
  })
})

describe('resolveNewSessionCwd', () => {
  beforeEach(() => {
    applyConfiguredDefaultProjectDir('/home/user/configured')
    $currentCwd.set('')
    $selectedStoredSessionId.set(null)
    $sessions.set([])
    // Reset focused-session projections by clearing the inputs they read.
    // $focusedStoredSessionId falls back to $selectedStoredSessionId.
    // $focusedSessionState needs a runtime — leave it empty via no session states.
  })

  afterEach(() => {
    applyConfiguredDefaultProjectDir(null)
    $currentCwd.set('')
    $selectedStoredSessionId.set(null)
    $sessions.set([])
  })

  it('never inherits the project the sidebar happens to be showing', () => {
    // The behaviour this replaces: opening a project's folder to look at it decided
    // where the NEXT conversation would run. Looking is not choosing — a chat's
    // workspace is picked in the composer's setup row and passed explicitly.
    $projectTree.set([
      { id: 'p_open', label: 'Open', path: '/www/open', repos: [], sessionCount: 0 } as SidebarProjectTree
    ])
    revealProject('p_open')

    expect(resolveNewSessionCwd()).toBe('/home/user/configured')
  })

  it('falls back to the configured default', () => {
    expect(resolveNewSessionCwd()).toBe('/home/user/configured')
  })

  it('does not inherit the focused session workspace — new chat uses the configured default', () => {
    // Regression for #71873 / #80213: after a restart the focused session is
    // usually the just-resumed one, whose stored cwd can be a stale fallback
    // (e.g. the user's home dir on Windows). A new chat must NOT land there —
    // it falls through to the configured default project dir.
    $selectedStoredSessionId.set('sess-a')
    $sessions.set([
      {
        archived: false,
        cwd: 'C:\\Users\\sonny',
        ended_at: null,
        id: 'sess-a',
        input_tokens: 0,
        is_active: true,
        last_active: 0,
        message_count: 1,
        model: null,
        output_tokens: 0,
        started_at: 0,
        title: 'work'
      } as never
    ])

    expect(resolveNewSessionCwd()).toBe('/home/user/configured')
  })

  it('does not re-attach a remembered cwd when the focused session is detached', () => {
    $currentCwd.set('/Users/me/stale-remembered')
    $selectedStoredSessionId.set('sess-detached')
    $sessions.set([
      {
        archived: false,
        cwd: null,
        ended_at: null,
        id: 'sess-detached',
        input_tokens: 0,
        is_active: true,
        last_active: 0,
        message_count: 1,
        model: null,
        output_tokens: 0,
        started_at: 0,
        title: 'loose'
      } as never
    ])

    // Focused session has no workspace → fall through to configured default,
    // not the stale $currentCwd from an earlier chat.
    expect(resolveNewSessionCwd()).toBe('/home/user/configured')
  })
})

describe('projectNameForCwd', () => {
  const treeNode = (
    over: Partial<SidebarProjectTree> & Pick<SidebarProjectTree, 'id' | 'label'>
  ): SidebarProjectTree => ({
    path: null,
    repos: [],
    sessionCount: 0,
    ...over
  })

  beforeEach(() => {
    $projectTree.set([])
  })

  it('names the explicit project owning the cwd (longest path match)', () => {
    $projectTree.set([
      treeNode({ id: 'p_web', label: 'Website', path: '/repos/website' }),
      treeNode({ id: 'p_api', label: 'API', path: '/repos/api' })
    ])

    expect(projectNameForCwd('/repos/website/src/app')).toBe('Website')
  })

  it('matches nested repo and worktree paths, not just the project root', () => {
    $projectTree.set([
      treeNode({
        id: 'p_mono',
        label: 'Monorepo',
        path: '/repos/mono',
        repos: [
          {
            id: 'r1',
            label: 'mono',
            path: '/repos/mono',
            sessionCount: 0,
            groups: [{ id: 'g1', label: 'feature', path: '/elsewhere/mono-feature', sessions: [] }]
          }
        ]
      })
    ])

    // A linked worktree lives OUTSIDE the project root but still belongs to it.
    expect(projectNameForCwd('/elsewhere/mono-feature/src')).toBe('Monorepo')
  })

  it('matches nested Windows paths across separator and case differences', () => {
    $projectTree.set([treeNode({ id: 'p_win', label: 'Windows app', path: 'C:\\Repos\\App' })])

    expect(projectIdForCwd('c:/repos/app/src')).toBe('p_win')
    expect(projectNameForCwd('c:/repos/app/src')).toBe('Windows app')
  })

  it('ignores auto-projects and the No-project bucket (no named identity)', () => {
    $projectTree.set([
      treeNode({ id: '/repos/loose', label: 'loose', path: '/repos/loose', isAuto: true }),
      treeNode({ id: '__no_project__', label: 'No project', path: null, isNoProject: true })
    ])

    expect(projectNameForCwd('/repos/loose/src')).toBeNull()
  })

  it('returns null for a cwd in no project and for a blank cwd', () => {
    $projectTree.set([treeNode({ id: 'p_web', label: 'Website', path: '/repos/website' })])

    expect(projectNameForCwd('/somewhere/else')).toBeNull()
    expect(projectNameForCwd('')).toBeNull()
  })
})

describe('worktree refresh', () => {
  it('refreshWorktrees bumps the probe token so useRepoWorktreeMap refetches', () => {
    const before = $worktreeRefreshToken.get()
    refreshWorktrees()
    expect($worktreeRefreshToken.get()).toBe(before + 1)
  })
})

describe('startWorkInRepo remote capability gate (#81724)', () => {
  it('names the stale-backend remedy when a remote gateway lacks the worktree route', async () => {
    isDesktopFsRemoteMode.mockReturnValue(true)
    desktopGit.mockReturnValue({
      worktreeAdd: vi.fn(async () => {
        throw new Error(
          'Expected JSON from https://vps/api/git/worktree/add but got HTML (status 404). The endpoint is likely missing on the Hermes backend.'
        )
      })
    } as never)

    // The i18n mock echoes keys, so the surfaced error is the catalog key.
    await expect(startWorkInRepo('/srv/repo', { branch: 'x' })).rejects.toThrow('sidebar.projects.worktreeStaleBackend')
  })

  it('re-throws real git failures untouched (a remote 400 is not a capability verdict)', async () => {
    isDesktopFsRemoteMode.mockReturnValue(true)
    desktopGit.mockReturnValue({
      worktreeAdd: vi.fn(async () => {
        throw new Error("400: fatal: 'stale' is not a commit")
      })
    } as never)

    await expect(startWorkInRepo('/srv/repo', { branch: 'x' })).rejects.toThrow('not a commit')
  })
})

describe('pickProjectFolder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses the remote-aware directory picker locally', async () => {
    isDesktopFsRemoteMode.mockReturnValue(false)
    selectDesktopPaths.mockResolvedValue(['/local/repo'])

    await expect(pickProjectFolder()).resolves.toBe('/local/repo')
    expect(selectDesktopPaths).toHaveBeenCalledWith({ defaultPath: undefined, directories: true, multiple: false })
  })

  it('seeds the picker with the backend cwd on a remote gateway', async () => {
    isDesktopFsRemoteMode.mockReturnValue(true)
    desktopDefaultCwd.mockResolvedValue({ branch: 'main', cwd: '/backend/work' })
    selectDesktopPaths.mockResolvedValue(['/backend/work/repo'])

    await expect(pickProjectFolder()).resolves.toBe('/backend/work/repo')
    expect(selectDesktopPaths).toHaveBeenCalledWith({
      defaultPath: '/backend/work',
      directories: true,
      multiple: false
    })
  })

  it('returns null when the picker is cancelled (empty selection)', async () => {
    isDesktopFsRemoteMode.mockReturnValue(false)
    selectDesktopPaths.mockResolvedValue([])

    await expect(pickProjectFolder()).resolves.toBeNull()
  })
})

describe('createProject', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    $sidebarProjectsOpen.set(false)
    $activeProjectId.set(null)
    $projectsRpcAvailable.set(null)
    $projects.set([])
    $projectTree.set([])
    $activeGatewayProfile.set('default')
    setShowAllProfiles(false)
  })

  afterEach(() => {
    setShowAllProfiles(false)
    $activeGatewayProfile.set('default')
  })

  it.each(['default', 'coder'])('creates in the active %s profile without leaving All profiles', async profile => {
    const created = { folders: [], id: 'p_new', name: 'Hermes Agent', primary_path: '/srv/hermes' }
    const tree = { id: created.id, label: created.name, path: created.primary_path, repos: [], sessionCount: 0 }
    const request = vi.fn().mockResolvedValue({ project: created })
    activeGateway.mockReturnValue({ connectionState: 'open', request } as never)
    vi.mocked(hermes.hermesApi).mockResolvedValue({ projects: [tree], active_id: created.id })
    $activeGatewayProfile.set(profile)
    setShowAllProfiles(true)

    await expect(createProject({ folders: ['/srv/hermes'], name: created.name, use: true })).resolves.toEqual(created)

    expect(request).toHaveBeenCalledWith('projects.create', expect.objectContaining({ profile, name: created.name }))
    expect($profileScope.get()).toBe(ALL_PROFILES)
    expect($projects.get()).toContainEqual(created)
    expect($projectTree.get()).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id })]))
    expect($activeProjectId.get()).toBe(created.id)
    expect(hermes.hermesApi).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/profiles/projects/tree?preview_limit=12' })
    )
  })

  it('does not retarget a project create when the profile changes during reconnect', async () => {
    const reconnect = deferred<never>()
    const request = vi.fn()
    activeGateway.mockReturnValue({ connectionState: 'closed', request } as never)
    vi.mocked(gw.ensureActiveGatewayOpen).mockReturnValue(reconnect.promise)
    $activeGatewayProfile.set('coder')
    setShowAllProfiles(true)

    const pending = createProject({ folders: ['/srv/hermes'], name: 'Hermes Agent' })
    const rejection = expect(pending).rejects.toThrow('Active Hermes profile changed while connecting')
    const otherGateway = { connectionState: 'open', request }
    $activeGatewayProfile.set('other')
    activeGateway.mockReturnValue(otherGateway as never)
    reconnect.resolve(otherGateway as never)

    await rejection
    expect(request).not.toHaveBeenCalled()
  })

  it('creates the project and flips into the grouped view so a blank slate shows it', async () => {
    const created = { folders: [], id: 'p_new', name: 'Demo', primary_path: '/srv/demo' }

    const request = vi.fn(async (method: string) => {
      if (method === 'projects.create') {
        return { project: created }
      }

      // Reconcile (fire-and-forget) re-reads list + tree; echo the project back
      // so the optimistic state survives instead of being wiped to empty.
      return { active_id: 'p_new', projects: [created], scoped_session_ids: [] }
    })

    activeGateway.mockReturnValue({ connectionState: 'open', request } as never)

    const result = await createProject({ folders: ['/srv/demo'], name: 'Demo', use: true })

    expect(result).toEqual(created)
    expect(request).toHaveBeenCalledWith('projects.create', expect.objectContaining({ name: 'Demo' }))
    // Creating a project reveals it rather than switching the sidebar into a mode.
    expect($sidebarProjectsOpen.get()).toBe(true)
    expect(workspaceNodeOpen('p_new')).toBe(true)
    expect($activeProjectId.get()).toBe('p_new')
  })

  it('marks the backend stale and surfaces a friendly error when projects.create is missing', async () => {
    activeGateway.mockReturnValue({
      connectionState: 'open',
      request: vi.fn().mockRejectedValue(new Error('unknown method: projects.create'))
    } as never)

    await expect(createProject({ folders: ['/srv/demo'], name: 'Demo' })).rejects.toThrow(
      'sidebar.projects.staleBackend'
    )
    expect($projectsRpcAvailable.get()).toBe(false)
  })
})

describe('projects RPC capability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    $projectsRpcAvailable.set(null)
  })

  it('marks the backend stale when projects.list is missing', async () => {
    activeGateway.mockReturnValue({
      connectionState: 'open',
      request: vi.fn().mockRejectedValue(new Error('unknown method: projects.list'))
    } as never)

    await refreshProjects()

    expect($projectsRpcAvailable.get()).toBe(false)
  })

  it('does not publish a late project list from the previous source', async () => {
    let resolveA: ((value: unknown) => void) | undefined

    const responseA = new Promise(resolve => {
      resolveA = resolve
    })

    const gatewayA = { connectionState: 'open', request: vi.fn(() => responseA) }

    const gatewayB = {
      connectionState: 'open',
      request: vi.fn().mockResolvedValue({ active_id: null, projects: [{ id: 'source-b', name: 'Source B' }] })
    }

    let current = gatewayA

    activeGateway.mockImplementation(() => current as never)
    const pendingA = refreshProjects()

    current = gatewayB
    await refreshProjects()

    resolveA?.({ active_id: null, projects: [{ id: 'source-a', name: 'Source A' }] })
    await pendingA

    expect($projects.get().map(project => project.id)).toEqual(['source-b'])
  })

  it('blocks opening the create dialog once the backend is known stale', () => {
    $projectsRpcAvailable.set(false)

    openProjectCreate()

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'warning', message: 'sidebar.projects.staleBackend' })
    )
  })
})

describe('repository discovery policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    $activeGatewayProfile.set('default')
    isDesktopFsRemoteMode.mockReturnValue(false)
  })

  function gatewayWith(request: ReturnType<typeof vi.fn>) {
    const gateway = { connectionState: 'open', request }
    activeGateway.mockReturnValue(gateway as never)
    gatewayAtom.set(gateway as never)

    return gateway
  }

  it('records disabled policy without invoking the filesystem scanner', async () => {
    const request = vi.fn(async (method: string) =>
      method === 'projects.tree'
        ? { active_id: null, projects: [], scoped_session_ids: [] }
        : { accepted: false, repos: [] }
    )

    gatewayWith(request)
    const scanRepos = vi.fn()
    desktopGit.mockReturnValue({ scanRepos } as never)
    getHermesConfig.mockResolvedValue({
      desktop: {
        repo_scan_enabled: false,
        repo_scan_exclude_paths: [],
        repo_scan_roots: []
      }
    })

    await scanAndRecordRepos()

    expect(scanRepos).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledWith('projects.record_repos', {
      discovery_policy: { enabled: false, exclude_paths: [], roots: [] },
      profile: 'default',
      repos: []
    })
  })

  it('passes custom roots and exclusions to Electron and records on the origin gateway', async () => {
    const request = vi.fn(async (method: string) =>
      method === 'projects.tree'
        ? { active_id: null, projects: [], scoped_session_ids: [] }
        : { accepted: true, repos: [] }
    )

    gatewayWith(request)
    const scanRepos = vi.fn().mockResolvedValue([{ label: 'repo', root: '/work/repo' }])
    desktopGit.mockReturnValue({ scanRepos } as never)
    getHermesConfig.mockResolvedValue({
      desktop: {
        repo_scan_enabled: true,
        repo_scan_exclude_paths: ['/work/vendor'],
        repo_scan_roots: ['/work']
      }
    })

    await scanAndRecordRepos()

    expect(getHermesConfig).toHaveBeenCalledWith('default')
    expect(scanRepos).toHaveBeenCalledWith(['/work'], {
      enabled: true,
      excludePaths: ['/work/vendor']
    })
    expect(request).toHaveBeenCalledWith('projects.record_repos', {
      discovery_policy: {
        enabled: true,
        exclude_paths: ['/work/vendor'],
        roots: ['/work']
      },
      profile: 'default',
      repos: [{ label: 'repo', root: '/work/repo' }]
    })
  })

  it('does not scan the local filesystem for remote connections but still refreshes the project tree', async () => {
    isDesktopFsRemoteMode.mockReturnValue(true)
    const scanRepos = vi.fn()
    desktopGit.mockReturnValue({ scanRepos } as never)

    const request = vi.fn(async (method: string) =>
      method === 'projects.tree'
        ? { active_id: null, projects: [], scoped_session_ids: [] }
        : { accepted: false, repos: [] }
    )

    gatewayWith(request)
    $projectTree.set([
      { id: 'seed', label: 'seed', path: null, repos: [], sessionCount: 0 } satisfies SidebarProjectTree
    ])

    await scanAndRecordRepos(true)

    expect(scanRepos).not.toHaveBeenCalled()
    expect(getHermesConfig).not.toHaveBeenCalled()
    // The desktop can't crawl the remote host's filesystem, so it asks the
    // host to scan its own discovery roots (`projects.discover_repos` with
    // `scan: true`) — repos with zero Hermes sessions must still surface —
    // then refreshes the tree to pick up the merged list. Regression for
    // #81723: the sidebar used to go silent in remote mode and never
    // refresh again.
    expect(request).toHaveBeenCalledWith('projects.discover_repos', { profile: 'default', scan: true })
    expect(request).toHaveBeenCalledWith(
      'projects.tree',
      expect.objectContaining({ preview_limit: expect.any(Number), profile: 'default' })
    )
    // A successful scan refreshes the tree (here to the empty list the mock
    // tree returns), so a later discover-repos call replaces it instead of
    // keeping the stale seed.
    expect($projectTree.get()).toEqual([])
  })

  it('surfaces a reject from remote discover_repos without clearing the sidebar', async () => {
    // Backend error (RPC `error` frame) rejects the request — the sidebar must
    // keep its last known list and flag the failure, not go silently blank.
    isDesktopFsRemoteMode.mockReturnValue(true)
    desktopGit.mockReturnValue({ scanRepos: vi.fn() } as never)

    const request = vi.fn(async (method: string) => {
      if (method === 'projects.discover_repos') {
        throw new Error('discover_repos failed')
      }

      if (method === 'projects.tree') {
        return { active_id: null, projects: [], scoped_session_ids: [] }
      }

      return { accepted: false, repos: [] }
    })

    gatewayWith(request)
    $projectTree.set([
      { id: 'seed', label: 'seed', path: null, repos: [], sessionCount: 0 } satisfies SidebarProjectTree
    ])

    await scanAndRecordRepos(true)

    // The tree refresh must NOT run against a failed remote scan ...
    expect(request).not.toHaveBeenCalledWith(
      'projects.tree',
      expect.objectContaining({ preview_limit: expect.any(Number) })
    )
    // ... the cached tree is preserved ...
    expect($projectTree.get()).toEqual([{ id: 'seed', label: 'seed', path: null, repos: [], sessionCount: 0 }])
  })

  it('does not treat an error-shaped discover_repos response as a successful refresh', async () => {
    // A resolved-but-error-shaped body (`{accepted:false}` / no `repos`) must
    // be treated as a failure: keep the old list rather than refreshing into
    // the silent, empty sidebar of #81723.
    isDesktopFsRemoteMode.mockReturnValue(true)
    desktopGit.mockReturnValue({ scanRepos: vi.fn() } as never)

    const request = vi.fn(async (method: string) =>
      method === 'projects.tree' ? { active_id: null, projects: [], scoped_session_ids: [] } : { accepted: false }
    )

    gatewayWith(request)
    $projectTree.set([
      { id: 'seed', label: 'seed', path: null, repos: [], sessionCount: 0 } satisfies SidebarProjectTree
    ])

    await scanAndRecordRepos(true)

    expect(request).not.toHaveBeenCalledWith(
      'projects.tree',
      expect.objectContaining({ preview_limit: expect.any(Number) })
    )
    expect($projectTree.get()).toEqual([{ id: 'seed', label: 'seed', path: null, repos: [], sessionCount: 0 }])
  })

  it('records repos under the profile the scan started with, not one focused mid-scan', async () => {
    const { promise: scanResult, resolve: resolveScan } = deferred<Array<{ label: string; root: string }>>()
    const { promise: scanStarted, resolve: markScanStarted } = deferred<void>()

    const request = vi.fn(async (method: string) =>
      method === 'projects.tree'
        ? {
            active_id: null,
            projects: [{ id: 'p_lured', label: 'Lured', path: null, repos: [], sessionCount: 0 }],
            scoped_session_ids: []
          }
        : { accepted: true, repos: [] }
    )

    gatewayWith(request)

    const scanRepos = vi.fn(() => {
      markScanStarted()

      return scanResult
    })

    desktopGit.mockReturnValue({ scanRepos } as never)
    getHermesConfig.mockResolvedValue({
      desktop: {
        repo_scan_enabled: true,
        repo_scan_exclude_paths: [],
        repo_scan_roots: ['/work']
      }
    })
    $activeGatewayProfile.set('launch')
    $projectTree.set([])

    const pending = scanAndRecordRepos()
    await scanStarted
    $activeGatewayProfile.set('coder')
    resolveScan([{ label: 'repo', root: '/work/repo' }])
    await pending

    expect(request).toHaveBeenCalledWith('projects.record_repos', {
      discovery_policy: { enabled: true, exclude_paths: [], roots: ['/work'] },
      profile: 'launch',
      repos: [{ label: 'repo', root: '/work/repo' }]
    })
    expect(request).not.toHaveBeenCalledWith('projects.record_repos', expect.objectContaining({ profile: 'coder' }))
    expect($projectTree.get()).toEqual([])
  })
})

describe('project tree profile isolation', () => {
  beforeEach(() => {
    setShowAllProfiles(false)
    $activeGatewayProfile.set('default')
    $projects.set([])
    $projectTree.set([])
  })

  it('retries a dropped projects.tree request once on the active gateway', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('request timed out after 30s: projects.tree'))
      .mockResolvedValueOnce({
        active_id: null,
        projects: [{ id: 'remote-tree', label: 'Remote tree', path: null, repos: [], sessionCount: 0 }],
        scoped_session_ids: []
      })

    const gateway = { connectionState: 'open', request }
    activeGateway.mockReturnValue(gateway as never)
    gatewayAtom.set(gateway as never)

    await refreshProjectTree()

    expect(request).toHaveBeenCalledTimes(2)
    expect($projectTree.get().map(project => project.id)).toEqual(['remote-tree'])
  })

  it('does not publish a late response from the previous gateway', async () => {
    let resolveA: ((value: unknown) => void) | undefined

    const responseA = new Promise(resolve => {
      resolveA = resolve
    })

    const gatewayA = { connectionState: 'open', request: vi.fn(() => responseA) }

    const gatewayB = {
      connectionState: 'open',
      request: vi.fn().mockResolvedValue({
        active_id: null,
        projects: [{ id: 'profile-b', label: 'Profile B', path: null, repos: [], sessionCount: 0 }],
        scoped_session_ids: []
      })
    }

    let current = gatewayA
    activeGateway.mockImplementation(() => current as never)
    gatewayAtom.set(gatewayA as never)

    const pendingA = refreshProjectTree()
    current = gatewayB
    $activeGatewayProfile.set('profile-b')
    gatewayAtom.set(gatewayB as never)
    await refreshProjectTree()
    resolveA?.({
      active_id: null,
      projects: [{ id: 'profile-a', label: 'Profile A', path: null, repos: [], sessionCount: 0 }],
      scoped_session_ids: []
    })
    await pendingA

    expect($projectTree.get().map(project => project.id)).toEqual(['profile-b'])
  })

  it('does not publish a late projects.list response from the previous profile', async () => {
    const { promise: defaultResponse, resolve: resolveDefault } = deferred<unknown>()

    const request = vi.fn((_method: string, params: Record<string, unknown>) =>
      params.profile === 'default'
        ? defaultResponse
        : Promise.resolve({
            active_id: null,
            projects: [{ id: 'profile-b', label: 'Profile B' }]
          })
    )

    const gateway = { connectionState: 'open', request }
    activeGateway.mockReturnValue(gateway as never)
    gatewayAtom.set(gateway as never)

    const pendingDefault = refreshProjects()
    $activeGatewayProfile.set('profile-b')
    await refreshProjects()
    resolveDefault({
      active_id: null,
      projects: [{ id: 'profile-a', label: 'Profile A' }]
    })
    await pendingDefault

    expect($projects.get().map(project => project.id)).toEqual(['profile-b'])
  })

  it('does not publish a late projects.tree response from the previous profile', async () => {
    const { promise: defaultResponse, resolve: resolveDefault } = deferred<unknown>()

    const request = vi.fn((_method: string, params: Record<string, unknown>) =>
      params.profile === 'default'
        ? defaultResponse
        : Promise.resolve({
            active_id: null,
            projects: [{ id: 'profile-b', label: 'Profile B', path: null, repos: [], sessionCount: 0 }],
            scoped_session_ids: []
          })
    )

    const gateway = { connectionState: 'open', request }
    activeGateway.mockReturnValue(gateway as never)
    gatewayAtom.set(gateway as never)

    const pendingDefault = refreshProjectTree()
    $activeGatewayProfile.set('profile-b')
    await refreshProjectTree()
    resolveDefault({
      active_id: null,
      projects: [{ id: 'profile-a', label: 'Profile A', path: null, repos: [], sessionCount: 0 }],
      scoped_session_ids: []
    })
    await pendingDefault

    expect($projectTree.get().map(project => project.id)).toEqual(['profile-b'])
  })

  it('drops a late hydrated-project response from the previous profile', async () => {
    const { promise: defaultResponse, resolve: resolveDefault } = deferred<unknown>()

    const request = vi.fn((_method: string, params: Record<string, unknown>) =>
      params.profile === 'default'
        ? defaultResponse
        : Promise.resolve({
            project: { id: 'profile-b', label: 'Profile B', path: null, repos: [], sessionCount: 0 }
          })
    )

    const gateway = { connectionState: 'open', request }
    activeGateway.mockReturnValue(gateway as never)
    gatewayAtom.set(gateway as never)

    const pendingDefault = fetchProjectSessions('p_123')
    $activeGatewayProfile.set('profile-b')
    const profileB = await fetchProjectSessions('p_123')
    resolveDefault({
      project: { id: 'profile-a', label: 'Profile A', path: null, repos: [], sessionCount: 0 }
    })

    expect(profileB?.id).toBe('profile-b')
    await expect(pendingDefault).resolves.toBeNull()
  })
})

describe('tombstone pruning', () => {
  const openGatewayReturning = (scopedIds: string[]) => {
    const gateway = {
      connectionState: 'open',
      request: vi.fn().mockResolvedValue({ active_id: null, projects: [], scoped_session_ids: scopedIds })
    }

    activeGateway.mockImplementation(() => gateway as never)
    gatewayAtom.set(gateway as never)

    return gateway
  }

  beforeEach(() => {
    $removedSessionIds.set(new Set())
    $sessionMutationsInFlight.set(new Set())
  })

  it('keeps an in-flight delete tombstone even when the backend snapshot omits it', async () => {
    // Optimistic delete: hide the row, mark the RPC as in flight.
    tombstoneSessions(['sess-1'])
    beginSessionMutation(['sess-1'])

    // A projects.tree refresh races the pending delete: the id is already gone
    // from scope, but the RPC hasn't landed — the tombstone must survive so the
    // row doesn't flash back.
    openGatewayReturning([])
    await refreshProjectTree()

    expect($removedSessionIds.get().has('sess-1')).toBe(true)
  })

  it('prunes the tombstone once the mutation settles and scope no longer lists it', async () => {
    tombstoneSessions(['sess-1'])
    beginSessionMutation(['sess-1'])
    openGatewayReturning([])
    await refreshProjectTree()

    // Delete RPC settled; the next refresh with the id absent from scope drops it.
    endSessionMutation(['sess-1'])
    await refreshProjectTree()

    expect($removedSessionIds.get().has('sess-1')).toBe(false)
  })
})


describe('filing a session (organization only)', () => {
  // The contract: filing NEVER moves a workspace. `session.workspace.move` still does
  // that, deliberately; these guard that the two stayed apart.
  beforeEach(() => {
    vi.clearAllMocks()
    $activeGatewayProfile.set('default')
    setShowAllProfiles(false)
    $projectTree.set([])
    $groupTree.set([])
    $sessions.set([])
  })

  const row = (over: Record<string, unknown> = {}) =>
    ({
      archived: false,
      cwd: '/www/app',
      ended_at: null,
      group_id: null,
      id: 's1',
      input_tokens: 0,
      is_active: false,
      last_active: 1,
      message_count: 1,
      model: null,
      output_tokens: 0,
      preview: null,
      project_id: null,
      source: 'desktop',
      started_at: 1,
      title: 'chat',
      tool_call_count: 0,
      ...over
    }) as never

  it('sends only the fields it was given, and never a cwd', async () => {
    const request = vi.fn(async () => ({}))
    const gateway = { connectionState: 'open', request }
    activeGateway.mockReturnValue(gateway as never)
    gatewayAtom.set(gateway as never)

    await fileSession('s1', { projectId: 'p_a' })

    expect(request).toHaveBeenCalledWith('session.filing.set', {
      project_id: 'p_a',
      session_key: 's1'
    })
    // The whole point: no workspace field can ride along.
    expect(JSON.stringify(request.mock.calls)).not.toContain('cwd')
  })

  it('maps null to the empty string the backend reads as "clear"', async () => {
    const request = vi.fn(async () => ({}))
    const gateway = { connectionState: 'open', request }
    activeGateway.mockReturnValue(gateway as never)
    gatewayAtom.set(gateway as never)

    await fileSession('s1', { groupId: null, projectId: null })

    expect(request).toHaveBeenCalledWith('session.filing.set', {
      group_id: '',
      project_id: '',
      session_key: 's1'
    })
  })

  it('paints the row immediately and leaves the cwd alone', async () => {
    const request = vi.fn(async () => ({}))
    const gateway = { connectionState: 'open', request }
    activeGateway.mockReturnValue(gateway as never)
    gatewayAtom.set(gateway as never)
    $sessions.set([row()])

    await fileSession('s1', { projectId: 'p_a' })

    const [updated] = $sessions.get()
    expect(updated.project_id).toBe('p_a')
    expect(updated.cwd).toBe('/www/app')
  })

  it('rolls the row back when the write fails', async () => {
    const request = vi.fn().mockRejectedValue(new Error('nope'))
    const gateway = { connectionState: 'open', request }
    activeGateway.mockReturnValue(gateway as never)
    gatewayAtom.set(gateway as never)
    $sessions.set([row({ project_id: 'p_before' })])

    await expect(fileSession('s1', { projectId: 'p_after' })).rejects.toThrow('nope')

    expect($sessions.get()[0].project_id).toBe('p_before')
  })

  it('files into a group and clears any project, so a row never lands in two places', async () => {
    const request = vi.fn(async () => ({}))
    const gateway = { connectionState: 'open', request }
    activeGateway.mockReturnValue(gateway as never)
    gatewayAtom.set(gateway as never)

    const group = { id: 'g_1', isGroup: true, label: 'Shipping', path: null, repos: [], sessionCount: 0 }

    await fileSessionUnderNode('s1', group as unknown as SidebarProjectTree)

    expect(request).toHaveBeenCalledWith('session.filing.set', { group_id: 'g_1', session_key: 's1' })
  })

  it('treats Home as "unfile", clearing both fields', async () => {
    const request = vi.fn(async () => ({}))
    const gateway = { connectionState: 'open', request }
    activeGateway.mockReturnValue(gateway as never)
    gatewayAtom.set(gateway as never)

    const home = { id: NO_PROJECT_ID, isNoProject: true, label: 'Home', path: null, repos: [], sessionCount: 0 }

    await fileSessionUnderNode('s1', home as unknown as SidebarProjectTree)

    expect(request).toHaveBeenCalledWith('session.filing.set', {
      group_id: '',
      project_id: '',
      session_key: 's1'
    })
  })

  it('filing into a project also leaves any group, for the same reason', async () => {
    const request = vi.fn(async () => ({}))
    const gateway = { connectionState: 'open', request }
    activeGateway.mockReturnValue(gateway as never)
    gatewayAtom.set(gateway as never)

    const project = { id: 'p_a', label: 'Alpha', path: '/www/app', repos: [], sessionCount: 0 }

    await fileSessionUnderNode('s1', project as unknown as SidebarProjectTree)

    expect(request).toHaveBeenCalledWith('session.filing.set', {
      group_id: '',
      project_id: 'p_a',
      session_key: 's1'
    })
  })
})
