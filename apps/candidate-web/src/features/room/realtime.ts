import { RT_NAMESPACE } from '@cbi/shared-types';
import { createContext, useContext } from 'react';
import { io } from 'socket.io-client';

/** Socket listeners take event-specific arguments. */
export type SocketListener = (...args: never[]) => void;
type Listener = SocketListener;

/**
 * The part of a Socket.IO client socket the interview room uses. Tests
 * provide a fake with the same shape, so no network is ever opened there.
 */
export interface RoomSocket {
  readonly connected: boolean;
  /** False after a handshake the server refused (Socket.IO then stops retrying on its own). */
  readonly active?: boolean;
  auth: Record<string, unknown>;
  on(event: string, listener: Listener): unknown;
  off(event: string, listener?: Listener): unknown;
  timeout(ms: number): { emitWithAck(event: string, payload: unknown): Promise<unknown> };
  connect(): unknown;
  disconnect(): unknown;
}

export interface SocketFactoryOptions {
  /** API base URL (the same value the REST client uses). */
  url: string;
  token: string | null;
}

export type SocketFactory = (opts: SocketFactoryOptions) => RoomSocket;

/** Opens the candidate's realtime connection to the `/rt` namespace. Not connected until `connect()`. */
export const createRoomSocket: SocketFactory = ({ url, token }) =>
  io(`${url}${RT_NAMESPACE}`, {
    path: '/socket.io',
    auth: { token },
    transports: ['websocket', 'polling'],
    autoConnect: false,
  }) as unknown as RoomSocket;

export const SocketFactoryContext = createContext<SocketFactory>(createRoomSocket);

export const useSocketFactory = () => useContext(SocketFactoryContext);
