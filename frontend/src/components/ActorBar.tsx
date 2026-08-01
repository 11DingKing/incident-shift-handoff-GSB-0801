import { useEffect, useRef } from "react";

interface Props {
  actor: string;
  setActor: (v: string) => void;
}

export function ActorBar({ actor, setActor }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ref.current?.focus();
        ref.current?.select();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="actor-bar">
      <label htmlFor="actor-input" className="muted">
        当前值班人
      </label>
      <input
        id="actor-input"
        ref={ref}
        value={actor}
        onChange={(e) => setActor(e.target.value)}
        placeholder="输入姓名后开始操作"
        aria-label="当前值班人"
      />
      <span className="muted">
        <span className="kbd">⌘K</span> 聚焦
      </span>
    </div>
  );
}
