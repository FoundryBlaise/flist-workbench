// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { FileGrants } from './fileGrants'

const picked = process.platform === 'win32' ? 'C:\\Users\\me\\set.zip' : '/home/me/set.zip'
const other = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd'

describe('FileGrants', () => {
  it('refuses a path nobody picked', () => {
    const grants = new FileGrants()
    expect(grants.takeRead(other)).toBe(false)
    expect(grants.takeWrite(other)).toBe(false)
  })

  it('allows one read of a path picked in an open dialog', () => {
    const grants = new FileGrants()
    grants.grantRead(picked)
    expect(grants.takeRead(picked)).toBe(true)
    expect(grants.takeRead(picked)).toBe(false)
  })

  it('allows one write of a path picked in a save dialog', () => {
    const grants = new FileGrants()
    grants.grantWrite(picked)
    expect(grants.takeWrite(picked)).toBe(true)
    expect(grants.takeWrite(picked)).toBe(false)
  })

  it('keeps reads and writes apart', () => {
    const grants = new FileGrants()
    grants.grantRead(picked)
    expect(grants.takeWrite(picked)).toBe(false)
    grants.grantWrite(other)
    expect(grants.takeRead(other)).toBe(false)
  })

  it('does not let a spelling of the path walk elsewhere', () => {
    const grants = new FileGrants()
    grants.grantRead(picked)
    const sep = process.platform === 'win32' ? '\\' : '/'
    expect(grants.takeRead(`${picked}${sep}..${sep}..${sep}secret`)).toBe(false)
    expect(grants.takeRead('set.zip')).toBe(false)
  })

  it.runIf(process.platform === 'win32')('matches case-insensitively on Windows', () => {
    const grants = new FileGrants()
    grants.grantRead(picked)
    expect(grants.takeRead(picked.toUpperCase())).toBe(true)
  })
})
