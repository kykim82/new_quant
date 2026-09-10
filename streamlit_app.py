# 고정 추천의 가격·거래대금·종가 손절 상태와 DB 모의 추적 결과를 표시한다.
import atexit
import hashlib
import math
import os
import re
from pathlib import Path
from datetime import datetime, timezone, timedelta

import pandas as pd
import streamlit as st

from quant_worker import AnalysisWorker, SECRET_KEYS, quality_current

KST = timezone(timedelta(hours=9))


def stamp(value):
    return datetime.fromtimestamp(value / 1000, KST).strftime("%m.%d %H:%M:%S KST") if value else "아직 없음"


def price(value):
    return f"{value:,.0f}원" if value >= 100 else f"{value:,.4f}".rstrip("0").rstrip(".") + "원"


def current_quote(candidate):
    value = candidate.get("currentPrice")
    if value is None or not math.isfinite(value) or value <= 0:
        return "미수신"
    timestamp = candidate.get("currentPriceAt")
    time_label = (datetime.fromtimestamp(timestamp / 1000, KST).strftime("%H:%M")
                  if timestamp is not None and math.isfinite(timestamp) and timestamp > 0 else "시각 미수신")
    return f"{price(value)} ({time_label})"


def percent(value):
    return f"{value:+.2f}%"


def turnover(value):
    if value is None or not math.isfinite(value) or value < 0:
        return "미수신"
    if value >= 100_000_000:
        return f"{value / 100_000_000:,.1f}억원"
    if value >= 10_000:
        return f"{value / 10_000:,.0f}만원"
    return f"{value:,.0f}원"


@st.cache_resource(max_entries=1, on_release=lambda worker: worker.stop())
def get_worker(settings_key, _credentials):
    worker = AnalysisWorker(_credentials)
    atexit.register(worker.stop)
    worker.start()
    return worker


def credentials():
    values = {}
    for key in SECRET_KEYS:
        try:
            values[key] = str(st.secrets.get(key, os.environ.get(key, "")))
        except (FileNotFoundError, st.errors.StreamlitSecretNotFoundError):
            values[key] = os.environ.get(key, "")
    # 명시적인 로컬 검증 모드이며, 클라우드의 연결 실패를 임시 DB로 숨기지 않는다.
    if os.environ.get("QUANT_LOCAL_DB"):
        return {"QUANT_LOCAL_DB": os.environ["QUANT_LOCAL_DB"]}
    return values


def strategy_name(candidate):
    return "단타" if candidate["strategy"] == "scalp" else "스윙"


def candidate_table(candidates, allow_entry=True):
    rows = []
    for c in candidates:
        p = c["plan"]
        entry_status = c.get("entryStatus", "ready")
        if not allow_entry and entry_status == "ready":
            entry_status = "waiting"
        rows.append({"종목": f"{c['koreanName']} ({c['market'].removeprefix('KRW-')})", "구분": strategy_name(c),
                     "진입 상태": {"ready": "진입 가능", "waiting": "대기", "stopped": "종료", "completed": "목표 완료"}.get(entry_status, "확인 중"),
                     "매수가": price(p["entryAnchor"]), "현재가": current_quote(c),
                     "손절가": f"{price(p['stop'])} ({percent(-p['riskPct'])})",
                     **{f"{i + 1}차 목표가": f"{price(p['targets'][i])} ({percent((p['targets'][i] / p['entryAnchor'] - 1) * 100)})"
                        if i < len(p["targets"]) else "미산정" for i in range(3)},
                     "24h 거래대금": turnover(c.get("quoteVolume24h"))})
    return pd.DataFrame(rows)


def observation_table(observations):
    grouped = {}
    for o in observations:
        row = grouped.setdefault(o["market"], {"종목": f"{o['koreanName']} ({o['market'].removeprefix('KRW-')})", "strategies": set()})
        row["strategies"].add(o["strategy"])
        if row.get("quoteVolume24h") is None:
            row["quoteVolume24h"] = o.get("quoteVolume24h")
    return pd.DataFrame([{"종목": row["종목"],
                          "구분": "·".join(label for strategy, label in (("scalp", "단타"), ("swing", "스윙")) if strategy in row["strategies"]),
                          "진입 상태": "대기", "24h 거래대금": turnover(row.get("quoteVolume24h"))}
                         for row in grouped.values()], columns=["종목", "구분", "진입 상태", "24h 거래대금"])


