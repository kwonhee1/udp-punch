import { useEffect, useState, useSyncExternalStore } from "react";
import { PeerManager, type PeerManagerConfig, type Snapshot } from "../lib/peer-manager";

/** PeerManager를 만들고 화면이 붙어 있는 동안 로비에 접속한다. */
export function usePeerManager(config: PeerManagerConfig): [PeerManager, Snapshot] {
  const [manager] = useState(() => new PeerManager(config));
  useEffect(() => {
    manager.start();
    return () => manager.stop();
  }, [manager]);
  const snapshot = useSyncExternalStore(manager.subscribe, manager.getSnapshot);
  return [manager, snapshot];
}
