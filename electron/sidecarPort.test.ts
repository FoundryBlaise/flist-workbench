// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:net'
import {
  DEV_PORT,
  PACKAGED_PORT,
  SidecarPortTaken,
  assertPortFree,
  chooseSidecarPort,
  waitForPortFree
} from './sidecarPort'

describe('chooseSidecarPort', () => {
  it('gives a dev build a port other than the installed app', () => {
    expect(chooseSidecarPort({}, true)).toBe(PACKAGED_PORT)
    expect(chooseSidecarPort({}, false)).toBe(DEV_PORT)
    expect(DEV_PORT).not.toBe(PACKAGED_PORT)
  })

  it('takes SIDECAR_PORT over either default', () => {
    expect(chooseSidecarPort({ SIDECAR_PORT: '41000' }, false)).toBe(41000)
    expect(chooseSidecarPort({ SIDECAR_PORT: '41000' }, true)).toBe(41000)
    expect(chooseSidecarPort({ SIDECAR_PORT: '' }, false)).toBe(DEV_PORT)
  })

  it.each(['abc', '0', '70000', '27384.5', '-1'])('refuses SIDECAR_PORT=%s', (raw) => {
    expect(() => chooseSidecarPort({ SIDECAR_PORT: raw }, false)).toThrow(/SIDECAR_PORT/)
  })
})

describe('assertPortFree', () => {
  let holder: Server | null = null
  afterEach(async () => {
    await new Promise<void>((r) => (holder ? holder.close(() => r()) : r()))
    holder = null
  })

  function listen(): Promise<number> {
    return new Promise((resolve) => {
      holder = createServer()
      holder.listen(0, '127.0.0.1', () => {
        const address = holder?.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
  }

  it('refuses a port something already listens on, naming it', async () => {
    const port = await listen()
    const err = await assertPortFree(port).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SidecarPortTaken)
    expect(String(err)).toContain(`port ${port}`)
  })

  it('says in plain words what holds the port, naming it', () => {
    expect(new SidecarPortTaken(27384).message).toBe(
      'Another program is using port 27384 on this computer, so F-list Workbench cannot start ' +
        'its sidecar there. Close that program, or start F-list Workbench with SIDECAR_PORT set to a free port.'
    )
    expect(new SidecarPortTaken(27384, '0.3.0').message).toBe(
      'Another F-list Workbench (version 0.3.0) is running and uses port 27384. ' +
        'Close it, then start this one again.'
    )
  })

  it('waits for a port to come free, and gives up naming it', async () => {
    const port = await listen()
    const err = await waitForPortFree(port, 300).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SidecarPortTaken)
    setTimeout(() => holder?.close(), 300)
    await expect(waitForPortFree(port, 5000)).resolves.toBeUndefined()
    holder = null
  })

  it('accepts a free port and leaves it free', async () => {
    const port = await listen()
    await new Promise<void>((r) => holder?.close(() => r()))
    holder = null
    await expect(assertPortFree(port)).resolves.toBeUndefined()
    await expect(assertPortFree(port)).resolves.toBeUndefined()
  })
})
