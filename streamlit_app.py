# 단타·스윙 추천과 고정 가격 계획을 차트 없는 통합 표로 표시한다.
import atexit
import hashlib
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


def percent(value):
    return f"{value:+.2f}%"


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


def plan_details(candidate):
    plan = candidate["plan"]
    st.caption(f"{strategy_name(candidate)} · 신호 {stamp(candidate['signalTime'])} · 추세 점수 {candidate['score']}점")
    st.write(f"매수 구간 {price(plan['entryLow'])} ~ {price(plan['entryHigh'])}")
    if plan.get("version") != "indicator-v4":
        st.info("기존 방식의 고정 가격 계획입니다. 새 목표 산정 방식으로 자동 변경하지 않습니다.")
    if candidate.get("entryBlockReason"):
        st.warning(candidate["entryBlockReason"])
    st.write(plan.get("targetMethod", "목표 산정 근거는 아래 기록을 확인해 주세요."))
    net_split = plan.get("netSplitReturn") if len(plan["targets"]) == 3 else None
    st.caption(f"세 목표에서 ⅓씩 매도 시 비용 후 수익률 {percent(net_split) if net_split is not None else '미산정'} · 모든 목표 도달 가정")
    for reason in candidate.get("reasons", []):
        st.write(f"• {reason}")
    st.write(plan.get("entryReason", ""))
    st.write(plan.get("stopReason", ""))
    for index, evidence in enumerate(plan.get("targetEvidence", [])):
        st.write(f"{index + 1}차. {' · '.join(evidence['reasons'])}")
    for resistance in plan.get("intermediateResistances", []):
        st.write(f"중간 저항 {price(resistance['price'])} · {' · '.join(resistance['reasons'])}")
    for warning in candidate.get("warnings", []):
        st.warning(warning)


def details_selector(candidates, key):
    selected = st.selectbox("종목별 근거 확인", range(len(candidates)), key=key,
                            format_func=lambda i: f"{candidates[i]['koreanName']} · {candidates[i]['market']} · {strategy_name(candidates[i])}")
    plan_details(candidates[selected])


def candidate_table(candidates):
    rows = []
    for c in candidates:
        p = c["plan"]
        notes = []
        if p.get("version") != "indicator-v4":
            notes.append("기존 목표")
        if p.get("intermediateResistances"):
            notes.append(f"중간 저항 {len(p['intermediateResistances'])}개")
        if c.get("warnings"):
            notes.append(c["warnings"][0] + (f" 외 {len(c['warnings']) - 1}건" if len(c["warnings"]) > 1 else ""))
        rows.append({"종목": f"{c['koreanName']} ({c['market'].removeprefix('KRW-')})", "구분": strategy_name(c),
                     "진입 상태": {"ready": "진입 가능", "waiting": "대기", "stopped": "종료"}.get(c.get("entryStatus", "ready"), "확인 중"),
                     "현재가": price(c["currentPrice"]),
                     "고정 매수가": price(p["entryAnchor"]), "손절가": f"{price(p['stop'])} ({percent(-p['riskPct'])})",
                     **{f"{i + 1}차 매도가": f"{price(p['targets'][i])} ({percent((p['targets'][i] / p['entryAnchor'] - 1) * 100)})"
                        if i < len(p["targets"]) else "미산정" for i in range(3)},
                     "24h 거래대금": f"{c['quoteVolume24h'] / 1e8:,.1f}억", "주의": " · ".join(notes) or "—"})
    return pd.DataFrame(rows)