def tracking_status(candidate):
    record = candidate["tracking"]
    if candidate.get("trackingDelayed"):
        return "기존 추천 · 최신 봉 확인 대기"
    if candidate.get("currentPrice") is not None and candidate["currentPrice"] < record["stop"]:
        return "손절선 이탈 · 봉 마감 대기"
    if record.get("entryMissedAt"):
        return "미진입 · 목표 도달 추적"
    if record["status"] == "open":
        return f"{record['sold']}차 도달 · 모의 추적" if record["sold"] else "모의 진입 · 추적 중"
    return "진입 가능 · 추적 중" if candidate.get("entryStatus") == "ready" else "추적 중 · 신규 진입 대기"


def recommendation_table(candidates):
    table = candidate_table(candidates).rename(columns={"진입 상태": "상태"})
    if not table.empty:
        table.insert(0, "순위", [c["rank"] for c in candidates])
        table["상태"] = [tracking_status(c) for c in candidates]
    return table


def sortable_candidate_table(candidates, table):
    amounts = pd.DataFrame([{"매수가": c["plan"]["entryAnchor"], "현재가": c.get("currentPrice"),
                             "손절가": c["plan"]["stop"],
                             **{f"{i + 1}차 목표가": c["plan"]["targets"][i] if i < len(c["plan"]["targets"]) else None
                                for i in range(3)},
                             "24h 거래대금": c.get("quoteVolume24h")} for c in candidates], index=table.index)
    numeric = table.copy()
    for column in amounts:
        values = pd.to_numeric(amounts[column], errors="coerce").astype(float)
        valid = values >= 0 if column == "24h 거래대금" else values > 0
        numeric[column] = values.where(values.map(math.isfinite) & valid)
    # 정렬에는 원본 금액만 사용하고, 각 행의 등락률·시세 시각은 기존 표시값을 보존한다.
    styled = numeric.style
    for index in table.index:
        for column in amounts:
            label = table.at[index, column]
            styled.format(lambda value, label=label: label, subset=([index], [column]))
    return styled


def recommendation_timing_table(candidates):
    def valid(value, positive=False):
        return type(value) in (int, float) and math.isfinite(value) and (not positive or value > 0)

    rows = []
    for c in candidates:
        record = c.get("tracking") or {}
        original = record.get("candidate") or {}
        created = record.get("createdAt")
        first_price, first_at = original.get("currentPrice"), original.get("currentPriceAt")
        latest, latest_at = c.get("currentPrice"), c.get("currentPriceAt")
        day_change = original.get("signedChangeRate")
        first_quote = "기록 없음"
        if valid(first_price, True):
            quote_time = datetime.fromtimestamp(first_at / 1000, KST).strftime("%m.%d %H:%M:%S") if valid(first_at, True) else "시각 없음"
            first_quote = f"{price(first_price)} ({quote_time})"
        change = "기록 없음"
        if valid(created, True) and valid(first_price, True) and valid(latest, True):
            change = percent((latest / first_price - 1) * 100)
            if valid(first_at, True) and valid(latest_at, True) and latest_at < first_at:
                change = "시세 확인 대기"
        rows.append({"종목": f"{c['koreanName']} ({c['market'].removeprefix('KRW-')})",
                     "최초 추천": stamp(created) if valid(created, True) else "기록 없음",
                     "추천 당시 시세": first_quote,
                     "당시 당일 등락": percent(day_change * 100) if valid(day_change) else "기록 없음",
                     "추천 후 등락": change})
    return pd.DataFrame(rows, columns=["종목", "최초 추천", "추천 당시 시세", "당시 당일 등락", "추천 후 등락"])


def strategy_rows(candidates, strategy):
    rows = []
    for c in candidates:
        if c["strategy"] != strategy or c.get("entryStatus") != "ready" or c.get("trackingDelayed"):
            continue
        record = c.get("tracking") or {}
        if record.get("status") in {"closing", "closed", "unfilled"} or any(
                record.get(key) for key in ("reached", "sold", "entryMissedAt", "endedAt")):
            continue
        rows.append(c)
    return [{**c, "rank": index + 1} for index, c in enumerate(rows[:10])]


