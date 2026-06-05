import { useEffect, useRef } from 'react'

export function useWebSocket(url: string | null, onMessage: (data: string) => void) {
  // Keep a stable ref so the WS handler always calls the latest version
  const onMessageRef = useRef(onMessage)
  useEffect(() => {
    onMessageRef.current = onMessage
  })

  useEffect(() => {
    if (!url) return

    let ws: WebSocket
    let retryDelay = 1_000
    let cancelled = false

    function connect() {
      ws = new WebSocket(url!)
      ws.onopen = () => {
        retryDelay = 1_000
      }
      ws.onmessage = (e) => onMessageRef.current(e.data as string)
      ws.onclose = () => {
        if (!cancelled) {
          setTimeout(connect, retryDelay)
          retryDelay = Math.min(retryDelay * 2, 30_000)
        }
      }
    }

    connect()
    return () => {
      cancelled = true
      ws?.close()
    }
  }, [url])
}
