interface ScrollViewport {
  scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
}

interface ScrollScheduler {
  request: (callback: () => void) => number
  cancel: (id: number) => void
}

// One writer owns the viewport. Content/viewport resizes trigger a single frame,
// rather than a perpetual animation competing with native user scrolling.
export function createMessageListScroll(
  viewport: ScrollViewport,
  scheduler: ScrollScheduler,
  onBottomChange: (atBottom: boolean) => void,
) {
  let following = true
  let lastTop = viewport.scrollTop
  let frame: number | null = null
  let disposed = false
  const bottom = () => Math.max(0, viewport.scrollHeight - viewport.clientHeight)
  const atBottom = () => bottom() - viewport.scrollTop <= 2
  const notify = () => onBottomChange(atBottom())
  const cancel = () => {
    if (frame !== null) scheduler.cancel(frame)
    frame = null
  }
  const scrollToLatest = () => {
    if (disposed) return
    cancel()
    following = true
    // Native smooth scrolling can be interrupted by subsequent streamed updates.
    viewport.scrollTop = bottom()
    lastTop = viewport.scrollTop
    notify()
  }
  return {
    scrollToLatest,
    pause() {
      following = false
      cancel()
    },
    onScroll() {
      if (disposed) return
      if (atBottom()) following = true
      else if (viewport.scrollTop < lastTop - 1) {
        following = false
        cancel()
      }
      lastTop = viewport.scrollTop
      notify()
    },
    onResize() {
      if (disposed) return
      if (!following) {
        notify()
        return
      }
      if (frame !== null) return
      frame = scheduler.request(() => {
        frame = null
        if (following && !disposed) scrollToLatest()
      })
    },
    dispose() {
      disposed = true
      cancel()
    },
  }
}