def recommendation_empty_message(payload, strategy, stale, now_ms):
    coverage = payload.get("coverage") or {}
    observations = [o for o in payload.get("watchlist", []) if o.get("strategy") == strategy]
    rows = [c for c in [*(payload.get("recommendations") or {}).get("active", []),
                       *payload.get("savedPlans", [])] if c.get("strategy") == strategy]
    pending = stale or any(coverage.get(key, 0) > 0 for key in ("pendingMarketCount", "delayedMarketCount"))
    pending = pending or any(o.get("code") in {"DATA_DELAYED", "ENGINE_WARMUP", "INSUFFICIENT_DATA"} for o in observations)
    for c in rows:
        record = c.get("tracking") or {}
        if c.get("entryStatus") in {"stopped", "completed"} or any(
                record.get(key) for key in ("reached", "sold", "entryMissedAt", "endedAt")):
            continue
        pending = pending or c.get("trackingDelayed") or not quality_current(c.get("dataQuality"), now_ms)
        pending = pending or 0 < c.get("entryValidUntil", 0) <= now_ms
    if pending:
        summary = ""
        if all(key in coverage for key in ("freshMarketCount", "eligibleMarketCount", "pendingMarketCount", "delayedMarketCount")):
            summary = (f"최근 분석 {coverage['freshMarketCount']}/{coverage['eligibleMarketCount']}종목 · "
                       f"첫 분석 대기 {coverage['pendingMarketCount']}종목 · 재분석 지연 {coverage['delayedMarketCount']}종목. ")
        return f"현재 표시 가능한 추천이 없습니다. {summary}일부 데이터·추적 확인 중입니다."
    if not rows and not observations and not coverage.get("freshMarketCount"):
        return "분석 결과 확인 중입니다. 아직 추천 여부를 확정할 수 없습니다."
    return "현재 확인된 분석 결과에서 매수 조건을 충족한 종목이 없습니다."


def promising_table(candidates):
    selected = candidates[:10]
    table = pd.DataFrame([{"종목": f"{c['koreanName']} ({c['market'].removeprefix('KRW-')})",
                           "현재가": c.get("currentPrice"), "24h 거래대금": c.get("quoteVolume24h"),
                           "선정 이유": c["reason"]} for c in selected],
                         columns=["종목", "현재가", "24h 거래대금", "선정 이유"])
    for column in ("현재가", "24h 거래대금"):
        values = pd.to_numeric(table[column], errors="coerce").astype(float)
        nonnegative = values > 0 if column == "현재가" else values >= 0
        table[column] = values.where(values.map(math.isfinite) & nonnegative)
    # 숫자는 정렬용 원본으로 유지하고 원·억원·시각은 표시값에만 붙인다.
    styled = table.style.format({"24h 거래대금": turnover})
    for index, c in enumerate(selected):
        quote = current_quote({**c, "currentPrice": table.at[index, "현재가"]})
        styled.format(lambda value, label=quote: label, subset=([index], ["현재가"]))
    return styled


def normalize_symbol(value):
    code = value.strip().upper()
    code = code if code.startswith("KRW-") else "KRW-" + code
    if not re.fullmatch(r"KRW-[A-Z0-9]{1,20}", code):
        raise ValueError("영문 종목 코드를 입력해 주세요. 예를 들어 SOPH 또는 KRW-SOPH입니다.")
    return code


def detail_price_table(frames):
    def cell(value, entry=None):
        if not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            return "—"
        label = price(value)
        if isinstance(entry, (int, float)) and math.isfinite(entry) and entry > 0:
            label += f" ({percent((value / entry - 1) * 100)})"
        return label

    rows = []
    for unit, label in (("15", "15분"), ("60", "1시간"), ("240", "4시간"), ("1440", "일봉")):
        plan = frames.get(unit, {}).get("plan") or {}
        entry = plan.get("entryAnchor")
        targets = plan.get("targets") or []
        rows.append({"시간대": label, "매수가": cell(entry), "손절가": cell(plan.get("stop"), entry),
                     **{f"{i + 1}차 목표가": cell(targets[i], entry) if i < len(targets) else "—" for i in range(3)}})
    return pd.DataFrame(rows)


def render_detail(detail, stale=False):
    now_ms = int(datetime.now(KST).timestamp() * 1000)
    st.write(f"{detail['koreanName']} · 현재가 {current_quote(detail)} · 24h 거래대금 {turnover(detail.get('quoteVolume24h'))}")
    st.caption(f"마지막 상세 분석 {stamp(detail['generatedAt'])}")
    frames = detail.get("frames", {})
    st.dataframe(detail_price_table(frames), hide_index=True, width="stretch", height=178)
    delayed = []
    for unit, label in (("15", "15분"), ("60", "1시간"), ("240", "4시간"), ("1440", "일봉")):
        frame = frames.get(unit, {})
        width = int(unit) * 60_000
        if not frame.get("valid") or frame.get("asOf") != now_ms // width * width:
            delayed.append(label)
    if stale:
        st.warning("갱신 지연 · 표시 가격은 이전 분석 참고값입니다.")
    elif delayed:
        st.warning(f"{'·'.join(delayed)} 데이터 확인 대기 · 해당 가격은 참고값입니다.")


