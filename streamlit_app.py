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

from quant_worker import AnalysisWorker, SECRET_KEYS

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
        return "추적 유지 · 갱신 대기"
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


def strategy_rows(candidates, strategy):
    rows = [c for c in candidates if c["strategy"] == strategy]
    return [{**c, "rank": index + 1} for index, c in enumerate(rows[:10])]


def promising_table(candidates):
    return pd.DataFrame([{"종목": f"{c['koreanName']} ({c['market'].removeprefix('KRW-')})",
                          "현재가": current_quote(c), "24h 거래대금": turnover(c.get("quoteVolume24h")),
                          "선정 이유": c["reason"]} for c in candidates[:10]])


def normalize_symbol(value):
    code = value.strip().upper()
    code = code if code.startswith("KRW-") else "KRW-" + code
    if not re.fullmatch(r"KRW-[A-Z0-9]{1,20}", code):
        raise ValueError("영문 종목 코드를 입력해 주세요. 예를 들어 SOPH 또는 KRW-SOPH입니다.")
    return code


def detail_price_table(plan):
    entry = plan["entryAnchor"]
    return pd.DataFrame([{"항목": "매수가", "가격": price(entry)},
                         {"항목": "손절가", "가격": f"{price(plan['stop'])} ({percent(-plan['riskPct'])})"},
                         *[{"항목": f"{i + 1}차 목표가", "가격": f"{price(target)} ({percent((target / entry - 1) * 100)})"}
                           for i, target in enumerate(plan["targets"])]])


def render_detail(detail, stale=False):
    trend_names = {"transition": "역배열 탈출 시도", "up": "상승 추세", "down": "하락 추세", "mixed": "방향 전환 관찰", "unknown": "이력 부족"}
    alignment_names = {"bullish": "정배열", "bearish": "역배열", "mixed": "혼합 배열", "unknown": "이력 부족"}
    st.write(f"{detail['koreanName']} · 현재가 {current_quote(detail)} · 24h 거래대금 {turnover(detail.get('quoteVolume24h'))}")
    st.caption(f"마지막 상세 분석 {stamp(detail['generatedAt'])} · 완료된 봉 기준입니다.")
    for tab, unit in zip(st.tabs(["15분", "1시간", "4시간", "일봉"]), ("15", "60", "240", "1440")):
        with tab:
            frame = detail["frames"][unit]
            averages = frame["averages"]
            st.write(f"{trend_names[averages['state']]} · {alignment_names[averages['alignment']]}")
            st.caption(f"확인한 봉 마감 {stamp(frame['asOf'])}")
            if stale or not frame["valid"]:
                st.warning("최신 완료 봉 확인 대기 중입니다. 아래 값은 이전 분석 참고용입니다.")
            if unit in ("15", "60"):
                st.write("신규 진입 조건 충족" if frame["ready"] and not stale and frame["valid"] else "신규 진입 대기")
                st.caption("이전 분석입니다. 최신 조건 재확인을 기다려 주세요." if stale else frame.get("reason", ""))
                if frame.get("plan"):
                    st.dataframe(detail_price_table(frame["plan"]), hide_index=True, width="stretch")
                    st.caption("현재 혼합 산식의 재계산 가격입니다. 진입 대기 중인 가격은 즉시 매수 추천이 아닙니다.")
                else:
                    st.info("현재 데이터로 유효한 매매 가격을 산정하지 못했습니다.")
            elif unit == "240":
                st.caption("스윙의 상위 추세를 확인합니다. 매수가·손절가·목표가는 1시간 탭에 있습니다.")
            else:
                st.caption("일봉은 종목 선별용 추세만 확인하며 매매 가격은 산정하지 않습니다.")
            with st.expander("이평선·보조 지표 자세히"):
                rows = [{"이평선": f"SMA {p}", "가격": price(averages["ma"][p]) if averages["ma"][p] is not None else "이력 부족",
                         "방향": "상승" if (averages["slopes"][p] or 0) > 0 else "하락" if (averages["slopes"][p] or 0) < 0 else "보합·미확인"}
                        for p in averages["ma"]]
                st.dataframe(pd.DataFrame(rows), hide_index=True, width="stretch")
                number = lambda n: f"{n:.1f}" if n is not None else "미산정"
                st.write(f"RSI {number(frame['rsi'])} · 슈퍼트렌드 {'상승' if frame['supertrend'] == 1 else '하락' if frame['supertrend'] == -1 else '이력 준비'} · 타겟 트렌드 {'상승' if frame['targetTrend'] is True else '하락' if frame['targetTrend'] is False else '이력 준비'}")
                st.write("트리플 스토캐스틱 K / D · " + " · ".join(f"{label} {number(s['k'])} / {number(s['d'])}"
                         for label, s in zip(("단기", "중기", "장기"), frame["stochastic"])))
                if averages["crosses"]:
                    st.caption("최근 5봉 상향 돌파 이평선 · " + ", ".join(averages["crosses"]))
                st.caption(f"계산 이력 {frame['bars']}봉 · Target Trend 원안 BigBeluga, CC BY-NC-SA 4.0. 초기 이력·무거래 봉 처리에 따라 TradingView 값과 다를 수 있습니다.")


