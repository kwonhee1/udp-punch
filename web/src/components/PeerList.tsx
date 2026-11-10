import { formatBytes } from "../lib/format";
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
              onSendFile={(file) => manager.sendFile(p.id, file)}
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
  onSendFile: (file: File) => void;
}

function PeerItem({ peer, session, sameNetwork, onConnect, onPing, onSendFile }: PeerItemProps) {
  return (
    <li className="peer">
      <div className="info">
        <div className="name">
          {peer.name}
          {sameNetwork && <span className="badge">같은 네트워크</span>}
        </div>
        <div className="label">{[peer.device, peer.ip].filter(Boolean).join(" · ")}</div>
        {session && <StatusLine session={session} sameNetwork={sameNetwork} />}
        {session?.state === "connected" && <FileLine session={session} />}
      </div>
      <PeerButton session={session} onConnect={onConnect} onPing={onPing} onSendFile={onSendFile} />
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

function FileLine({ session }: { session: SessionView }) {
  const max = session.maxFileSize != null ? `파일 최대 ${formatBytes(session.maxFileSize)}` : "파일 최대 크기 알 수 없음";
  const note = session.fileNote;
  return (
    <div className="status muted">
      {max}
      {note && <span className={note.ok ? "ok" : "err"}> · {note.text}</span>}
    </div>
  );
}

function PeerButton({ session, onConnect, onPing, onSendFile }: Omit<PeerItemProps, "peer" | "sameNetwork">) {
  if (session?.state === "connected") {
    return (
      <div className="actions">
        <button className="ghost" onClick={onPing}>
          핑
        </button>
        <label className="button">
          파일 보내기
          <input
            type="file"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = ""; // 같은 파일을 다시 골라도 onChange가 오게
              if (file) onSendFile(file);
            }}
          />
        </label>
      </div>
    );
  }
  if (session && !RETRYABLE.includes(session.state)) {
    return <button disabled>시도 중</button>;
  }
  return <button onClick={onConnect}>{session ? "다시 시도" : "연결"}</button>;
}
