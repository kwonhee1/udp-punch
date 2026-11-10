import { formatBytes } from "../lib/format";
import type { ReceivedFile } from "../lib/peer-manager";

export function ReceivedFiles({ files }: { files: readonly ReceivedFile[] }) {
  return (
    <section className="card">
      <h2>받은 파일</h2>
      {files.length === 0 ? (
        <div className="empty">연결된 상대가 보낸 파일이 여기에 나타납니다.</div>
      ) : (
        <ul>
          {files.map((f) => (
            <li className="file" key={f.id}>
              <div className="info">
                <div className="name">{f.name}</div>
                <div className="label">
                  {formatBytes(f.size)} · {f.fromName}
                </div>
              </div>
              <a className="button ghost" href={f.url} download={f.name}>
                저장
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
