import { useEffect, useRef } from 'react';
import { isStaticHostMode, subscribeStaticQueueEvents } from '../services/staticFallbackEngine';

export interface QueueWsMessage {
  event: string;
  facilityId: string;
  payload?: unknown;
  timestamp: number;
}

export function useQueueSocket(
  facilityId: string,
  onEvent: (msg: QueueWsMessage) => void
): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const unsubscribeStatic = subscribeStaticQueueEvents(facilityId, (msg) => {
      onEventRef.current(msg);
    });

    if (isStaticHostMode()) {
      return () => {
        unsubscribeStatic();
      };
    }

    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let disposed = false;
    let failedAttempts = 0;

    const connect = () => {
      if (disposed || isStaticHostMode()) return;
      const apiBase = ((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL || '').trim();
      let wsOrigin = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
      if (apiBase) {
        try {
          const parsed = new URL(apiBase);
          wsOrigin = `${parsed.protocol === 'https:' ? 'wss:' : 'ws:'}//${parsed.host}`;
        } catch {
          // Fallback to window host
        }
      }
      const url = `${wsOrigin}/ws?facilityId=${encodeURIComponent(facilityId)}`;

      socket = new WebSocket(url);

      socket.onopen = () => {
        failedAttempts = 0;
        socket?.send(JSON.stringify({ type: 'subscribe', facilityId }));
      };

      socket.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data) as QueueWsMessage;
          onEventRef.current(parsed);
        } catch {
          // Ignore malformed server payload
        }
      };

      socket.onclose = () => {
        if (!disposed && !isStaticHostMode() && failedAttempts < 3) {
          failedAttempts += 1;
          reconnectTimer = window.setTimeout(connect, 2500);
        }
      };

      socket.onerror = () => {
        socket?.close();
      };
    };

    connect();

    return () => {
      disposed = true;
      unsubscribeStatic();
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
  }, [facilityId]);
}
