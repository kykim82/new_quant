# ST Buy 추적과 타겟 트렌드 가격이 완성된 추천을 구분해 표시한다.
import atexit
import hashlib
import json
import math
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import streamlit as st
from quant_worker import AnalysisWorker, SECRET_KEYS, R2_SECRET_KEYS

KST = timezone(timedelta(hours=9))
FRAME_LABELS = {15: '단타·15분', 60: '스윙·1시간', 240: '4시간', 1440: '일봉'}


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


def plan_status(plan, now_ms=None):
    if plan.get('stoppedAt'):
        return '손절 종료'
    if plan.get('completedAt'):
        return '3차 도달'
    now_ms = datetime.now(timezone.utc).timestamp() * 1000 if now_ms is None else now_ms
    tracking = plan.get('entryTracking') or {}
    signal_time = plan.get('signalTime')
    code = 'N' if signal_time and signal_time // 86_400_000 == now_ms // 86_400_000 else 'O'
    if tracking.get('enteredAt'):
        code += '·E'
    hits = plan.get('hits') or []
    if any(hits):
        return f"{code} · {max(i + 1 for i, hit in enumerate(hits) if hit)}차 도달"
    return code


def recommendation_table(rows, now_ms=None):
    result = []
    for row in rows:
        p = row['plan']
        result.append({'종목': symbol(row), '현재가': quote_label(row), '상태': plan_status(p, now_ms),
                       'TT 생성(KST)': datetime.fromtimestamp(p['signalTime'] / 1000, KST).strftime('%m.%d %H:%M') if p.get('signalTime') else '기록 없음',
                       '매수가': price(p['entry']), '손절가': relative_price(p['stop'], p['entry']),
                       **{f'{i + 1}차 매도가': relative_price(t, p['entry']) for i, t in enumerate(p['targets'])},
                       '24시간 거래대금': turnover((row.get('quote') or {}).get('quoteVolume24h')),
                       '3일 평균 거래대금': turnover(row.get('turnover', {}).get('average3d'))})
    return pd.DataFrame(result)


def credentials():
    if os.environ.get('QUANT_LOCAL_DB'):
        return {'QUANT_LOCAL_DB': os.environ['QUANT_LOCAL_DB']}
    values = {}
    for key in SECRET_KEYS + R2_SECRET_KEYS:
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


def beta_table(rows):
    result = []
    for row in rows:
        q = row.get('quote') or {}
        value = q.get('tradePrice')
        entry = row['entryPrice']
        result.append({'순위': row['rank'], '종목': symbol(row), '공통점 일치': row.get('commonHits', 0),
                       '선정가': entry, '현재가': value, '시세 시각': stamp(q.get('timestamp'), True) if value else '확인 중',
                       '선정 후(%)': (value / entry - 1) * 100 if value else None,
                       '관측 최고(%)': (row['windows']['72']['high'] / entry - 1) * 100,
                       '최근 1시간 흐름': row.get('flowLabel', '확인 중'), '일치 근거': row['reason']})
    return pd.DataFrame(result)


