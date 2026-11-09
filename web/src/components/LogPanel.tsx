export function LogPanel({ logs }: { logs: readonly string[] }) {
  return (
    <section className="card">
      <details>
        <summary>로그</summary>
        <pre className="log">{logs.join("\n")}</pre>
      </details>
    </section>
  );
}
