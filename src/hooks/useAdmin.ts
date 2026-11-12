import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import * as api from "../lib/admin/api.ts";
import type {
  EventOverride,
  ImageCrop,
  ScheduleOverride,
} from "../lib/admin/overrides.ts";
import type { PublicationStatus } from "../lib/admin/publication.ts";

export type LoginResult =
  | { ok: true }
  | { ok: false; reason: "invalid"; remaining: number }
  | { ok: false; reason: "locked"; retryAfter: number }
  | { ok: false; reason: "disabled" | "offline" };

export interface Admin {
  adminPage: boolean;
  status: "loading" | "ready" | "offline";
  admin: boolean;
  overrides: ReadonlyMap<string, EventOverride>;
  publication: PublicationStatus | null;
  publicationError: string;
  reload(): Promise<void>;
  login(password: string): Promise<LoginResult>;
  logout(): Promise<void>;
  publish(): Promise<void>;
  saveSchedule(id: string, schedule: ScheduleOverride): Promise<void>;
  restoreSchedule(id: string): Promise<void>;
  saveImage(id: string, crop: ImageCrop, file: Blob | null): Promise<void>;
  restoreImage(id: string): Promise<void>;
}

export const AdminContext = createContext<Admin | null>(null);
export const useAdminContext = () => useContext(AdminContext)!;

