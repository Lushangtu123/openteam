import { describe, expect, it } from 'vitest'
import { createWorkspaceQueue, workspacesOverlap } from './workspaceQueue'

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('one local agent at a time in a folder', () => {
  it('treats a folder, the folders inside it and the ones around it as the same place', () => {
    expect(workspacesOverlap('/Users/me/app', '/Users/me/app/')).toBe(true)
    expect(workspacesOverlap('/Users/me/app', '/Users/me/app/src')).toBe(true)
    expect(workspacesOverlap('/Users/me/app/src', '/Users/me/app')).toBe(true)
    expect(workspacesOverlap('/Users/me/app', '/Users/me/app2')).toBe(false)
    expect(workspacesOverlap('/Users/me/app', '/Users/me/web')).toBe(false)
    expect(workspacesOverlap('/', '/Users/me/web')).toBe(true)
  })

  it('lets a run start once the runs before it in the same folder have finished, in order', async () => {
    const queue = createWorkspaceQueue()
    const first = queue.enter('/Users/me/app', '后端')
    const second = queue.enter('/Users/me/app/src', '前端')
    const third = queue.enter('/Users/me/app', '测试')
    const elsewhere = queue.enter('/Users/me/web', '设计')
    expect(first.waitingFor).toEqual([])
    expect(second.waitingFor).toEqual(['后端'])
    expect(third.waitingFor).toEqual(['后端', '前端'])
    expect(elsewhere.waitingFor).toEqual([])

    const started: string[] = []
    void second.ready().then(() => started.push('前端'))
    void third.ready().then(() => started.push('测试'))
    await elsewhere.ready()
    await flush()
    expect(started).toEqual([])

    first.release()
    await flush()
    expect(started).toEqual(['前端'])
    second.release()
    await flush()
    expect(started).toEqual(['前端', '测试'])
    // A second release does nothing.
    second.release()
    third.release()
    expect(queue.enter('/Users/me/app', '新的').waitingFor).toEqual([])
  })

  it('stops waiting when the run is stopped, and lets the ones behind it go on', async () => {
    const queue = createWorkspaceQueue()
    const first = queue.enter('/w', 'A')
    const second = queue.enter('/w', 'B')
    const third = queue.enter('/w', 'C')
    const controller = new AbortController()
    const waiting = second.ready(controller.signal)
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    second.release()

    let thirdStarted = false
    void third.ready().then(() => { thirdStarted = true })
    await flush()
    expect(thirdStarted).toBe(false)
    first.release()
    await flush()
    expect(thirdStarted).toBe(true)
    await expect(queue.enter('/x', 'D').ready(AbortSignal.abort())).resolves.toBeUndefined()
  })
})
