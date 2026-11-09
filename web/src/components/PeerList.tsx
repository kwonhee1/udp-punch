import type { PeerInfo, PeerManager, SessionState, SessionView, Snapshot } from "../lib/peer-manager";

const STATE_TEXT: Record<SessionState, [string, "ok" | "warn" | "err" | "muted"]> = {
  gathering: ["공인 주소 확인 중…", "warn"],
  waiting: ["상대 응답 기다리는 중…", "warn"],
  punching: ["홀 펀칭 시도 중…", "warn"],
  connected: ["연결됨", "ok"],
  disconnected: ["연결 끊김", "err"],
  failed: ["실패", "err"],
  closed: ["연결 종료", "muted"],
};

const RETRYABLE: SessionState[] = ["failed", "disconnected", "closed"];

export function PeerList({ manager, snapshot }: { manager: PeerManager; snapshot: Snapshot }) {
  return (
    <section className="card">
      <h2>접속 중인 기기</h2>
      {snapshot.peers.length === 0 ? (
        <div className="empty">다른 기기에서 이 페이지를 열면 여기에 나타납니다.</div>
      ) : (
        <ul>
          {snapshot.peers.map((p) => (
            <PeerItem
              key={p.id}
              peer={p}
              session={snapshot.sessions[p.id]}
              sameNetwork={manager.isSameNetwork(p)}
              onConnect={() => manager.connect(p.id)}
              onPing={() => manager.ping(p.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface PeerItemProps {
  peer: PeerInfo;
  session: SessionView | undefined;
  sameNetwork: boolean;
  onConnect: () => void;
  onPing: () => void;
}

function PeerItem({ peer, session, sameNetwork, onConnect, onPing }: PeerItemProps) {
  return (
    <li className="peer">
      <div className="info">
        <div className="name">
          {peer.name}
          {sameNetwork && <span className="badge">같은 네트워크</span>}
        </div>
        <div className="label">{[peer.device, peer.ip].filter(Boolean).join(" · ")}</div>
        {session && <StatusLine session={session} sameNetwork={sameNetwork} />}
      </div>
      <PeerButton session={session} onConnect={onConnect} onPing={onPing} />
    </li>
  );
}

function StatusLine({ session, sameNetwork }: { session: SessionView; sameNetwork: boolean }) {
  const [text, cls] = STATE_TEXT[session.state];
  let line = text;
  if (session.state === "connected") {
    if (session.pair) line += ` · ${session.pair}`;
    if (session.rtt != null) line += ` · 왕복 ${session.rtt.toFixed(1)}ms`;
  }
  if (session.state === "failed") {
    if (session.reason) line += ` (${session.reason})`;
    if (sameNetwork) line += " · 같은 네트워크: 공유기가 기기 사이 통신을 막고 있을 수 있습니다";
  }
  return <div className={`status ${cls}`}>{line}</div>;
}

function PeerButton({ session, onConnect, onPing }: Omit<PeerItemProps, "peer" | "sameNetwork">) {
  if (session?.state === "connected") {
    return (
      <button className="ghost" onClick={onPing}>
        핑
      </button>
    );
  }
  if (session && !RETRYABLE.includes(session.state)) {
    return <button disabled>시도 중</button>;
  }
  return <button onClick={onConnect}>{session ? "다시 시도" : "연결"}</button>;
}
