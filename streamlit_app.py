# ST Buy 추적과 타겟 트렌드 가격이 완성된 추천을 구분해 표시한다.
import atexit
import hashlib
import math
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import streamlit as st
from quant_worker import AnalysisWorker, SECRET_KEYS

KST = timezone(timedelta(hours=9))


def stamp(value, short=False):
    return datetime.fromtimestamp(value / 1000, KST).strftime('%H:%M' if short else '%m.%d %H:%M:%S KST') if value else '기록 없음'


def price(value):
    return f'{value:,.8f}'.rstrip('0').rstrip('.') + '원' if type(value) in (int, float) and math.isfinite(value) and value > 0 else '—'


def relative_price(value, entry):
    return f'{price(value)} ({(value / entry - 1) * 100:+.2f}%)' if value and entry else '—'


def turnover(value):
    return f'{value / 100_000_000:,.1f}억원' if type(value) in (int, float) and math.isfinite(value) else '수집 중'


def symbol(row):
    return f"{row.get('name') or row['market']} ({row['market'].removeprefix('KRW-')})"


def quote_label(row):
    q = row.get('quote') or {}
    return f"{price(q.get('tradePrice'))} ({stamp(q.get('timestamp'), True)})"


def plan_status(plan):
    if plan.get('stoppedAt'):
        return '손절 종료'
    if plan.get('completedAt'):
        return '3차 도달'
    hits = plan.get('hits') or []
    if any(hits):
        return f'{max(i + 1 for i, hit in enumerate(hits) if hit)}차 도달'
    return '미진입'


def recommendation_table(rows):
    result = []
    for row in rows:
        p = row['plan']
        result.append({'종목': symbol(row), '현재가': quote_label(row), '상태': plan_status(p),
                       '매수가': price(p['entry']), '손절가': relative_price(p['stop'], p['entry']),
                       **{f'{i + 1}차 매도가': relative_price(t, p['entry']) for i, t in enumerate(p['targets'])},
                       '24시간 거래대금': turnover((row.get('quote') or {}).get('quoteVolume24h')),
                       '3일 평균 거래대금': turnover(row.get('turnover', {}).get('average3d'))})
    return pd.DataFrame(result)


def credentials():
    if os.environ.get('QUANT_LOCAL_DB'):
        return {'QUANT_LOCAL_DB': os.environ['QUANT_LOCAL_DB']}
    values = {}
    for key in SECRET_KEYS:
        try:
            values[key] = str(st.secrets.get(key, os.environ.get(key, '')))
        except (FileNotFoundError, st.errors.StreamlitSecretNotFoundError):
            values[key] = os.environ.get(key, '')
    return values


@st.cache_resource(max_entries=1, on_release=lambda worker: worker.stop())
def get_worker(revision, _credentials):
    worker = AnalysisWorker(_credentials)
    atexit.register(worker.stop)
    worker.start()
    return worker


def draw_detail_slot(worker, slot):
    state_key = 'detail_market' if slot == 1 else 'detail_market_2'
    with st.form(f'detail_form_{slot}'):
        code = st.text_input(f'종목 코드 {slot}', placeholder='예. BTC, ARX', key=f'detail_code_{slot}')
        submitted = st.form_submit_button('분석')
    if submitted:
        market = code.strip().upper()
        if not market.startswith('KRW-'):
            market = 'KRW-' + market
        if not re.fullmatch(r'KRW-[A-Z0-9]{1,20}', market):
            st.error('종목 코드를 확인해 주세요.')
        else:
            try:
                worker.request_detail(market)
                st.session_state[state_key] = market
            except ValueError as error:
                st.error(str(error))
    market = st.session_state.get(state_key)
    if not market:
        return
    state = worker.detail_snapshot(market)
    if state.get('running'):
        st.info('해당 종목의 15분·1시간·4시간·일봉 자료를 수집하고 있습니다.')
    if state.get('error'):
        st.error(state['error'])
    detail = state.get('payload')
    if not detail:
        return
    st.write(f"{symbol(detail)} · 현재가 {quote_label(detail)}")
    rows = []
    for unit, frame in detail['frames'].items():
        p = frame.get('plan')
        row = {'시간대': {'15': '15분', '60': '1시간', '240': '4시간', '1440': '일봉'}[unit],
               '매수가': price(p['entry']) if p else '—',
               '손절가': relative_price(p['stop'], p['entry']) if p else '—'}
        row.update({f'{i + 1}차 매도가': relative_price(p['targets'][i], p['entry']) if p else '—' for i in range(3)})
        rows.append(row)
    st.dataframe(pd.DataFrame(rows), hide_index=True, width='stretch')