@st.fragment(run_every="10s")
def dashboard(worker):
    state = worker.snapshot()
    payload = state.get("payload")
    if state.get("error"):
        st.error(f"분석 갱신 실패. {state['error']}")
    if not payload:
        st.info("첫 분석을 준비하고 있습니다. 저장소 연결과 시세 수집이 완료되면 결과가 표시됩니다.")
        return
    if payload["stale"]:
        st.warning("분석 데이터가 오래되었거나 갱신에 실패했습니다. 신규 매수 추천을 숨겼습니다. 후보가 없다는 뜻은 아닙니다.")
    elif state.get("waiting"):
        st.info(state["waiting"])
    coverage = payload["coverage"]
    regime = {"BULLISH": "강세", "NEUTRAL": "중립", "RISK_OFF": "위험 회피"}.get(payload["marketRegime"], "확인 중")
    status = "갱신 지연" if payload["stale"] else "분석 중 · 마지막 완료 결과 표시" if state["running"] else "자동 분석 정상"
    st.caption(f"{status} · BTC {regime} · 분석 {coverage['analyzedMarketCount']}/{coverage['eligibleMarketCount']}개 · 마지막 분석 {stamp(payload['generatedAt'])}")
    candidates = [*payload["scalp"], *payload["swing"]] if not payload["stale"] else []
    st.subheader("매수 후보 · 갱신 대기" if payload["stale"] else f"매수 후보 {len(candidates)}개")
    if candidates:
        st.dataframe(candidate_table(candidates), hide_index=True, width="stretch", height=(len(candidates) + 1) * 35 + 3)
        st.caption("단타·스윙을 함께 표시합니다. 수익률은 고정 매수가 기준이며, 같은 종목도 전략별 가격 계획은 다릅니다.")
        with st.expander("목표 산정 근거·주의사항"):
            details_selector(candidates, "candidate-details")
    elif not payload["stale"]:
        st.info("이번에 분석된 종목 중 현재 신규 진입 조건을 충족한 후보가 없습니다. 아래 관찰·대기 사유를 확인해 주세요.")
    active = {(c["market"], c["strategy"], c["plan"].get("id")) for c in candidates}
    plans = [p for p in payload.get("savedPlans", []) if (p["market"], p["strategy"], p["plan"].get("id")) not in active]
    if plans:
        with st.expander(f"기존 고정 가격 계획 {len(plans)}개 · 신규 추천과 구분"):
            st.dataframe(candidate_table(plans), hide_index=True, width="stretch")
            details_selector(plans, "saved-details")
    observations = payload.get("watchlist", [])
    if observations:
        with st.expander(f"관찰·대기 {len(observations)}건"):
            search = st.text_input("종목·대기 사유 검색", key="watch-search").strip().lower()
            st.dataframe(pd.DataFrame([{"종목": o["koreanName"], "코드": o["market"], "구분": strategy_name(o), "현재가": price(o["currentPrice"]),
                                    "24h 거래대금": f"{o['quoteVolume24h'] / 1e8:.1f}억", "대기 사유": o["reason"],
                                    "분석 시각": stamp(o["analyzedAt"])} for o in observations
                                   if not search or search in (o["koreanName"] + o["market"] + o["reason"]).lower()]),
                         hide_index=True, width="stretch")
    with st.expander("분석 범위·운영 상태"):
        st.caption(f"전체 시세 {coverage['krwMarketCount']}개 · 기본 감시 {coverage.get('monitoringMarketCount', 0)}개 · 거래대금 증가 예외 {coverage.get('volumeGrowthMarketCount', 0)}개")
        st.caption("24시간 거래대금 10억 이상 또는 거래대금 증가 종목을 선별합니다. 분석은 서버에서 자동 실행되며 화면은 10초마다 결과를 확인합니다.")
        st.caption("단타는 15분 진입 봉, 스윙은 1시간 진입 봉과 4시간 추세를 사용합니다. 동일 종목의 두 계획은 독립적입니다.")
    if payload.get("paper"):
        with st.expander("추천 성과 모의 추적"):
            st.dataframe(pd.DataFrame(payload["paper"]).rename(columns={"variant": "모델", "total": "전체", "pending": "진입 대기",
                "open": "추적 중", "closed": "종료", "ambiguous": "판정 불가", "meanNetPct": "종료 평균 수익률(%)"}), hide_index=True)
            st.caption("실거래가 아닌 보수적 캔들 기반 모의 결과입니다.")


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
    st.caption("추천 전용 · 자동 주문 없음. 가격 계획은 고정되며 신규 진입 상태는 별도로 확인합니다. 목표 수익률은 도달 가정이지 수익 보장이 아닙니다.")
    st.caption("무료 호스팅의 휴면·재시작·사용량 제한으로 분석이 중단될 수 있습니다. 다시 시작하면 D1의 마지막 상태에서 재개합니다.")


def json_settings(settings):
    import json
    return json.dumps(settings, sort_keys=True)


if __name__ == "__main__":
    main()