@st.fragment(run_every="10s")
def symbol_panel(worker):
    st.subheader("4. 종목 상세 분석")
    with st.form("symbol-detail-form"):
        value = st.text_input("종목 코드", placeholder="예. SOPH, SUI, BTC")
        submitted = st.form_submit_button("분석·자동 갱신")
    if submitted:
        try:
            market = normalize_symbol(value)
            worker.request_detail(market)
            st.session_state["detail_market"] = market
        except ValueError as error:
            st.error(str(error))
    market = st.session_state.get("detail_market")
    if not market:
        return
    if st.button("상세 자동 갱신 중지"):
        if worker.detail_snapshot()["market"] == market:
            worker.request_detail(None)
        st.session_state.pop("detail_market", None)
        st.rerun()
    state = worker.detail_snapshot()
    if state["market"] is None:
        worker.request_detail(market)
        state = worker.detail_snapshot()
    if state["market"] != market:
        st.info("다른 접속에서 상세 종목이 변경되었습니다. 분석 버튼을 눌러 다시 선택해 주세요.")
        return
    detail = state.get("payload")
    if not detail:
        if state.get("error"):
            st.warning(f"상세 갱신 대기. {state['error']}")
        else:
            st.info("상세 분석 준비 중입니다.")
        return
    stale = bool(state.get("error")) or datetime.now(KST).timestamp() * 1000 - detail["generatedAt"] > 180_000
    render_detail(detail, stale)
    tracked = [c for c in (worker.snapshot().get("payload") or {}).get("recommendations", {}).get("active", []) if c["market"] == market]
    history = detail.get("history", [])
    if tracked or history:
        with st.expander("이 종목의 기존 추천 고정 가격"):
            if tracked:
                st.dataframe(sortable_candidate_table(tracked, recommendation_table(tracked)),
                             hide_index=True, width="stretch", key=f"detail-recommendations-{market}")
            if history:
                st.dataframe(recommendation_history(history), hide_index=True, width="stretch")
            st.caption("추천 당시 가격과 모의 추적입니다. 실제 보유 여부나 실제 체결 내역은 아닙니다.")


def recommendation_history(records):
    rows = []
    for record in records:
        candidate = record["candidate"]
        result = ("평가 제외" if record.get("exclusions") else "체결 확인 대기" if record["status"] == "closing"
                  else "미진입" if record["status"] == "unfilled" else percent(record["netPct"]))
        rows.append({"최초 추천": stamp(record["createdAt"]), "종목": f"{candidate['koreanName']} ({record['market'].removeprefix('KRW-')})",
                     "구분": strategy_name(candidate), "매수가": price(record["entry"]), "손절가": price(record["stop"]),
                     "종료 시각": stamp(record.get("endedAt")),
                     "종료 사유": "종가 손절" if record.get("exitReason") == "stop_close" else "3차 목표 도달",
                     "모의 청산가": price(record["exitPrice"]) if record.get("exitPrice") is not None else "—",
                     "비용 반영 모의 손익": result})
    return pd.DataFrame(rows)


