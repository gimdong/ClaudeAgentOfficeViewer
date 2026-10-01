import { useEffect, useRef, useState } from "react";
import type { DiagnosticsSummary } from "../../src/shared/types";
import { Icon } from "../pixel/Icon";
import { DiagIcon } from "./DiagIcon";
import { hhmm, hookLine, sortItems, verdict } from "./format";

const LABEL = { fail: "문제", warn: "확인 필요", ok: "정상" } as const;

type Bundle = { state: "idle" | "busy" } | { state: "done"; file: string } | { state: "fail" };

/** "진단 파일" 절(디자인 6장). 패널을 닫으면 사라지므로 다시 열면 기본 상태다 */
function BundleSection({ diagDir, announce }: { diagDir: string | null; announce(text: string): void }) {
  const [b, setB] = useState<Bundle>({ state: "idle" });
  const btn = useRef<HTMLButtonElement>(null);
  const link = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (b.state === "done") link.current?.focus();
    if (b.state === "fail") btn.current?.focus();
  }, [b]);

  const make = () => {
    setB({ state: "busy" });
    fetch("/api/diagnostics/bundle", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(async (r) => {
        const file = r.status === 201 ? ((await r.json()) as { file?: unknown }).file : undefined;
        if (typeof file === "string") {
          // 완료 상자와 같은 업데이트에서 알린다(effect에서 하면 한 박자 늦다)
          setB({ state: "done", file });
          announce("진단 파일을 만들었습니다");
        } else setB({ state: "fail" });
      })
      .catch(() => setB({ state: "fail" }));
  };

  // 경로 구분자는 diagDir을 따른다(Windows는 "\")
  const sep = diagDir?.includes("\\") ? "\\" : "/";
  return (
    <section className="dp-sec" aria-labelledby="dp-file-h">
      <h3 id="dp-file-h">진단 파일</h3>
      <p className="dp-note">문제가 생기면 이 파일을 만들어 담당자에게 보내 주세요. 대화 내용, 이름, 비밀값은 들어가지 않습니다.</p>
      {b.state === "busy" ? (
        <button ref={btn} type="button" className="pbtn pbtn--primary" disabled aria-busy="true">
          만드는 중…
        </button>
      ) : (
        <button ref={btn} type="button" className="pbtn pbtn--primary" onClick={make}>
          {b.state === "done" ? "다시 만들기" : "진단 파일 만들기"}
        </button>
      )}
      {b.state === "done" && (
        <div className="dp-result">
          <p>진단 파일을 만들었습니다</p>
          <span className="name">{diagDir ? `${diagDir}${sep}${b.file}` : b.file}</span>
          <a ref={link} className="pbtn" href={`/api/diagnostics/files/${b.file}`} download>
            <DiagIcon name="down" />
            받기
          </a>
        </div>
      )}
      {b.state === "fail" && (
        <div className="dp-fail" role="alert">
          진단 파일을 만들지 못했습니다. 잠시 뒤 다시 눌러 주세요. 계속 안 되면 터미널에서 <code>claude-office diag</code>를 실행해 주세요.
        </div>
      )}
    </section>
  );
}

