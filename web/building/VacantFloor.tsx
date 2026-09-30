import { Icon } from "../pixel/Icon";

/** 맨 위 빈 층(디자인 5.2). Phase 1에서 버튼은 비활성이다 */
export function VacantFloor() {
  return (
    <section className="floor floor--empty" aria-label="빈 층" data-testid="vacant-floor">
      <div className="shaft">
        <span className="fl-no" aria-hidden="true">
          +
        </span>
        <span className="led led--empty" />
      </div>
      <div className="floor-body">
        <div className="room">
          <div className="vacant">
            <span className="sign">빈 층</span>
            <p>폴더와 첫 지시를 정하면 이 층에서 새 세션을 엽니다</p>
            <button type="button" className="pbtn pbtn--primary" aria-disabled="true" title="아직 사용할 수 없습니다">
              <Icon name="plus" />
              새 세션 시작
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