def draw_detail(worker):
    st.subheader('4. 종목 상세 분석')
    for slot, column in enumerate(st.columns(2, border=True), start=1):
        with column:
            draw_detail_slot(worker, slot)


def toggle_promising():
    st.session_state['promising_open'] = not st.session_state.get('promising_open', True)


def render(worker):
    view = worker.snapshot()
    payload = view.get('payload')
    st.title('KRW 퀀트 레이더')
    if not payload or payload.get('version') != 7:
        st.info('새 분석 구조의 거래대금 분류와 ST·TT 검사를 시작하고 있습니다.')
        if view.get('error'):
            st.error(view['error'])
        return
    st.caption(f"{'수집·분석 중' if payload.get('processing') else '최근 분석 결과'} · 마지막 분석 {stamp(payload.get('analysisAt'))}")
    if not payload.get('exclusions', {}).get('ready'):
        st.warning('공식 제외 정보 확인 중입니다. 확인된 이후 신규 추천을 표시합니다.')
    if payload.get('viewedAt', payload['generatedAt']) - payload.get('lastQuoteAt', 0) > 45_000:
        st.warning('시세 조회가 지연되어 신규 추천 표시를 보류합니다. 연결 복구 후 다시 확인합니다.')
    if payload.get('stale'):
        st.warning('새 분석기 응답을 기다리고 있습니다. 저장된 기록은 유지합니다.')
    if view.get('error'):
        st.warning(view['error'])
    with st.expander('분석 기준·전체 종목 현황'):
        st.write('테더·유의·거래지원 종료 예정 종목을 제외합니다. 최근 완료 72시간 거래대금 합계 ÷ 3이 10억 원 이상인 종목을 분석합니다.')
        st.write('단타는 15분, 스윙은 1시간 ST Buy를 추적합니다. 활성 상승 Target Trend의 매수·손절·세 목표가가 있을 때만 추천합니다. 다른 지표는 순위에만 사용합니다.')
        st.write('현재가 괄호는 업비트 시세의 기준 시각(KST)입니다. 조회 성공 시각과 구분하며 새 봉 확인 중에는 직전 완료봉 1개 이내의 완성된 계획을 표시합니다.')
        st.write('초기 TT는 상장 전체 이력 또는 서로 다른 시작점의 계산 일치를 확인합니다. 최소 2,000봉부터 검증하며, 일치하지 않으면 과거 이력을 더 수집합니다. 짧은 상장 이력은 전체 자료로 확인합니다.')
        st.write('목표는 원본 신호의 고정 값입니다. 신호가 오래돼도 유지하며 손절·3차 목표 도달 후에는 새 TT 신호를 기다립니다. 호가 단위에 맞춰 가격을 표시합니다.')
        c = payload['coverage']
        st.write(f"전체 원화 {payload['total']}종목 · 제외 {len(payload['excluded'])}종목 · 대상 {c['total']}종목 · 10억 이상 {c['high']} · 미만 {c['low']} · 분류 중 {c['pending']}")
        st.caption(f"최근 시세 조회 성공 {stamp(payload.get('lastQuoteAt'))}")
        if payload['excluded']:
            st.dataframe(pd.DataFrame(payload['excluded']), hide_index=True, width='stretch')
        if payload.get('errors'):
            st.dataframe(pd.DataFrame(payload['errors']), hide_index=True, width='stretch')
    for unit, label in ((15, '15분'), (60, '1시간')):
        details = [d for d in payload['details'] if d['group'] == 'high']
        frames = [d['frames'][str(unit)] for d in details]
        buy = sum(f.get('st') == 'Buy' for f in frames)
        sell = sum(f.get('st') == 'Sell' for f in frames)
        st.caption(f"{label} ST · 거래대금 기준 대상 {len(details)} · Buy {buy} · Sell {sell} · 수집·계산 대기 {len(details) - buy - sell}")
        with st.expander(f'{label} 전체 종목 검사 내역·대기 사유'):
            st.dataframe(pd.DataFrame([{'종목': d['name'], 'ST': d['frames'][str(unit)].get('st') or '확인 중',
                                       '판정': d['frames'][str(unit)]['reason'], '확인 완료': stamp(d['frames'][str(unit)]['checkedThrough']),
                                       '오류': d.get('error') or ''} for d in details]), hide_index=True, width='stretch')
    st.subheader('1. 추천 종목')
    st.caption('ST Buy와 활성 상승 TT 가격을 확인한 종목을 순위로 표시합니다. 실제 계좌 체결을 확인하는 서비스는 아닙니다.')
    tabs = st.tabs(['단타·15분', '스윙·1시간'])
    for tab, unit in zip(tabs, (15, 60)):
        with tab:
            rows = [r for r in payload['rows'] if r['unit'] == unit][:10]
            st.caption(f'{len(rows)}종목 · 최대 10종목')
            if rows:
                st.dataframe(recommendation_table(rows), hide_index=True, width='stretch')
                for row in rows:
                    if row.get('rechecking'):
                        st.caption(f"{symbol(row)} · 직전 봉 기준 · 재검사 중. 확인 완료 {stamp(row['checkedThrough'])}.")
            else:
                st.info('현재 활성 상승 TT 가격까지 확인된 추천이 없습니다. 아래 신호 대기와 검사 사유를 확인할 수 있습니다.')
    with st.expander("타겟 트렌드 신호 대기 · ST Buy 추적", expanded=False, key="tt_signal_wait", on_change="rerun"):
        st.caption(f"추적 {len(payload['waiting'])}건")
        st.caption('ST Buy이지만 활성 상승 TT 신호가 아직 없어 진입을 권유하지 않는 종목입니다.')
        if payload['waiting']:
            st.dataframe(pd.DataFrame([{'종목': symbol(r), '시간대': '단타·15분' if r['unit'] == 15 else '스윙·1시간',
                                       'ST Buy 전환 시각': stamp(r.get('trend', {}).get('stFlipAt')), '24시간 거래대금': turnover((r.get('quote') or {}).get('quoteVolume24h')),
                                       '상태': r['reason']} for r in payload['waiting']]), hide_index=True, width='stretch')
    with st.expander('과거 추천 추적·신규 추천과 별도'):
        history = []
        for row in payload.get('history', [])[:100]:
            p = row['plan']
            history.append({'종목': symbol(row), '시간대': '15분' if row['unit'] == 15 else '1시간', '상태': plan_status(p),
                            '최초 표시': stamp(row['firstShownAt']), '매수가': price(p['entry']), '손절가': relative_price(p['stop'], p['entry']),
                            **{f'{i + 1}차 매도가': relative_price(t, p['entry']) for i, t in enumerate(p['targets'])}})
        st.dataframe(pd.DataFrame(history), hide_index=True, width='stretch')
        st.caption('이 표는 새 구조에서 표시된 계획의 관찰 기록입니다. 이전 구조의 DB 원장은 삭제하지 않고 보존합니다.')
    st.session_state.setdefault('promising_open', True)
    with st.container(horizontal=True, vertical_alignment='center', gap='small'):
        st.subheader('2. 유망 종목', width='content')
        st.button('', icon=':material/expand_less:' if st.session_state['promising_open'] else ':material/expand_more:',
                  help='유망 종목 접기' if st.session_state['promising_open'] else '유망 종목 펼치기',
                  key='promising_toggle', on_click=toggle_promising)
    if st.session_state['promising_open']:
        st.caption('3일 평균 거래대금 10억 미만 중 거래대금이 늘고 1시간 이평선과 가격이 회복하는 종목을 관찰합니다.')
        if payload['promising']:
            st.dataframe(pd.DataFrame([{'종목': symbol(r), '현재가': quote_label(r), '24시간 거래대금': turnover((r.get('quote') or {}).get('quoteVolume24h')), '선정 이유': r['reason']} for r in payload['promising'][:20]]), hide_index=True, width='stretch')
        else:
            st.info('현재 유망 조건을 충족한 종목이 없거나 거래대금을 분류 중입니다.')
    st.subheader('3. 급등 코인')
    st.caption('별도 급등 예측 규칙은 아직 설정하지 않았습니다.')
    draw_detail(worker)


def main():
    st.set_page_config(page_title='KRW 퀀트 레이더', layout='wide')
    config = credentials()
    if not config.get('QUANT_LOCAL_DB') and not all(config.get(k) for k in SECRET_KEYS):
        st.error('DB 연결 설정을 확인해 주세요.')
        return
    root = Path(__file__).parent
    digest = hashlib.sha256()
    for name in ('engine.mjs', 'quant_core.mjs', 'quant_worker.py', 'streamlit_app.py'):
        digest.update((root / name).read_bytes())
    for k, v in sorted(config.items()):
        digest.update(f'{k}={v}'.encode())
    worker = get_worker(digest.hexdigest(), config)
    @st.fragment(run_every=5)
    def dashboard():
        render(worker)
    dashboard()


if __name__ == '__main__':
    main()
