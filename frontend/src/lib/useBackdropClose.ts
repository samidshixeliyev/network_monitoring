import { useCallback, useRef, type MouseEvent } from 'react'

/**
 * Close a modal when its backdrop is clicked — but ONLY when the press both
 * started and ended on the backdrop itself.
 *
 * The naive `onClick={onClose}` on the backdrop has a nasty bug: if you select
 * text inside an input (e.g. to copy) and release the mouse outside the content
 * box, the browser fires a `click` whose target is the backdrop, so the modal
 * closes mid-copy/paste. Tracking mousedown fixes it: a press that began inside
 * the content never counts as a backdrop click.
 *
 * Spread the result on the backdrop element:
 *   const backdrop = useBackdropClose(onClose)
 *   <div {...backdrop}> … </div>
 */
export function useBackdropClose(onClose: () => void) {
  const downOnBackdrop = useRef(false)
  const onMouseDown = useCallback((e: MouseEvent) => {
    downOnBackdrop.current = e.target === e.currentTarget
  }, [])
  const onClick = useCallback(
    (e: MouseEvent) => {
      if (downOnBackdrop.current && e.target === e.currentTarget) onClose()
      downOnBackdrop.current = false
    },
    [onClose],
  )
  return { onMouseDown, onClick }
}
