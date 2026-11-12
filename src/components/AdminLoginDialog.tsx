import { useEffect, useRef, useState } from "react";
import { useAdminContext } from "../hooks/useAdmin.ts";
import { sitePath } from "../lib/urls.ts";
import { Icon } from "./Icon.tsx";
import {
  Dialog,
  Notice,
  dialogHeading,
  dialogLead,
  field,
  iconButton,
  primaryButton,
  quietButton,
} from "./ui.tsx";

export function AdminLoginDialog({ open }: { open: boolean }) {
  const admin = useAdminContext();
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [message, setMessage] = useState("");
  const timer = useRef<number | undefined>(undefined);
  const passwordInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (open && !admin.admin && admin.status !== "loading" && !busy && !locked)
      passwordInput.current?.focus();
  }, [open, admin.admin, admin.status, busy, locked]);

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (open) location.assign(sitePath());
      }}
      label="관리자 인증"
      icon="wrench"
      labelledBy="admin-login-title"
      className="w-[420px]"
    >
      <h2 id="admin-login-title" className={dialogHeading}>
        관리자 암호를 입력해 주세요
      </h2>
      <p className={dialogLead}>
        인증을 마치면 스테이지와 핫픽스 작업 화면을 사용할 수 있어요.
      </p>
      <div className="mt-5 space-y-3">
        {admin.status === "loading" ? (
          <p role="status" className="text-sm text-muted">
            관리자 세션과 스테이지를 확인하고 있어요.
          </p>
        ) : (
          <>
            {admin.status === "offline" && (
              <Notice
                tone="warn"
                action={
                  <button
                    type="button"
                    className={quietButton}
                    disabled={busy}
                    onClick={() => void admin.reload()}
                  >
                    다시 시도
                  </button>
                }
              >
                관리 서버에 연결하지 못했어요. 연결을 확인한 뒤 다시 시도해
                주세요.
              </Notice>
            )}
            {!admin.admin && (
              <form
                className="flex flex-col gap-3"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (busy || locked) return;
                  setBusy(true);
                  setMessage("");
                  try {
                    const result = await admin.login(password);
                    if (!result.ok) {
                      if (result.reason === "invalid")
                        setMessage(
                          `암호가 맞지 않아요. 남은 시도 ${result.remaining}회`,
                        );
                      else if (result.reason === "locked") {
                        setMessage(
                          `시도가 너무 많아요. ${Math.ceil(result.retryAfter / 60)}분 후 다시 시도해 주세요.`,
                        );
                        setLocked(true);
                        window.clearTimeout(timer.current);
                        timer.current = window.setTimeout(() => {
                          setLocked(false);
                          setMessage("");
                          timer.current = undefined;
                        }, result.retryAfter * 1000);
                      } else if (result.reason === "disabled")
                        setMessage("관리자 모드가 서버에 설정되지 않았어요.");
                      else setMessage("관리 서버에 연결하지 못했어요.");
                    }
                  } finally {
                    setPassword("");
                    setPasswordVisible(false);
                    setBusy(false);
                  }
                }}
              >
                <label
                  htmlFor="admin-password"
                  className="text-sm font-semibold text-ink"
                >
                  관리자 암호
                </label>
                <div className="relative">
                  <input
                    ref={passwordInput}
                    id="admin-password"
                    type={passwordVisible ? "text" : "password"}
                    autoComplete="current-password"
                    maxLength={64}
                    required
                    className={`${field} w-full pr-11`}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    disabled={busy || locked}
                  />
                  <button
                    type="button"
                    className={`${iconButton} absolute top-1/2 right-1 size-8! -translate-y-1/2`}
                    aria-label="입력한 암호 보기"
                    title={passwordVisible ? "암호 숨기기" : "암호 보기"}
                    aria-controls="admin-password"
                    aria-pressed={passwordVisible}
                    disabled={busy || locked}
                    onClick={() => setPasswordVisible((visible) => !visible)}
                  >
                    <Icon name={passwordVisible ? "eye-off" : "eye"} />
                  </button>
                </div>
                <button
                  type="submit"
                  className={primaryButton}
                  disabled={busy || locked}
                >
                  관리자 모드 켜기
                </button>
              </form>
            )}
          </>
        )}
        {message && <Notice tone="warn">{message}</Notice>}
        <a className={quietButton} href={sitePath()}>
          공개 캘린더로 돌아가기
        </a>
      </div>
    </Dialog>
  );
}
