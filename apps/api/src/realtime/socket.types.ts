import type { ClientToServerEvents, ServerToClientEvents } from '@chat/shared';
import type { Socket } from 'socket.io';

/** Set by the handshake middleware once the JWT is verified. */
export interface SocketData {
  userId: string;
  email: string;
}

export type ChatSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
