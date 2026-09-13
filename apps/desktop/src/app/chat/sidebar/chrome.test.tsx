import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SidebarDateDivider, SidebarGroupRow } from './chrome'

afterEach(cleanup)

describe('SidebarGroupRow', () => {
  const actionsOf = () => screen.getByRole('button', { name: 'New session' }).closest('[data-row-actions]')

  it('keeps no room for buttons that only show on hover, so a long name runs to the edge', () => {
    render(
      <SidebarGroupRow
        actions={<button type="button">New session</button>}
        actionsOnHover
        label="Troubleshooting and Diagnostics"
        lead={null}
      />
    )

    expect(actionsOf()?.className).toContain('w-0')
  })

  it('leaves the buttons of other group rows where they are', () => {
    render(<SidebarGroupRow actions={<button type="button">New session</button>} label="Default" lead={null} />)

    expect(actionsOf()?.className).not.toContain('w-0')
  })
})

describe('SidebarDateDivider', () => {
  it('collapses the group when the caption is clicked', () => {
    const onToggle = vi.fn()

    render(
      <SidebarDateDivider label="Yesterday" toggle={{ ariaLabel: 'Hide Yesterday sessions', onToggle, open: true }} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Hide Yesterday sessions' }))
    expect(onToggle).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Hide Yesterday sessions' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('stays a static caption when it is not collapsible', () => {
    render(<SidebarDateDivider label="Yesterday" />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('Yesterday')).toBeTruthy()
  })
})
