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

from quant_worker import AnalysisWorker, SECRET_KEYS, price_plan_current, pipeline_current

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


def st_recommendation_table(candidates, tracking=None):
    records = {c["plan"]["id"]: c for c in (tracking or {}).get("active", [])}
    rows = []
    for c in candidates:
        plan = c["plan"]
        tracked = records.get(plan["id"])
        state = "미진입"
        if tracked:
            record = tracked["tracking"]
            if record.get("reached", 0):
                state = f"{record['reached']}차 매도가 도달"
            elif record.get("filledAt") is not None or record.get("status") == "open":
                state = "진입 · 추적 중"
        rows.append({"종목": f"{c['koreanName']} ({c['market'].removeprefix('KRW-')})",
                     "현재가": current_quote(c), "상태": state,
                     "매수가": price(plan["entryAnchor"]),
                     "손절가": price(plan["stop"]),
                     **{f"{i + 1}차 매도가": price(plan["targets"][i]) for i in range(3)},
                     "24시간 거래대금": turnover(c.get("quoteVolume24h")),
                     "3일 평균 거래대금": turnover(c["averageTurnover3d"])})
    return pd.DataFrame(rows)


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
    rows = [c for c in candidates if c["strategy"] == strategy]
    return [{**c, "rank": index + 1} for index, c in enumerate(rows[:10])]


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
    if not payload.get("primaryCoverage") or not payload.get("marketExclusions"):
        status = "새 ST 분석 결과 대기"
    pipeline = payload.get("pipeline") or {}
    if not stale:
        if not pipeline:
            status = "전체 수집 단계 확인 대기"
        elif not pipeline.get("turnoverComplete"):
            status = f"1/3 거래대금 저장·분류 {pipeline['classified']}/{pipeline['total']}종목"
        elif not pipeline.get("primaryComplete"):
            status = f"2/3 분봉 수집 확인 {pipeline['candlesReady']}/{pipeline['high']}종목"
        elif not pipeline.get("complete"):
            status = f"3/3 조건·가격 검사 {pipeline['assessed']}/{pipeline['high']}종목"
        else:
            status = "전체 수집·분류·조건 검사 완료"
    st.caption(f"{status} · 마지막 분석 {stamp(payload['generatedAt'])}")
    exclusions = payload.get("marketExclusions", {})
    primary = payload.get("primaryCoverage", {})
    candidates = payload.get("stRecommendations", []) if payload.get("stRecommendationVersion") == 1 else [*payload["scalp"], *payload["swing"]]
    candidates = [c for c in candidates if price_plan_current(c, payload["generatedAt"])] if not stale and exclusions.get("ready") and primary and pipeline_current(payload, payload["generatedAt"]) else []
    tracking = payload.get("recommendations")
    shown = candidates
    if not primary or not exclusions:
        st.warning("현재 저장 결과에는 새 ST 검사 정보가 없습니다. 새 분석 결과를 기다리고 있으며 추천 유무를 판단할 수 없습니다.")
    elif exclusions.get("ready") is not True:
        st.warning("유의·거래지원 종료 정보 확인 대기 중입니다. 신규 추천을 잠시 보류하고 기존 기록을 추적합니다.")
        if exclusions.get("error"):
            st.caption(f"제외 정보 조회 오류 · {exclusions['error']}")
    with st.expander("분석 기준·전체 종목 현황", expanded=False):
        st.caption("현재가 괄호는 마지막으로 받은 업비트 시세의 기준 시각(KST)입니다.")
        st.caption("3일 평균 거래대금 10억 원 이상에서 단타는 15분, 스윙은 1시간 ST Buy를 추천합니다. 상위봉과 기타 지표는 순위에 반영합니다.")
        exclusion_label = f"유의·거래지원 종료 제외 {len(exclusions['excluded'])}종목" if exclusions.get("ready") and "excluded" in exclusions else "유의·거래지원 종료 제외 종목 확인 대기"
        st.caption(f"전체 원화 {payload.get('coverage', {}).get('krwMarketCount', 0)}종목 · {exclusion_label}")
        if exclusions.get("source") == "upbit-open-api":
            st.caption("제외 기준 · 공식 API의 유의 지정·거래지원 상태·종료일을 확인합니다.")
        st.caption("추가 제외 · 테더(USDT)")
        turnover_coverage = payload.get("turnoverCoverage")
        if turnover_coverage:
            st.caption(f"최근 완료 72시간 거래대금 합계 ÷ 3 · 10억 원 이상 {turnover_coverage['high']}종목 · 미만 {turnover_coverage['low']}종목 · 분류 중 {turnover_coverage['pending']}종목")
        if pipeline.get("details"):
            st.caption("전 종목 저장·분류 내역입니다. 10억 미만은 거래대금 감시, 이상은 분봉 수집 후 조건을 검사합니다.")
            st.dataframe([{"종목": f"{d['name']} ({d['market']})",
                           "3일 평균 거래대금": turnover(d.get("average3d")) if d["group"] != "pending" else "확인 중",
                           "분류": {"high": "10억 이상 · 분석", "low": "10억 미만 · 감시", "pending": "저장·분류 대기"}[d["group"]],
                           **{f"{u}분 수집": "감시 대상" if d["group"] == "low" else "완료" if d.get("frames", {}).get(u, {}).get("ready") else "대기" for u in ("15", "60")},
                           "오류": d.get("turnoverError") or " / ".join(f.get("error", "") for f in d.get("frames", {}).values() if f.get("error"))}
                          for d in pipeline["details"]], hide_index=True, width="stretch")
        st.caption("과열 제외 · 4시간 또는 일봉 RSI 70 이상, 7·20기간 이평선 이격 8% 이상, 현재가의 20기간 이평선 이격 8% 이상이 함께 확인된 경우입니다. 목표 도달 여부만으로 제외하지 않습니다.")
        if payload.get("entryRiskExclusions"):
            st.dataframe([{"종목": r["name"], "추천 제외 사유": " / ".join(r["reasons"])} for r in payload["entryRiskExclusions"]], hide_index=True, width="stretch")
    for unit, label in (("15", "15분"), ("60", "1시간")):
        coverage = primary.get(unit)
        if coverage:
            if "inspected" in coverage:
                st.caption(f"{label} ST · 최신 봉 검사 {coverage['inspected']}/{coverage['total']} · Buy {coverage['buy']} · Sell {coverage['sell']} · 검사 대기 {coverage['waiting']} · 무거래 보류 {coverage.get('noTrade', 0)} · 판정 불가 {coverage['unavailable']} · 완료봉 {stamp(coverage['candleClose'])}")
                st.caption(f"{label} Buy 정밀 심사 {coverage['detailChecked']}/{coverage['buy']}종목 · 추천 조건 미충족·자료 부족으로 보류된 심사도 포함합니다.")
                labels = {"buy": "Buy", "sell": "Sell", "unscanned": "미검사", "recheck": "최신 봉 재검사 대기",
                          "no_trade": "최근 완료 시간대 무거래 · 신규 진입 보류", "missing_latest": "최신 실제 봉 없음", "history_short": "ST 계산 초기 이력 부족",
                          "api_error": "수집 오류", "indicator": "지표 계산 불가"}
                with st.expander(f"{label} 전체 종목 검사 내역·대기 사유"):
                    st.dataframe([{"종목": f"{d.get('name') or d['market']} ({d['market']})",
                                   "상태": labels.get(d["status"], d["status"]),
                                   "확인된 ST 방향": "Buy" if d.get("lastDirection") == 1 else "Sell" if d.get("lastDirection") == -1 else "계산 준비",
                                   "실제 봉 수": d["actualBars"], "최근 실제 완료봉": stamp(d["latestActualClose"]) if d["latestActualClose"] else "없음",
                                   "정밀 심사": "검사함" if d.get("detailChecked") else "대기" if d["status"] == "buy" else "—",
                                   "오류": d.get("error") or ""} for d in coverage.get("details", [])], hide_index=True, width="stretch")
            else:
                st.caption(f"{label} ST · 대상 {coverage['total']}종목 · Buy {coverage['buy']} · Sell {coverage['sell']} · 확인 대기 {coverage['pending']} · 검사 이력 {coverage['checked']}/{coverage['total']} · 완료봉 {stamp(coverage['candleClose'])}")
        else:
            st.caption(f"{label} ST · 새 검사 결과 확인 대기")
    st.subheader("1. 추천 종목")
    st.caption("현재 진입 조건을 통과하고 매수·손절·3단계 매도 가격이 확정된 종목만 표시합니다.")
    for tab, strategy, label in zip(st.tabs(["단타 · 15분", "스윙 · 1시간"]), ("scalp", "swing"), ("단타", "스윙")):
        with tab:
            selected = strategy_rows(shown, strategy)
            st.caption(f"{label} {len(selected)}종목 · 최대 10종목")
            if selected and payload.get("stRecommendationVersion") == 1:
                st.dataframe(st_recommendation_table(selected, tracking), hide_index=True, width="stretch",
                             height=(len(selected) + 1) * 35 + 3, key=f"recommendations-{strategy}")
            elif selected:
                table = candidate_table(selected)
                st.dataframe(sortable_candidate_table(selected, table.drop(columns=["구분"])),
                             hide_index=True, width="stretch", height=(len(selected) + 1) * 35 + 3,
                             key=f"recommendations-{strategy}")
            else:
                coverage = primary.get("15" if strategy == "scalp" else "60")
                if stale:
                    st.info("최신 분석 갱신을 기다리는 중입니다. 현재 추천 유무를 판단할 수 없습니다.")
                elif not coverage:
                    st.info("새 ST 분석 결과를 기다리는 중입니다. 현재 추천 유무를 판단할 수 없습니다.")
                elif not exclusions.get("ready"):
                    st.info("유의·거래지원 종료 제외 정보 확인 후 신규 추천을 표시합니다.")
                elif not pipeline_current(payload, payload["generatedAt"]):
                    st.info("전체 거래대금 저장·분류와 분석 대상의 분봉 수집을 확인한 뒤 추천을 표시합니다.")
                elif payload.get("stRecommendationVersion") == 1:
                    st.info("현재 진입 조건과 유효한 매수·손절·매도 가격 계획을 모두 갖춘 추천이 없습니다. 후보 검사는 계속 진행합니다.")
                elif coverage["pending"]:
                    st.info(f"ST Buy {coverage['buy']}종목 · {coverage['pending']}종목 확인 대기입니다. 현재까지 신규 진입 조건을 통과한 추천은 없습니다.")
                elif coverage["buy"] == 0:
                    st.info("최신 완료봉 검사 결과 ST Buy 0종목입니다. ST Sell은 신규 추천에서 제외합니다.")
                else:
                    st.info(f"ST Buy {coverage['buy']}종목이 확인됐지만 현재까지 신규 진입 조건을 통과한 추천은 없습니다. 정밀 분석·데이터 확인이 필요한 종목은 계속 검사합니다.")
                reasons = {}
                for row in payload.get("watchlist", []):
                    if row.get("strategy") == strategy and row.get("reason"):
                        reasons[row["reason"]] = reasons.get(row["reason"], 0) + 1
                if reasons and not payload.get("stRecommendationVersion") and not stale and coverage and exclusions.get("ready"):
                    st.caption("최근 분석 보류 사유 · " + " · ".join(f"{reason} {count}건" for reason, count in sorted(reasons.items(), key=lambda item: -item[1])[:3]))
    st.caption("가격 계획이 생성된 추천은 단타 15분·스윙 1시간 종가 손절을 추적합니다. 과거 기록과 추적은 계속 유지합니다.")
    if tracking and tracking.get("active"):
        with st.expander("과거 추천 추적 · 신규 추천과 별도"):
            previous = tracking["active"]
            st.caption("최초 추천의 고정 가격 계획입니다. 이 표에 있다는 이유로 현재 신규 매수 가능한 것은 아닙니다.")
            st.dataframe(sortable_candidate_table(previous, recommendation_table(previous)),
                         hide_index=True, width="stretch", key="past-recommendation-tracking")
            st.dataframe(recommendation_timing_table(previous), hide_index=True, width="stretch")
    st.subheader("2. 유망 종목")
    active_markets = {c["market"] for c in shown}
    promising = [] if stale or not payload.get("marketExclusions", {}).get("ready") else [
        c for c in payload.get("promising", []) if c["market"] not in active_markets
    ][:10]
    if promising:
        st.dataframe(promising_table(promising), hide_index=True, width="stretch", key="promising-table")
    else:
        st.info("현재 유망 조건을 충족한 종목이 없거나 일봉 이력을 수집 중입니다.")
    st.caption("거래대금 증가를 내부에서 확인하고, 기존 일봉의 역배열 해소 준비·장기 이평선 부근 유지 조건을 만족한 종목을 표시합니다. 최근 20일 저가 대비 +20% 이내, SMA20 위 이격 +8% 이내인 상승 준비 종목이며 추천 종목은 중복 표시하지 않습니다.")




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
