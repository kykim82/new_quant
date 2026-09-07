# 고정 추천의 가격·거래대금·종가 손절 상태와 DB 모의 추적 결과를 표시한다.
import atexit
import hashlib
import math
import os
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


@st.cache_resource(on_release=lambda worker: worker.stop())
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
    st.subheader(f"추천 추적 {len(shown)}개" if tracking is not None else f"매수 후보 {len(shown)}개")
    if shown:
        table = recommendation_table(shown) if tracking is not None else candidate_table(shown)
        st.dataframe(table, hide_index=True, width="stretch", height=min(738, (len(shown) + 1) * 35 + 3))
    elif not stale:
        st.info("현재 추적 중인 추천이 없습니다.")
    if tracking is not None:
        st.caption("단타 15분·스윙 1시간 종가가 손절가 아래에서 마감하면 종료합니다. 장중 이탈·순위 하락만으로 제외하지 않습니다.")
        with st.expander("추천 추적 이력 · 모의 성과"):
            summary = tracking["summary"]
            evaluated = summary.get("evaluated") or 0
            st.caption(f"전체 기록 {summary.get('total', 0)}건 · 평가 완료 {evaluated}건 · 미진입 종료 {summary.get('unfilled') or 0}건 · 평가 제외 {summary.get('excluded') or 0}건")
            if evaluated:
                st.write(f"비용 반영 모의 수익 거래 비율 {(summary.get('wins') or 0) / evaluated * 100:.1f}% · 평균 손익 {percent(summary['meanNetPct'])}")
            else:
                st.info("평가가 완료된 모의 거래가 아직 없습니다.")
            st.caption("실제 주문·체결이 아닙니다. 추천 이후 완료된 15분봉의 매수가 터치를 모의 진입으로 봅니다. 목표는 1/3씩 청산하고 종가 손절은 확인 이후 다음 관측 15분봉 시가로 계산합니다. 데이터 공백·체결 순서 불명은 통계에서 제외합니다.")
            if tracking["history"]:
                st.dataframe(recommendation_history(tracking["history"]), hide_index=True, width="stretch")
            st.caption("종료 이력은 최근 100건과 청산 확인 대기 건을 표시합니다. 전체 기록과 최초 선별 지표는 DB에 보존하며 구형 손절 규칙 통계와 합산하지 않습니다.")
    active = {(c["market"], c["strategy"], c["plan"].get("id")) for c in shown}
    plans = [p for p in payload.get("savedPlans", []) if (p["market"], p["strategy"], p["plan"].get("id")) not in active]
    if plans:
        with st.expander(f"기존 매매 계획 {len(plans)}개"):
            st.caption("새 추천 추적 원장에 없는 이전 분석 계획입니다.")
            st.dataframe(candidate_table(plans, allow_entry=False), hide_index=True, width="stretch")
    observations = payload.get("watchlist", [])
    if observations:
        with st.expander(f"관찰·대기 {len({o['market'] for o in observations})}종목"):
            search = st.text_input("종목 검색", key="watch-search").strip().lower()
            st.dataframe(observation_table([o for o in observations if not search or search in (o["koreanName"] + o["market"]).lower()]),
                         hide_index=True, width="stretch")


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
    key = hashlib.sha256(json_settings(settings).encode()).hexdigest()
    dashboard(get_worker(key, settings))
    st.divider()
    st.caption("자동 주문 없음 · 표시 수익률은 매수가 기준이며 비용 차감 전입니다.")


def json_settings(settings):
    import json
    return json.dumps(settings, sort_keys=True)


if __name__ == "__main__":
    main()
