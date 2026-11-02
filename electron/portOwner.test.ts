// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:net'
import { portOwnerChain } from './portOwner'

describe.skipIf(process.platform !== 'win32')('portOwnerChain', () => {
  let holder: Server | null = null
  afterEach(async () => {
    await new Promise<void>((r) => (holder ? holder.close(() => r()) : r()))
    holder = null
  })

  it('names the process listening on a port, then its parents', async () => {
    const port = await new Promise<number>((resolve) => {
      holder = createServer()
      holder.listen(0, '127.0.0.1', () => {
        const address = holder?.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
    const chain = await portOwnerChain(port)
    expect(chain).not.toBeNull()
    const [listener, parent] = chain ?? []
    expect(listener).toMatchObject({ pid: process.pid, parentPid: process.ppid })
    expect(listener.name.toLowerCase()).toBe('node.exe')
    expect(listener.path?.toLowerCase()).toBe(process.execPath.toLowerCase())
    expect(Date.parse(listener.created ?? '')).toBeLessThanOrEqual(Date.now())
    expect(parent?.pid).toBe(process.ppid)
  }, 30_000)

  it('says when nothing listens', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer()
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
      })
    })
    expect(await portOwnerChain(port)).toEqual([])
  }, 30_000)
})
