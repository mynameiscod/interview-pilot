import type { ReactNode } from 'react';
import { SocketFactoryContext, type SocketFactory } from './realtime';

/** Swaps the realtime connection (tests pass a fake socket factory). */
export function RealtimeProvider({
  factory,
  children,
}: {
  factory: SocketFactory;
  children: ReactNode;
}) {
  return <SocketFactoryContext.Provider value={factory}>{children}</SocketFactoryContext.Provider>;
}