export function useAdmin(
  adminPage: boolean,
  publishedOverrides: readonly EventOverride[],
): Admin {
  const [status, setStatus] = useState<Admin["status"]>(
    adminPage ? "loading" : "ready",
  );
  const [admin, setAdmin] = useState(false);
  const [overrides, setOverrides] = useState<
    ReadonlyMap<string, EventOverride>
  >(
    () =>
      new Map(
        (adminPage ? [] : publishedOverrides).map((entry) => [
          entry.event_id,
          entry,
        ]),
      ),
  );
  const [publication, setPublication] = useState<PublicationStatus | null>(
    null,
  );
  const [publicationError, setPublicationError] = useState("");
  const queue = useRef<Promise<void>>(Promise.resolve());
  const lifecycle = useRef(0);

  // Serialize status reads, stage changes, and publication so stale responses
  // cannot undo an edit or a logout.
  const enqueue = useCallback(
    <T>(run: (current: () => boolean) => Promise<T>) => {
      const generation = lifecycle.current;
      const result = queue.current.then(() =>
        run(() => lifecycle.current === generation),
      );
      queue.current = result.then(
        () => {},
        () => {},
      );
      return result;
    },
    [],
  );

  const clearSession = useCallback(() => {
    setAdmin(false);
    setOverrides(new Map());
    setPublication(null);
    setPublicationError("");
  }, []);

  const refreshPublication = useCallback(
    async (current: () => boolean) => {
      try {
        const next = await api.getPublication();
        if (current()) {
          setPublication(next);
          setPublicationError("");
        }
      } catch (error) {
        if (!current()) return;
        if (error instanceof api.AdminError && error.status === 401)
          clearSession();
        setPublicationError(
          error instanceof Error
            ? error.message
            : "게시 상태를 불러오지 못했어요.",
        );
        // A status-read failure does not turn a successful stage write into a failure.
      }
    },
    [clearSession],
  );

  const loadStage = useCallback(
    async (current: () => boolean) => {
      try {
        const entries = await api.listOverrides();
        if (!current()) return;
        setOverrides(new Map(entries.map((entry) => [entry.event_id, entry])));
        setStatus("ready");
        await refreshPublication(current);
      } catch (error) {
        if (!current()) return;
        if (error instanceof api.AdminError && error.status === 401)
          clearSession();
        setStatus("offline");
      }
    },
    [clearSession, refreshPublication],
  );

  const reload = useCallback(() => {
    if (!adminPage) return Promise.resolve();
    return enqueue(async (current) => {
      if (!current()) return;
      setStatus("loading");
      try {
        const authenticated = await api.getSession();
        if (!current()) return;
        setAdmin(authenticated);
        if (authenticated) await loadStage(current);
        else {
          clearSession();
          setStatus("ready");
        }
      } catch {
        if (!current()) return;
        clearSession();
        setStatus("offline");
      }
    });
  }, [adminPage, enqueue, loadStage, clearSession]);

  useEffect(() => {
    if (adminPage) void reload();
    return () => {
      lifecycle.current += 1;
    };
  }, [adminPage, reload]);

  useEffect(() => {
    if (!adminPage || !admin) return;
    let stopped = false;
    let timer: number;
    const poll = async () => {
      await enqueue(async (current) => {
        if (!stopped && current())
          await refreshPublication(() => !stopped && current());
      });
      if (!stopped) timer = window.setTimeout(() => void poll(), 10_000);
    };
    timer = window.setTimeout(() => void poll(), 10_000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [adminPage, admin, enqueue, refreshPublication]);

  const login = useCallback(
    (password: string): Promise<LoginResult> => {
      if (!adminPage) return Promise.resolve({ ok: false, reason: "disabled" });
      return enqueue<LoginResult>(async (current) => {
        if (current()) setStatus("loading");
        try {
          await api.login(password);
          if (current()) {
            setAdmin(true);
            await loadStage(current);
          }
          return { ok: true };
        } catch (error) {
          if (current())
            setStatus(
              error instanceof api.AdminError && error.code === "offline"
                ? "offline"
                : "ready",
            );
          if (error instanceof api.AdminError) {
            if (error.status === 401 && current()) clearSession();
            if (error.code === "invalid-password")
              return {
                ok: false,
                reason: "invalid",
                remaining: error.remaining ?? 0,
              };
            if (error.code === "too-many-attempts")
              return {
                ok: false,
                reason: "locked",
                retryAfter: error.retryAfter ?? 1,
              };
            if (error.code === "admin-disabled")
              return { ok: false, reason: "disabled" };
          }
          return { ok: false, reason: "offline" };
        }
      });
    },
    [adminPage, enqueue, loadStage, clearSession],
  );

  const logout = useCallback(() => {
    if (!adminPage) return Promise.resolve();
    return enqueue(async (current) => {
      try {
        await api.logout();
        if (current()) {
          clearSession();
          setStatus("ready");
        }
      } catch (error) {
        if (
          error instanceof api.AdminError &&
          error.status === 401 &&
          current()
        )
          clearSession();
        throw error;
      }
    });
  }, [adminPage, enqueue, clearSession]);

  const mutate = useCallback(
    (id: string, request: () => Promise<EventOverride | null>) => {
      if (!adminPage || !admin)
        return Promise.reject(new api.AdminError("unauthorized", 401));
      return enqueue(async (current) => {
        try {
          const override = await request();
          if (!current()) return;
          setOverrides((previous) => {
            const next = new Map(previous);
            if (override) next.set(id, override);
            else next.delete(id);
            return next;
          });
          await refreshPublication(current);
        } catch (error) {
          if (
            error instanceof api.AdminError &&
            error.status === 401 &&
            current()
          )
            clearSession();
          throw error;
        }
      });
    },
    [adminPage, admin, enqueue, refreshPublication, clearSession],
  );

  const publish = useCallback(() => {
    if (!adminPage || !admin)
      return Promise.reject(new api.AdminError("unauthorized", 401));
    return enqueue(async (current) => {
      try {
        const release = await api.publish();
        if (!current()) return;
        setPublication((previous) => ({
          revision: previous?.revision ?? release.revision,
          staged_at: previous?.staged_at ?? null,
          latest: release,
          deployed: previous?.deployed ?? null,
        }));
        setPublicationError("");
        await refreshPublication(current);
      } catch (error) {
        if (
          error instanceof api.AdminError &&
          error.status === 401 &&
          current()
        )
          clearSession();
        throw error;
      }
    });
  }, [adminPage, admin, enqueue, refreshPublication, clearSession]);

  return {
    adminPage,
    status,
    admin,
    overrides,
    publication,
    publicationError,
    reload,
    login,
    logout,
    publish,
    saveSchedule: (id, schedule) =>
      mutate(id, () => api.saveSchedule(id, schedule)),
    restoreSchedule: (id) => mutate(id, () => api.restoreSchedule(id)),
    saveImage: (id, crop, file) =>
      mutate(id, () => api.saveImage(id, crop, file)),
    restoreImage: (id) => mutate(id, () => api.restoreImage(id)),
  };
}