@st.fragment(run_every="10s")
def dashboard(worker):
    state = worker.snapshot()
    payload = state.get("payload")
    if state.get("error"):
        st.error("분석 갱신 실패. 신규 진입을 기다려 주세요.")
    if not payload:
        st.info("첫 분석을 준비하고 있습니다.")
        return
    stale = payload["stale"] or bool(state.get("error"))
    if stale and not state.get("error"):
        st.warning("분석 갱신 대기 중입니다. 현재 매수 여부를 판단할 수 없습니다.")
    status = "갱신 지연" if stale else "분석 중 · 최근 결과 표시" if state["running"] else "자동 갱신 대기" if state.get("waiting") else "자동 분석 정상"
    st.caption(f"{status} · 마지막 분석 {stamp(payload['generatedAt'])}")
    st.caption("현재가 괄호는 마지막으로 받은 업비트 시세의 기준 시각(KST)입니다.")
    st.caption("신규 추천은 최신 완료 일봉과 필수 시간대의 실제 봉·지표 이력 확인 후 표시합니다. 수집·복구 대기 중에도 기존 추천 기록은 보존합니다.")
    candidates = [*payload["scalp"], *payload["swing"]] if not stale else []
    tracking = payload.get("recommendations")
    shown = tracking["active"] if tracking is not None else candidates
    if stale:
        shown = [{**c, "currentAssessment": None, "entryStatus": "waiting"} for c in shown]
    st.subheader("1. 추천 종목")
    st.caption("지금 신규 진입 조건을 충족한 종목만 표시합니다. 1차 목표 도달 이력이 있거나 진입·최신 봉 확인을 기다리는 기존 추천은 제외합니다.")
    for tab, strategy, label in zip(st.tabs(["단타 · 15분", "스윙 · 1시간"]), ("scalp", "swing"), ("단타", "스윙")):
        with tab:
            selected = strategy_rows(shown, strategy)
            st.caption(f"{label} {len(selected)}종목 · 최대 10종목")
            if selected:
                table = recommendation_table(selected) if tracking is not None else candidate_table(selected)
                st.dataframe(sortable_candidate_table(selected, table.drop(columns=["구분"])),
                             hide_index=True, width="stretch", height=(len(selected) + 1) * 35 + 3,
                             key=f"recommendations-{strategy}")
                if tracking is not None:
                    with st.expander("추천 전후 비교"):
                        st.dataframe(recommendation_timing_table(selected), hide_index=True, width="stretch")
                        st.caption("당시 당일 등락은 추천 때의 업비트 전일 종가 대비입니다. 추천 후 등락은 당시 실제 시세에서 현재가까지의 변화이며, 최고 상승률이나 실제 매매 수익률은 아닙니다.")
                        st.caption("최초 추천은 해당 추천 기록의 분석 회차 시각(KST)입니다. 다시 추천된 종목은 새 기록으로 비교하며, 당시 시세의 기준 시각은 가격 옆에 표시합니다.")
            else:
                st.info(recommendation_empty_message(payload, strategy, stale, int(datetime.now(KST).timestamp() * 1000)))
    st.caption("추천 표에서 빠져도 기존 기록은 DB에 남아 목표가·단타 15분·스윙 1시간 종가 손절을 계속 추적합니다. 4. 종목 상세 분석에서 기존 추천 기록을 확인할 수 있습니다.")
    st.subheader("2. 유망 종목")
    active_markets = {c["market"] for c in shown}
    promising = [] if stale else [c for c in payload.get("promising", []) if c["market"] not in active_markets][:10]
    if promising:
        st.dataframe(promising_table(promising), hide_index=True, width="stretch", key="promising-table")
    else:
        st.info("현재 유망 조건을 충족한 종목이 없거나 일봉 이력을 수집 중입니다.")
    st.caption("상승 전 역배열 해소 준비·장기 이평선 부근 유지 종목입니다. 최근 20일 저가 대비 +20% 이내, SMA20 위 이격 +8% 이내를 초기 기준으로 사용하며 추천에는 이 제한을 적용하지 않습니다. 추천 중복은 숨깁니다.")


def main():
    st.set_page_config(page_title="KRW 퀀트 레이더", page_icon="📈", layout="wide")
    st.header("KRW 퀀트 레이더")
    settings = credentials()
    missing = [key for key in SECRET_KEYS if not settings.get(key)] if "QUANT_LOCAL_DB" not in settings else []
    if missing:
        st.warning("기존 가격 계획을 보존하기 위해 D1 저장소 연결이 필요합니다. 아직 분석을 시작하지 않았습니다.")
        st.write("Streamlit 앱 설정의 Secrets에 다음 항목을 등록해 주세요.")
        st.code('CLOUDFLARE_ACCOUNT_ID = "계정 ID"\nCLOUDFLARE_D1_DATABASE_ID = "데이터베이스 ID"\nCLOUDFLARE_API_TOKEN = "D1 전용 토큰"', language="toml")
        st.caption("토큰은 GitHub 파일이나 채팅에 올리지 마세요. 자세한 설정은 STREAMLIT_DEPLOY.md에 있습니다.")
        return
    revision = b"".join(Path(__file__).with_name(name).read_bytes() for name in ("engine.mjs", "quant_worker.py"))
    key = hashlib.sha256(json_settings(settings).encode() + revision).hexdigest()
    worker = get_worker(key, settings)
    dashboard(worker)
    surge_panel()
    symbol_panel(worker)
    st.divider()
    st.caption("자동 주문 없음 · 목표·손절 등락률은 매수가 기준이며 비용 차감 전입니다.")
    st.caption("Target Trend 원안 BigBeluga · [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)")


def surge_panel():
    st.subheader("3. 급등 코인")
    st.caption("급등 전 패턴 유사 종목 · 준비 중")


def json_settings(settings):
    import json
    return json.dumps(settings, sort_keys=True)


if __name__ == "__main__":
    main()