def draw_beta(payload):
    st.subheader('3. 급등 코인 · 베타')
    st.caption('누적 급등 사례의 전일 공통점과 비교해 하루 최대 10개를 선정합니다. 일치 개수는 상승 확률이 아닙니다.')
    beta = payload.get('surgeBeta') or {}
    if beta.get('rule') and beta['rule'] != 'surge-common-v1':
        st.info('누적 공통점 기준으로 전환 중입니다. 이전 시험 기록은 보존합니다.')
        return
    research = beta.get('research') or {}
    criterion = beta.get('criterion') or research
    if criterion.get('through'):
        st.caption(f"적용 사례 일봉 {criterion['through']}까지 · 누적 {criterion.get('cases', 0)}건 · 일봉 비교 가능 {criterion.get('dailyReady', 0)}건 · 기준 생성 {stamp(criterion.get('createdAt'))}")
    if research.get('stage'):
        st.info(research['stage'] + '. 완료 후 이전 기준 검증과 새 공통점 갱신을 순서대로 수행합니다.')
    if research.get('error'):
        st.warning('급등 연구 갱신 재시도 대기. ' + research['error'])
    if research and not research.get('current'):
        st.info('최신 완료 일자 연구가 아직 끝나지 않았습니다. 새 일자 후보 확정은 대기하며 기존 기록은 보존합니다.')
    if beta.get('error'):
        st.warning(beta['error'])
    if beta.get('selectedAt'):
        st.caption(f"선정 {stamp(beta['selectedAt'])} · 최근 DB 저장 {stamp(beta.get('savedAt'))}")
        if beta.get('progressed'):
            st.caption(f"선정 후 상승한 {beta['progressed']}종목은 후보 표에서 빼고 아래 관찰 기록에서 계속 추적합니다.")
        if beta.get('stale'):
            st.caption('분석 연결 확인 중입니다. 선정 당시 기록은 유지하며 최신 시세가 없는 칸은 비워 둡니다.')
        rows = beta.get('rows') or []
        if rows:
            frame = beta_table(rows)
            st.dataframe(frame.style.format({'선정가': price, '현재가': price,
                '공통점 일치': lambda n: f"{int(n)}/{rows[0].get('commonTotal', 0)}",
                '선정 후(%)': '{:+.2f}', '관측 최고(%)': '{:+.2f}'}, na_rep='—'),
                hide_index=True, width='stretch', key='surge_beta_candidates')
        else:
            st.info('현재 남아 있는 상승 전 후보가 없습니다. 오늘 선정·상승한 종목은 아래 관찰 기록에서 확인할 수 있습니다.')
    else:
        st.info(f"베타 일봉 확인 {beta.get('scanned', 0)}/{beta.get('total', 0)}종목. 기존 추천 분석 후 나누어 수집하며, 전체 확인이 끝나면 후보를 확정합니다.")
    with st.expander('베타 관찰 기록·시험 기준'):
        st.write('매일 한국시간 09시 이후 완료 일봉의 시가 대비 장중 고가 +30% 이상 사례를 서버에서 수집합니다. 이전 기준을 먼저 검증한 뒤 새 사례를 합쳐 공통점을 갱신합니다. 이력 부족 사례도 저장하고 통계에서는 미확인으로 구분합니다.')
        st.write('확인 가능한 사례 5건 이상에서 70% 이상 반복된 특징을 잠정 공통점으로 삼습니다. 일치 개수가 많은 순이며, 동점은 확인 항목 수 → 최근 완료 1시간 가격·거래량 동반 상승 → 최근 3일 상대 거래량 → 24시간 거래대금 순입니다. 미확인 항목은 일치로 세지 않습니다.')
        st.caption('1시간 흐름은 양봉·직전 종가 상승·직전 20시간 평균보다 거래량 증가 여부입니다. 매수 체결 비율이나 순매수 금액을 측정한 값은 아닙니다.')
        common = criterion.get('features') or research.get('common') or []
        if common:
            st.dataframe(pd.DataFrame([{'공통점': f['label'], '사례 재현': f"{f['hits']}/{f['total']}", '미확인': f['missing']} for f in common]), hide_index=True, width='stretch')
        assessment = research.get('assessment')
        if assessment:
            st.caption(f"기존 기준 {assessment['baselineThrough']} 검증 · 새 급등 사례 {assessment['newCases']}건. 재현 빈도는 급등 확률·매수 승률이 아닙니다.")
            if not assessment.get('beforeNewDays'):
                st.caption('기준 생성이 새 사례 일봉 시작 이후여서 엄격한 하루 전체 사전 검증과 구분합니다.')
        st.write('최근 20개 일봉·당일에 시가 또는 선행 저가 대비 고가 +30% 이상 오른 종목은 반락해도 제외합니다. 현재가의 20일선 +12%·5일 전 종가 +20% 초과도 제외합니다. 기존 추천·유망 조건에는 적용하지 않습니다.')
        st.caption('사례는 급등일 이전, 후보는 선정일 이전 완료 일봉만 비교합니다. 매일 확정한 기준과 후보는 고정하며 과거 성과를 새 기준으로 덮어쓰지 않습니다. 재급등 사례도 포함한 전체 공통점이므로 미상승 후보의 예측 성능은 별도 검증이 필요합니다.')
        st.caption('관측 최고는 선정 이후 받은 시세와 선정 이후 시작된 완료 1시간봉 기준입니다. 초기 부분 시간·중단 구간의 최고가는 놓칠 수 있습니다. 24·72시간 변화는 종료 시각 이후 2분 이내 시세가 있을 때만 기록하며, 수수료 미반영 관찰값입니다.')
        history = []
        for cohort in beta.get('history', []):
            for row in [*cohort['selected'], *cohort.get('controls', [])]:
                a, b = row['windows']['24'], row['windows']['72']
                history.append({'선정일': cohort['day'], '기준': cohort.get('rule', 'surge-preparation-v1'),
                    '구분': '후보' if row['role'] == 'candidate' else '비선정 비교군',
                    '종목': symbol(row), '선정가': row['entryPrice'],
                    '24시간 변화(%)': (a['returnPrice'] / row['entryPrice'] - 1) * 100 if a.get('returnPrice') else None,
                    '72시간 변화(%)': (b['returnPrice'] / row['entryPrice'] - 1) * 100 if b.get('returnPrice') else None,
                    '72시간 관측 최고(%)': (b['high'] / row['entryPrice'] - 1) * 100,
                    '+30% 관측': '있음' if b.get('hit30At') else '관측 없음',
                    '상태': '72시간 경과' if b.get('closed') else '상승 후 추적' if row.get('preparationEndedAt') or b.get('hit30At') else '관찰 중'})
        if history:
            st.dataframe(pd.DataFrame(history).style.format({'선정가': price,
                '24시간 변화(%)': '{:+.2f}', '72시간 변화(%)': '{:+.2f}', '72시간 관측 최고(%)': '{:+.2f}'}, na_rep='—'),
                hide_index=True, width='stretch', key='surge_beta_history')
        st.caption('최근 7일 기록을 표시합니다. 이전 기록은 별도 DB 표에 보존합니다. 비교군도 선정 당시에 고정하며 아직 오르지 않았다고 미리 분류한 종목이 아닙니다.')


