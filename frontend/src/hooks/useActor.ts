import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "incident-handoff-actor";

export function useActor(): [string, (v: string) => void] {
  const [actor, setActor] = useState<string>(() => {
    if (typeof localStorage === "undefined") return "";
    return localStorage.getItem(STORAGE_KEY) ?? "";
  });

  useEffect(() => {
    if (actor) localStorage.setItem(STORAGE_KEY, actor);
  }, [actor]);

  const update = useCallback((v: string) => setActor(v), []);
  return [actor, update];
}
