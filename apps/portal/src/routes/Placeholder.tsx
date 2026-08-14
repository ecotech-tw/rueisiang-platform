interface PlaceholderProps {
  title: string;
  /** 這個畫面預計在哪個 Phase 從舊系統搬進來。 */
  phase: string;
  from: string;
}

/** Phase 0 的佔位畫面：先讓 sidebar 與路由成形，功能之後逐一搬入。 */
export function Placeholder({ title, phase, from }: PlaceholderProps) {
  return (
    <div className="page">
      <header className="page-head">
        <h1>{title}</h1>
        <p className="muted">尚未搬入，預計於 {phase} 完成。</p>
      </header>
      <section className="panel">
        <p className="muted">來源：<code>{from}</code></p>
      </section>
    </div>
  );
}
