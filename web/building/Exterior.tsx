import { useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { SceneCell } from "../office/Desk";
import { ACTIONS, type ActionName } from "../office/Character";
import { ThemeContext } from "../themes/ThemeContext";

/**
 * 건물 바깥(Phase 7 Task 7, 계약 SPEC §2·§7): 하늘·스카이라인, 옥상, 카페, 로비, 거리. 모두 장식(aria-hidden, 누를 수 없음)이고
 * 글자(통로 낱말·관리실·간판)만 DOM 판 위. 카페·로비 section에는 접근 이름을 주지 않는다(영역 목록을 늘리지 않게, reviewer m1). 옥상은 간판 버튼이 있어 "옥상" 영역으로 둔다(P7b-3). 화면 밖 줄은 useOffscreen이 .floor--offscreen을 붙여 애니메이션을 멈춘다
 */

/** 화면 밖이면 true(IntersectionObserver). 없는 환경(옛 브라우저·테스트)은 늘 보임 */
export function useOffscreen(ref: RefObject<Element | null>): boolean {
  const [off, setOff] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== "function") return;
    const io = new IntersectionObserver((es) => {
      for (const e of es) if (e.target === el) setOff(!e.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return off;
}

/** 엑스트라 한 사람(팔레트 판 extra-<id>.png, 캐릭터 시트와 같은 칸·행). still이면 프레임 0 정지 */
function Extra({ id, action, still, style }: { id: string; action: ActionName; still?: boolean; style?: CSSProperties }) {
  const { theme } = useContext(ThemeContext);
  const a = ACTIONS[action];
  const s = { ...style, "--row": a.row, "--frames": a.frames, "--ms": `${a.ms}ms`, backgroundImage: `url(${theme.sheets[`extra-${id}.png`]})` } as CSSProperties;
  return <div className={`character extra${still ? " still" : ""}`} data-extra={id} aria-hidden="true" style={s} />;
}

/** 장면 칸 하나를 흐름 안에 둔다(크기 = 칸 ×2). children은 그 위에 겹침. 장면 칸은 모두 같은 시트(scene-<v>.png)라 slot은 대표로 lobby */
const Cell = ({ name, className = "", children }: { name: string; className?: string; children?: ReactNode }) => (
  <span className={`sc-box ${className}`}>
    <SceneCell slot="lobby" name={name} className="sc flow" />
    {children}
  </span>
);

/** 하늘(띠 = --th-sky-* 그라데이션, 해·달·구름 = sky.png 칸, 구름은 정지)과 스카이라인(backdrop-<v>.png 가로 반복) */
export function Sky() {
  const { theme, variant } = useContext(ThemeContext);
  const night = theme.manifest.variants[variant]?.ui === "dark" ? 1 : 0;
  const style = { "--sky-img": `url(${theme.slots.sky[variant]?.url})`, "--skyline-img": `url(${theme.slots.skyline[variant]?.url})`, "--night": night } as CSSProperties;
  return (
    <div className="sky" aria-hidden="true" style={style}>
      <i className="sky-sun" />
      <i className="sky-cloud" style={{ left: "12%", top: 40 }} />
      <i className="sky-cloud small" style={{ left: "62%", top: 24 }} />
      {/* 옥상 너머로 높은 건물(위)과 탑 옆 여백(아래) 두 겹(designer-themes I2) */}
      <div className="skyline top" />
      <div className="skyline" />
    </div>
  );
}

/** 옥상: 기계실(통로 칸)·물탱크·실외기·나무·벤치·안테나, 난간 위 간판(sign = 지금 간판 버튼) */
export function RoofRow({ sign }: { sign: ReactNode }) {
  const { theme, variant } = useContext(ThemeContext);
  const ref = useRef<HTMLElement>(null);
  const off = useOffscreen(ref);
  return (
    <section ref={ref} className={`floor floor--roof${off ? " floor--offscreen" : ""}`} data-row="roof" aria-label="옥상">
      <div className="shaft" data-lift="roof" aria-hidden="true">
        <Cell name="elevator-motor" />
      </div>
      <div className="roof-body">
        <div className="roof-props" aria-hidden="true">
          <Cell name="roof-tank" />
          <Cell name="roof-ac" />
          <Cell name="roof-tree" />
          <Cell name="roof-bench" className="opt" />
          <Cell name="roof-tree" className="opt" />
          <Cell name="roof-antenna" />
        </div>
        <div className="parapet" style={{ "--rail": `url(${theme.sheets[`roof-railing-${variant}.png`]})` } as CSSProperties}>
          {sign}
        </div>
      </div>
    </section>
  );
}

/** 빈 층의 공사 중 그림(vacant-*) — VacantFloor 방 안에 깐다 */
export function Construction() {
  return (
    <div className="construction" aria-hidden="true">
      <Cell name="vacant-bulb" className="bulb" />
      <Cell name="vacant-scaffold" className="opt" />
      <Cell name="vacant-ladder" />
      {/* 가운데(안내 글·버튼 자리)는 비우고 나머지는 오른쪽으로 */}
      <Cell name="vacant-barrier" className="push opt" />
      <Cell name="vacant-cone" />
      <Cell name="vacant-bucket" className="opt" />
      <Cell name="vacant-cone" className="opt" />
    </div>
  );
}

/** 카페 층(층 번호 없음). 팀원 자리 둘(.cafe-seat[data-seat])은 T8이 seats로, 걷기·이름표 복제는 children으로 채운다 */
export function CafeFloor({ seats, children }: { seats?: [ReactNode?, ReactNode?]; children?: ReactNode }) {
  const { theme } = useContext(ThemeContext);
  const ref = useRef<HTMLElement>(null);
  const off = useOffscreen(ref);
  return (
    <section ref={ref} className={`floor floor--cafe${off ? " floor--offscreen" : ""}`} data-row="cafe" data-testid="cafe-floor">
      <div className="shaft" data-lift="cafe">
        <span className="fl-no">{theme.words.rest.ko}</span>
      </div>
      <div className="floor-body">
        <div className="room">
          <div className="cafe-scene" aria-hidden="true">
            <i className="awning" />
            <span className="cafe-tag">{theme.words.rest.ko}</span>
            <span className="sc-box counter">
              <SceneCell slot="rest" name="rest-counter-back" className="sc flow" />
              <Extra id="barista" action="sit_down" still style={{ left: 80, top: 8 }} />
              <SceneCell slot="rest" name="rest-counter-front" className="sc over" />
            </span>
            <span className="rug">
              {/* 팀원 자리 둘: 앉은 사람(T8이 채움) 뒤에 테이블 앞면 */}
              {[1, 2].map((n) => (
                <span key={n} className="sc-box table">
                  <span className="cafe-seat" data-seat={n}>
                    {seats?.[n - 1]}
                  </span>
                  <SceneCell slot="rest" name="rest-table" className="sc flow over" />
                </span>
              ))}
            </span>
            <span className="sc-box table guest opt">
              <Extra id="customer-2" action="idle" style={{ left: 18, top: 10 }} />
              <SceneCell slot="rest" name="rest-table" className="sc flow over" />
            </span>
          </div>
          <div className="walk-layer" aria-hidden="true" />
          {children}
        </div>
      </div>
    </section>
  );
}

/** 로비(층 번호 없음): 엘리베이터 문, 화분·출입문·표지, 관리실 데스크와 경비. indicator = 상자 위치 표시("2F ▲", T8이 채움, §2b) */
export function LobbyFloor({ indicator }: { indicator?: ReactNode }) {
  const { theme } = useContext(ThemeContext);
  const ref = useRef<HTMLElement>(null);
  const off = useOffscreen(ref);
  return (
    <section ref={ref} className={`floor floor--lobby${off ? " floor--offscreen" : ""}`} data-row="lobby" data-testid="lobby-floor">
      <div className="shaft" data-lift="lobby">
        <span className="fl-no">{theme.words.lobby.ko}</span>
        {indicator != null && (
          <span className="lift-indicator" aria-hidden="true">
            {indicator}
          </span>
        )}
        <span aria-hidden="true">
          <Cell name="elevator-lobby-door" className="lift-door" />
        </span>
      </div>
      <div className="floor-body">
        <div className="room">
          <div className="lobby-scene" aria-hidden="true">
            <Cell name="lobby-plant" className="opt" />
            <Cell name="lobby-door">
              <SceneCell slot="lobby" name="lobby-sign" className="sc over sign-plaque" />
            </Cell>
            <span className="sc-box booth">
              <SceneCell slot="lobby" name="lobby-desk-back" className="sc flow" />
              <Extra id="guard" action="idle" style={{ left: 40, top: 56 }} />
              <SceneCell slot="lobby" name="lobby-desk-front" className="sc over" />
            </span>
          </div>
          <span className="booth-label">{theme.words.guard.ko}</span>
        </div>
      </div>
    </section>
  );
}

/** 거리: 인도·차도 타일, 가로등·가로수, 행인 2·차 2(계약 §7 한 곳에 합쳐 4 이하). 움직임은 translateX만 */
export function Street() {
  const { theme, variant } = useContext(ThemeContext);
  const ref = useRef<HTMLDivElement>(null);
  const off = useOffscreen(ref);
  const tile = theme.slots.street[variant]?.url;
  const cars = theme.slots.vehicle[variant]?.url ?? Object.values(theme.slots.vehicle)[0]?.url;
  const night = theme.manifest.variants[variant]?.ui === "dark" ? 1 : 0;
  return (
    <div ref={ref} className={`street${off ? " floor--offscreen" : ""}`} aria-hidden="true" style={{ backgroundImage: tile && `url(${tile})`, "--night": night } as CSSProperties}>
      {[
        [0, "8%"],
        [2, "30%", "opt"],
        [0, "52%", "opt"],
        [2, "88%"],
      ].map(([k, left, opt], i) => (
        <i key={i} className={`street-prop${opt ? " opt" : ""}`} style={{ "--k": k, left, backgroundImage: `url(${theme.sheets["street-props.png"]})` } as CSSProperties} />
      ))}
      <span className="walker" style={{ "--t": "30s", animationDelay: "-8s", "--x0": "15vw" } as CSSProperties}>
        <Extra id="passerby-1" action="walk_right" />
      </span>
      <span className="walker to-left" style={{ "--t": "40s", animationDelay: "-25s", "--x0": "62vw", top: -22 } as CSSProperties}>
        <Extra id="passerby-2" action="walk_left" />
      </span>
      {cars && (
        <>
          <i className="car to-left" style={{ "--kind": 1, "--dir": 2, "--t": "18s", animationDelay: "-6s", top: 30, "--x0": "55vw", backgroundImage: `url(${cars})` } as CSSProperties} />
          <i className="car" style={{ "--kind": 0, "--dir": 0, "--t": "14s", animationDelay: "-3s", top: 62, "--x0": "10vw", backgroundImage: `url(${cars})` } as CSSProperties} />
        </>
      )}
    </div>
  );
}
