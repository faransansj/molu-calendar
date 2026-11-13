import { useState } from "react";
import { useAdminContext } from "../hooks/useAdmin.ts";
import type { PublicationState } from "../lib/admin/publication.ts";
import { sitePath } from "../lib/urls.ts";
import { Icon } from "./Icon.tsx";
import { Notice, primaryButton, quietButton, smallButton } from "./ui.tsx";

const stateLabels: Record<PublicationState, string> = {
  queued: "게시 대기 중",
  building: "빌드·배포 중",
  published: "게시 완료",
  failed: "게시 실패",
};

export function AdminSettings() {
  const admin = useAdminContext();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [expanded, setExpanded] = useState(false);
  const publication = admin.publication;
  const publishing =
    publication?.latest?.state === "queued" ||
    publication?.latest?.state === "building";

  return (
    <section
      aria-labelledby="admin-settings"
      className={
        admin.adminPage ? "flex flex-wrap items-center gap-2" : undefined
      }
    >
      <h3
        id="admin-settings"
        className={`${admin.adminPage ? "mr-auto" : "mb-2.5"} flex items-center gap-2 text-md font-semibold text-ink [&_.icon]:size-4 [&_.icon]:text-blue`}
      >
        <Icon name="wrench" />
        관리자 모드
      </h3>
      <div
        className={
          admin.adminPage
            ? "contents"
            : "divide-y divide-line rounded-lg border border-line"
        }
      >
        <div
          className={
            admin.adminPage
              ? "contents"
              : "flex flex-wrap items-center gap-2 px-3.5 py-2"
          }
        >
          {!admin.adminPage ? (
            <a
              className={`${quietButton} ${smallButton}`}
              href={sitePath("admin/")}
            >
              관리자 페이지로
            </a>
          ) : (
            <>
              <a
                className={`${quietButton} ${smallButton}`}
                href={sitePath("")}
              >
                공개 캘린더로 돌아가기
              </a>
              <>
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls="admin-stage-details"
                  onClick={() => setExpanded(!expanded)}
                  className={`${quietButton} ${smallButton}`}
                >
                  스테이지 안내 · 게시 상태
                  {publication?.latest &&
                    ` · ${stateLabels[publication.latest.state]}`}
                </button>
                <div
                  id="admin-stage-details"
                  hidden={!expanded}
                  className="order-last w-full space-y-3 border-t border-line pt-3 text-sm text-body"
                >
                  <p className="text-sm text-body">
                    이 페이지는 스테이지 미리보기예요. 저장한 수정은 자동으로
                    게시되지 않아요. 핫픽스를 누르면 저장된 스테이지 전체의
                    게시를 바로 요청해요. 빌드·배포가 끝나야 공개 사이트에
                    반영돼요.
                  </p>
                  {admin.status === "offline" && (
                    <Notice
                      tone="warn"
                      action={
                        <button
                          type="button"
                          className={`${quietButton} ${smallButton}`}
                          onClick={() => void admin.reload()}
                        >
                          다시 시도
                        </button>
                      }
                    >
                      관리 서버에서 스테이지를 불러오지 못했어요. 로그인하거나
                      다시 시도해 주세요.
                    </Notice>
                  )}
                  {admin.status === "loading" && (
                    <p className="text-sm text-muted">
                      관리 서버에 연결하고 있어요.
                    </p>
                  )}
                  {admin.admin ? (
                    <>
                      <p className="text-sm text-body">
                        일정 정보 창에서 이미지와 기간을 수정할 수 있어요.
                        원래대로 되돌리기도 스테이지에 저장돼요.
                      </p>
                      <div
                        aria-live="polite"
                        className="space-y-1 text-sm text-body"
                      >
                        {publication ? (
                          <>
                            <p>
                              스테이지 리비전: {publication.revision} · 공개
                              리비전:{" "}
                              {publication.deployed?.revision ?? "아직 없음"}
                            </p>
                            <p>
                              {publication.deployed?.revision ===
                              publication.revision
                                ? "현재 스테이지가 공개 사이트에 반영됐어요."
                                : "공개 사이트에 아직 반영되지 않은 스테이지가 있어요."}
                            </p>
                            {publication.latest && (
                              <p>
                                최근 게시:{" "}
                                {stateLabels[publication.latest.state]} (리비전{" "}
                                {publication.latest.revision})
                              </p>
                            )}
                            {publication.latest?.state === "failed" && (
                              <p>
                                스테이지는 보존돼 있어요. 핫픽스로 다시 요청할
                                수 있어요.
                              </p>
                            )}
                          </>
                        ) : (
                          <p>게시 상태를 아직 확인하지 못했어요.</p>
                        )}
                      </div>
                      {admin.publicationError && (
                        <Notice tone="warn">
                          게시 상태를 갱신하지 못했어요.{" "}
                          {admin.publicationError}
                        </Notice>
                      )}
                    </>
                  ) : null}
                </div>
              </>
              {admin.admin && (
                <>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={`${primaryButton} ${smallButton}`}
                      disabled={busy || publishing || admin.status !== "ready"}
                      onClick={async () => {
                        setBusy(true);
                        setMessage("");
                        try {
                          await admin.publish();
                          setMessage(
                            "핫픽스 게시를 요청했어요. 게시 완료 상태를 확인해 주세요.",
                          );
                        } catch (error) {
                          setMessage(
                            `스테이지는 그대로 저장돼 있어요. ${error instanceof Error ? error.message : "게시 요청을 하지 못했어요."}`,
                          );
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      {publishing ? "게시 진행 중" : "스테이지 전체 핫픽스"}
                    </button>
                    <button
                      type="button"
                      className={`${quietButton} ${smallButton}`}
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        setMessage("");
                        try {
                          await admin.logout();
                        } catch (error) {
                          setMessage(
                            error instanceof Error
                              ? error.message
                              : "로그아웃하지 못했어요.",
                          );
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      관리자 모드 끄기
                    </button>
                  </div>
                </>
              )}
              {message && (
                <div className="order-last w-full">
                  <Notice tone="warn">{message}</Notice>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