@st.fragment(run_every="10s")
def symbol_panel(worker):
    st.subheader("3. 종목 상세 분석")
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
        st.caption("관심 종목이나 보유 종목 하나를 입력해 시간대별 상태를 확인하세요.")
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
    if state.get("error"):
        st.warning(f"상세 갱신 대기. {state['error']}")
    detail = state.get("payload")
    if not detail:
        st.info("추천 분석을 마친 뒤 순서대로 조회합니다. 첫 분석은 다음 주기까지 기다릴 수 있습니다.")
        return
    stale = bool(state.get("error")) or datetime.now(KST).timestamp() * 1000 - detail["generatedAt"] > 180_000
    render_detail(detail, stale)
    tracked = [c for c in (worker.snapshot().get("payload") or {}).get("recommendations", {}).get("active", []) if c["market"] == market]
    history = detail.get("history", [])
    if tracked or history:
        with st.expander("이 종목의 기존 추천 고정 가격"):
            if tracked:
                st.dataframe(recommendation_table(tracked), hide_index=True, width="stretch")
            if history:
                st.dataframe(recommendation_history(history), hide_index=True, width="stretch")
            st.caption("추천 당시 가격과 모의 추적입니다. 실제 보유 여부나 실제 체결 내역은 아닙니다.")
    st.caption("초기 지표 이력은 순차 보충합니다. 선택 종목은 분석기 실행 중 약 1분 간격으로 갱신하며 앱 휴면·종료 동안 실시간 감시는 보장되지 않습니다.")


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
    candidates = [*payload["scalp"], *payload["swing"]] if not stale else []
    tracking = payload.get("recommendations")
    shown = tracking["active"] if tracking is not None else candidates
    st.subheader("1. 추천 종목")
    for tab, strategy, label in zip(st.tabs(["단타 · 15분", "스윙 · 1시간"]), ("scalp", "swing"), ("단타", "스윙")):
        with tab:
            selected = strategy_rows(shown, strategy)
            st.caption(f"{label} {len(selected)}종목 · 최대 10종목")
            if selected:
                table = recommendation_table(selected) if tracking is not None else candidate_table(selected)
                st.dataframe(table.drop(columns=["구분"]), hide_index=True, width="stretch", height=(len(selected) + 1) * 35 + 3)
            else:
                st.info("현재 조건에 맞는 추천이 없습니다.")
    st.caption("단타 15분·스윙 1시간 종가 손절을 추적합니다. 순위 밖 추천도 DB 추적은 유지하며 종목 상세에서 확인할 수 있습니다.")
    st.subheader("2. 유망 종목")
    active_markets = {c["market"] for c in shown}
    promising = [] if stale else [c for c in payload.get("promising", []) if c["market"] not in active_markets][:10]
    if promising:
        st.dataframe(promising_table(promising), hide_index=True, width="stretch")
    else:
        st.info("현재 유망 조건을 충족한 종목이 없거나 일봉 이력을 수집 중입니다.")
    st.caption("추천과 겹치지 않는 일봉 추세 개선·거래량 증가 종목입니다. 아직 매수 추천은 아닙니다.")


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
    symbol_panel(worker)
    st.divider()
    st.caption("자동 주문 없음 · 표시 수익률은 매수가 기준이며 비용 차감 전입니다.")


def json_settings(settings):
    import json
    return json.dumps(settings, sort_keys=True)


if __name__ == "__main__":
    main()
