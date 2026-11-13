import { sitePath } from "../lib/urls.ts";
import { Icon } from "./Icon.tsx";
import { Dialog, dialogHeading, dialogLead } from "./ui.tsx";

const LINKS = [
  ["공식 커뮤니티", "https://forum.nexon.com/bluearchive"],
  ["공식 홈페이지", "https://bluearchive.nexon.com"],
  ["events.json", sitePath("data/events.json")],
  ["데이터 형식", sitePath("schema.json")],
  ["GitHub", "https://github.com/faransansj/molu-calendar"],
] as const;

export function SourcesDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      label="개인정보 처리방침"
      icon="info"
      labelledBy="sources-title"
      className="w-[600px]"
    >
      <h2 id="sources-title" className={dialogHeading}>
        개인정보 처리방침
      </h2>
      <p className={dialogLead}>
        모모톡의 AI(LLM)는 내 기기의 브라우저에서 실행돼요. 대화 내용과 저장한
        기억은 운영자나 외부 AI 서버로 전송되지 않으며, 모델 학습용으로 수집하지
        않아요.
      </p>
      <div className="mt-5 space-y-5 text-sm leading-relaxed text-muted [&_h3]:mb-1.5 [&_h3]:font-bold [&_h3]:text-ink">
        <section>
          <h3>기기에 저장되는 정보</h3>
          <p>
            대화와 기억은 브라우저의 IndexedDB에, 화면·알림·AI 설정 등은 로컬
            저장소에 보관해요. 다운로드한 AI 모델도 기기에 캐시해요. 이 정보는
            기능 제공을 위한 것으로, 다른 기기나 운영자 서버에 자동으로
            동기화하지 않아요. 일반 이용에 회원가입이나 이름·전화번호 입력은
            필요하지 않아요.
          </p>
        </section>
        <section>
          <h3>보관과 삭제</h3>
          <p>
            대화·기억·모델은 앱의 관리 기능에서 삭제할 수 있어요. 설정을 포함한
            전체 로컬 데이터는 브라우저의 사이트 데이터 삭제 기능으로 지울 수
            있어요. 직접 삭제하거나 브라우저가 저장 공간을 정리하기 전까지
            기기에 남을 수 있으며, 삭제한 데이터는 운영자가 복구할 수 없어요.
            내보낸 백업 파일은 별도로 보관되니 직접 관리·삭제해 주세요. 공용
            기기에서는 사용 후 사이트 데이터를 지워 주세요.
          </p>
        </section>
        <section>
          <h3>인터넷 연결과 외부 서비스</h3>
          <p>
            로컬 AI라고 해서 사이트의 모든 기능이 오프라인인 것은 아니에요.
            사이트·일정·이미지를 불러오거나 Hugging Face에서 모델을 다운로드할
            때는 인터넷에 연결해요. 이 과정에서 호스팅·파일 제공 서비스가 IP
            주소, 브라우저 정보 같은 접속 정보를 자체 정책에 따라 처리할 수
            있어요. 이는 AI 대화 내용을 전송하는 것과는 달라요. 외부 링크로
            이동한 뒤에는 해당 사이트의 개인정보 처리방침이 적용돼요.
          </p>
        </section>
        <section>
          <h3>문의와 개인정보 관련 요청</h3>
          <p>
            버그 제보, 보안 취약점 신고, 건의사항, 개인정보 관련 문의·삭제
            요청은{" "}
            <a
              href="mailto:molu-calendar.obstinate562@passinbox.com"
              className="break-all text-blue underline underline-offset-2"
            >
              molu-calendar.obstinate562@passinbox.com
            </a>
            으로 보내 주세요.
          </p>
          <p className="mt-2">
            메일을 보내면 발신자 주소와 문의 내용·첨부파일이 운영자 및 메일
            서비스에 전달돼요. 보내 주신 정보는 문의 응대와 문제 해결에만
            사용하고, 처리가 끝나 보관할 필요가 없어지면 삭제해요. 비밀번호 등
            민감한 정보는 보내지 말고, 화면 캡처나 대화 기록에 포함된 개인정보는
            가려 주세요. 기기에만 저장된 데이터는 운영자가 대신 열람하거나
            삭제할 수 없어요.
          </p>
        </section>
        <section>
          <h3>일정 데이터와 출처</h3>
          <p>
            블루 아카이브 한국 서버 공식 커뮤니티의 공지사항·업데이트·진행
            이벤트를 읽어 정리해요. 정확한 내용은 각 일정의 원문 공지를 확인해
            주세요. NEXON / NEXON Games와 관련 없는 비공식 팬 프로젝트예요.
          </p>
        </section>
      </div>
      <p className="mt-5 text-xs text-muted">
        시행일: 2026년 11월 13일 · 처리 방식이 바뀌면 이 페이지에 반영해요.
      </p>
      <nav
        className="mt-3.5 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-line pt-3.5 text-sm font-semibold"
        aria-label="데이터와 출처"
      >
        {LINKS.map(([label, href]) => {
          const external = href.startsWith("https:");
          return (
            <a
              key={href}
              href={href}
              className="inline-flex min-h-8 items-center gap-1 text-blue underline-offset-2 hover:underline [&_.icon]:size-[13px]"
              {...(external && {
                target: "_blank",
                rel: "noopener noreferrer",
              })}
            >
              {label}
              {external && <Icon name="external" />}
            </a>
          );
        })}
      </nav>
    </Dialog>
  );
}
