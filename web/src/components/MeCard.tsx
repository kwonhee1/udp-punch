import type { Snapshot } from "../lib/peer-manager";

export function MeCard({ snapshot }: { snapshot: Snapshot }) {
  const { me, lobby, ipProbed } = snapshot;
  return (
    <section className="card me">
      <div>
        <div className="label">내 기기</div>
        <div className="name">{me.name}</div>
        <div className="label">{me.device}</div>
      </div>
      <div className="right">
        <div className="label">내 공인 주소</div>
        <div className="mono">{ipProbed ? (me.ip ?? "확인 실패") : "확인 중…"}</div>
        <div className="label">{lobby}</div>
      </div>
    </section>
  );
}