def render(worker):
    view = worker.snapshot()
    payload = view.get('payload')
    st.title('KRW 퀀트 레이더')
    storage = view.get('storage') or {}
    backup = storage.get('r2') or {}
    if backup.get('enabled'):
        st.caption(f"15분 정기 백업 · 중요 기록 별도 백업 · 마지막 R2 저장 {stamp(backup.get('lastBackupAt'))}")
        if backup.get('error'):
            st.warning(backup['error'])
        if not backup.get('ready'):
            st.warning('R2 백업 연결·복원 확인 중입니다. 아직 영구 백업 완료 상태가 아닙니다.')
    elif storage:
        st.warning('R2 미연결. D1 전송 실패 시 서버 내부 임시 저장만 가능하며 서버 교체 시 미전송 자료를 잃을 수 있습니다.')
    if storage:
        with st.expander('저장·백업 사용량'):
            report = {'확인 시각': datetime.now(KST).isoformat(), 'D1': {'오늘 전송 예산 사용': storage.get('used'), '예산': storage.get('budget'), '대기 행': storage.get('pending'), '최근 집계': storage.get('d1Usage', {})}, 'R2': backup}
            st.caption('이 서버가 기록한 집계입니다. 계정 전체 요금 통계는 Cloudflare에서 최종 확인해야 합니다. R2 저장 완료 전의 자료는 로컬에만 있을 수 있습니다.')
            st.json(report)
            st.download_button('사용량 기록 내려받기', json.dumps(report, ensure_ascii=False, indent=2), file_name='storage-usage.json', mime='application/json', key='storage_usage_download')
    if storage.get('mode') == 'local':
        st.warning(f"D1 전송 대기 · 로컬 DB 저장 사용 중 · 전송 대기 {storage.get('pending', 0)}행. 분석 중단 여부와는 별개입니다.")
        st.caption('서버 임시 저장 후 R2로 백업합니다. R2 저장 성공 전의 자료는 서버 교체 시 유실될 수 있습니다.' if backup.get('enabled') else '서버의 db-buffer 폴더에 저장합니다. 서버 재생성·재배포 시 미전송 자료가 사라질 수 있습니다.')
        if storage.get('retryAt'):
            st.caption(f"다음 D1 전송 재시도 {stamp(storage['retryAt'])}")
        if storage.get('reason'):
            st.caption(storage['reason'])
    elif storage.get('mode') == 'syncing':
        st.caption(f"로컬 저장 완료 · D1에 전송 중 · {storage.get('pending', 0)}행 대기")
    if storage and not storage.get('historyRestored'):
        st.warning('D1 기존 기록 복원이 아직 끝나지 않았습니다. 로컬에 없는 과거 추천 이력은 복구 대기 중입니다.')
    if not payload or payload.get('version') != 7:
        st.info('새 분석 구조의 거래대금 분류와 ST·TT 검사를 시작하고 있습니다.')
        if view.get('error'):
            st.error(view['error'])
        return
    recovering = view.get('recovering') or payload.get('stale')
    status = '분석 중단·복구 대기' if recovering else '수집·분석 중' if payload.get('processing') else '최근 분석 결과'
    st.caption(f"{status} · 마지막 분석 {stamp(payload.get('analysisAt'))}")
    if not payload.get('exclusions', {}).get('ready'):
        st.warning('공식 제외 정보 확인 중입니다. 확인된 이후 신규 추천을 표시합니다.')
    if payload.get('viewedAt', payload['generatedAt']) - payload.get('lastQuoteAt', 0) > 45_000:
        st.warning('시세 조회가 지연되어 신규 추천 표시를 보류합니다. 연결 복구 후 다시 확인합니다.')
    if payload.get('stale'):
        st.warning('분석 진행이 멈췄거나 연결이 지연되고 있습니다. 시세 갱신과 별도로 자동 복구하며 저장된 기록은 유지합니다.')
    if view.get('error'):
        st.warning(view['error'])
    if recovering:
        st.caption(f"마지막 진행 단계 · {view.get('stage') or payload.get('pipeline', {}).get('stage') or '확인 중'}")
    with st.expander('분석 기준·전체 종목 현황'):
        if view.get('last_restart'):
            restart = view['last_restart']
            st.caption(f"최근 자동 복구 {stamp(restart['at'])} · {restart['reason']}")
        st.write('테더·유의·거래지원 종료 예정 종목을 제외합니다. 최근 완료 72시간 거래대금 합계 ÷ 3이 10억 원 이상인 종목을 분석합니다.')
        st.write('단타는 15분, 스윙은 1시간 ST Buy를 추적합니다. 활성 상승 Target Trend의 매수·손절·세 목표가가 있을 때만 추천합니다. 다른 지표는 순위에만 사용합니다.')
        st.write('4시간·일봉은 단타·스윙 조건을 통과한 전체 종목의 활성 상승 TT 가격을 독립 검사·정렬합니다. 상위봉 ST는 점수에만 반영합니다. 단타·스윙 표의 상위 10개에 들지 못해도 대상이며, 하위 계획이 종료돼도 상위 추적을 유지합니다.')
        st.write('N/O는 TT 생성일, E는 추천 판정 이후 확인된 매수가 접촉입니다. 목표 선도달 뒤 재접촉이나 순서를 알 수 없는 봉은 E로 확정하지 않습니다. 이전 기록의 진입은 추정하지 않습니다.')
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
    st.caption('O: 오늘 이전에 생성된 가격 · N: 오늘 생성된 가격 · E: 진입중. 오늘 기준은 한국시간 오전 9시입니다.')
    tabs = st.tabs(list(FRAME_LABELS.values()))
    for tab, unit in zip(tabs, FRAME_LABELS):
        with tab:
            rows = [r for r in payload['rows'] if r['unit'] == unit][:10]
            st.caption(f'{len(rows)}종목 · 최대 10종목')
            upper_pending = 0
            if unit > 60:
                tracked = [d for d in payload['details'] if d.get('upperTracked') and d['group'] == 'high']
                inspected = [d for d in tracked if d.get('frames', {}).get(str(unit), {}).get('historyReady')]
                upper_pending = len(tracked) - len(inspected)
                st.caption(f"상위봉 이력 확인 {len(inspected)}/{len(tracked)}종목 · 수집·검증 중 {upper_pending}종목")
                with st.expander(f'{FRAME_LABELS[unit]} 검사 내역', expanded=False, key=f'upper_checks_{unit}'):
                    st.dataframe(pd.DataFrame([{'종목': d['name'],
                        '판정': d.get('frames', {}).get(str(unit), {}).get('reason', '상위봉 수집 대기'),
                        '확인한 봉 수': d.get('frames', {}).get(str(unit), {}).get('actualBars', 0)} for d in tracked]), hide_index=True, width='stretch')
            if rows:
                st.dataframe(recommendation_table(rows, payload.get('viewedAt', payload['generatedAt'])), hide_index=True, width='stretch')
                rechecking = [r for r in rows if r.get('rechecking')]
                if rechecking:
                    st.caption(f'{len(rechecking)}종목은 직전 완료봉 기준으로 재검사 중입니다.')
                    with st.expander('봉 검사 시각 확인', key=f'recheck_{unit}', expanded=False):
                        st.dataframe(pd.DataFrame([{'종목': symbol(r), '마지막 검사 봉': stamp(r['checkedThrough'])} for r in rechecking]), hide_index=True, width='stretch')
            elif upper_pending:
                st.info(f'{FRAME_LABELS[unit]} 이력을 수집·검증 중입니다. 확인이 끝난 종목부터 표시합니다.')
            else:
                st.info('현재 활성 상승 TT 가격까지 확인된 추천이 없습니다. 아래 신호 대기와 검사 사유를 확인할 수 있습니다.')
    with st.expander("타겟 트렌드 신호 대기 · ST Buy 추적", expanded=False, key="tt_signal_wait", on_change="rerun"):
        st.caption(f"추적 {len(payload['waiting'])}건")
        st.caption('ST Buy이지만 활성 상승 TT 신호가 아직 없어 진입을 권유하지 않는 종목입니다.')
        if payload['waiting']:
            st.dataframe(pd.DataFrame([{'종목': symbol(r), '시간대': FRAME_LABELS[r['unit']],
                                       'ST Buy 전환 시각': stamp(r.get('trend', {}).get('stFlipAt')), '24시간 거래대금': turnover((r.get('quote') or {}).get('quoteVolume24h')),
                                       '상태': r['reason']} for r in payload['waiting']]), hide_index=True, width='stretch')
    with st.expander('과거 추천 추적·신규 추천과 별도'):
        history = []
        for row in payload.get('history', [])[:100]:
            p = row['plan']
            history.append({'종목': symbol(row), '시간대': FRAME_LABELS.get(row['unit'], str(row['unit'])), '상태': plan_status(p),
                            '최초 추천 판정': stamp(row['firstShownAt']), '매수가': price(p['entry']), '손절가': relative_price(p['stop'], p['entry']),
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
    draw_beta(payload)
    draw_detail(worker)


def main():
    st.set_page_config(page_title='KRW 퀀트 레이더', layout='wide')
    config = credentials()
    if not config.get('QUANT_LOCAL_DB') and not all(config.get(k) for k in SECRET_KEYS):
        st.error('DB 연결 설정을 확인해 주세요.')
        return
    root = Path(__file__).parent
    digest = hashlib.sha256()
    for name in ('engine.mjs', 'buffered_storage.mjs', 'r2_client.mjs', 'r2_backup.mjs', 'quant_core.mjs', 'quant_worker.py', 'streamlit_app.py', 'surge_beta.mjs', 'surge_patterns.mjs', 'surge_templates.mjs', 'surge_common.mjs', 'surge_common_rules.mjs', 'surge_study.mjs', 'surge_common_seed.json', 'surge_indicator_baseline.txt'):
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