function Body({ data, announce }: { data: DiagnosticsSummary; announce(text: string): void }) {
  const items = sortItems(data.doctor);
  const v = verdict(items);
  return (
    <>
      <section className="dp-sec">
        <div className={`dp-verdict ${v.status}`}>
          <DiagIcon name={v.status} />
          {v.text}
        </div>
      </section>
      <section className="dp-sec" aria-labelledby="dp-err-h">
        <h3 id="dp-err-h">최근 오류</h3>
        <p className={`dp-line${data.errorsLastHour ? " err" : ""}`}>
          {data.errorsLastHour ? (
            <>
              최근 1시간 오류 <b>{data.errorsLastHour}건</b>
            </>
          ) : (
            "최근 1시간 오류 없음"
          )}
        </p>
        <p className="dp-sub">로그 폴더 {data.logDir}</p>
      </section>
      <section className="dp-sec" aria-labelledby="dp-hook-h">
        <h3 id="dp-hook-h">hook 수신</h3>
        <p className="dp-line">{hookLine(data.hooks)}</p>
      </section>
      <section className="dp-sec" aria-labelledby="dp-doc-h">
        <h3 id="dp-doc-h">점검 결과</h3>
        <ul className="dp-rows">
          {items.map((x) => (
            <li key={x.id} className={`dp-row dp-row--${x.status}`}>
              <DiagIcon name={x.status} />
              <span className="t">
                <span className="sr-only">{LABEL[x.status]}: </span>
                {x.title}
              </span>
              <span className="d">{x.detail}</span>
              {/* 고치는 법은 warn·fail에서만(디자인 4장). ok의 fix(예: B12 요금제 한도 안내)는 보이지 않는다 */}
              {x.status !== "ok" && x.fix && <span className="f">{x.fix}</span>}
            </li>
          ))}
        </ul>
      </section>
      <BundleSection diagDir={data.diagDir || null} announce={announce} />
    </>
  );
}

/** 진단 패널(디자인 3장). 비모달 오른쪽 서랍이고 포커스를 가두지 않는다 */
export function DiagnosticsPanel(props: {
  data: DiagnosticsSummary | null;
  error: string | null;
  checkedAt: number | null;
  busy: boolean;
  onReload(): void;
  onClose(): void;
}) {
  const { data, error, checkedAt, busy, onReload, onClose } = props;
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => title.current?.focus({ preventScroll: true }), []);

  // 알림은 패널과 함께 처음부터 있는 빈 status 노드 하나에 글자만 바꿔 넣는다. 내용을 가진 채 새로 생기는
  // role=status는 일부 스크린 리더가 읽지 않는다(Phase 1 Ruling P16). 같은 문장을 다시 알릴 때는 끝에
  // NBSP를 번갈아 붙여 글자가 바뀌게 한다(App.tsx와 같은 방법)
  const [say, setSay] = useState({ text: "", n: 0 });
  const announce = (text: string) => setSay((p) => ({ text, n: p.n + 1 }));
  const verdictText = data ? verdict(data.doctor).text : "";
  // 판정이 바뀔 때만 알린다. 다시 가져올 때마다(60초 주기 포함) 알리면 같은 문장이 반복되고,
  // 방금 알린 "진단 파일을 만들었습니다"를 덮어쓴다
  useEffect(() => {
    if (verdictText) announce(verdictText);
  }, [verdictText]);

  let body;
  if (error) {
    body = (
      <div className="dp-state err" role="alert">
        {error}
        <br />
        <button type="button" className="pbtn" onClick={onReload}>
          다시 시도
        </button>
      </div>
    );
  } else if (!data) {
    body = (
      <div className="dp-state">진단 정보를 불러오는 중…</div>
    );
  } else body = <Body data={data} announce={announce} />;

  return (
    <aside id="diag-panel" className="diag-panel" role="dialog" aria-modal="false" aria-labelledby="dp-title">
      <header className="dp-head">
        <DiagIcon name="diag" className="ico" />
        <h2 ref={title} className="dp-title" id="dp-title" tabIndex={-1}>
          진단
        </h2>
        <span className="dp-checked">{data && checkedAt ? `${hhmm(checkedAt)} 확인` : ""}</span>
        <button type="button" className="icon-btn" aria-label="다시 확인" aria-busy={busy || undefined} onClick={onReload}>
          <DiagIcon name="reload" />
        </button>
        <button type="button" className="icon-btn" aria-label="닫기" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div className="dp-scroll">{body}</div>
      <div className="sr-only" role="status">
        {say.n % 2 === 0 ? say.text : `${say.text}\u00A0`}
      </div>
    </aside>
  );
}
