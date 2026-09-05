// 추세 상태의 재시작·인과성과 손절 독립 목표가 및 신규 전략 통합을 검증한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Candle } from '../lib/domain';
import { advanceTrends, trendsReady } from '../lib/trend-state';
import { buildConfluencePlan, confirmedPivots, costedPlan, mergeLevels, previousPeriod, resistanceLevels, type Level } from '../lib/confluence-plan';
import { evaluateScalp, evaluateSwing, type StrategyInput } from '../lib/strategy';

function bars(count: number, unit: 15 | 60 | 240 = 15): Candle[] {
  return Array.from({ length: count }, (_, i) => ({ market: 'KRW-TEST', unit, openTime: i * unit * 60_000,
    closeTime: (i + 1) * unit * 60_000, open: 100, high: 101, low: 99, close: 100,
    baseVolume: 1, quoteVolume: 100, synthetic: false }));
}

test('Target Trend는 ATR200과 SMA200 준비 후 399번째 봉부터 밴드를 만든다', () => {
  assert.equal(advanceTrends(bars(398)).ttUpper, null);
  const ready = advanceTrends(bars(399));
  assert.equal(ready.atr200, 2);
  assert.equal(ready.ttUpper, 102.6);
  assert.equal(ready.ttLower, 97.4);
  assert.equal(ready.signal, null);
});

test('Supertrend는 ATR10×3을 적용하며 이전 밴드 이탈로 방향을 전환한다', () => {
  const initial = advanceTrends(bars(10));
  assert.equal(initial.stLower, 94); assert.equal(initial.stUpper, 106);
  const source = bars(11);
  Object.assign(source[10], { high: 100, low: 80, close: 80 });
  assert.equal(advanceTrends(source).stDirection, -1);
});

function signalBars(): Candle[] {
  const source = bars(430);
  Object.assign(source[400], { high: 100, low: 80, close: 80 });
  Object.assign(source[401], { open: 80, high: 111, low: 80, close: 110 });
  for (let i = 402; i < source.length; i++) Object.assign(source[i], { open: 110, high: 111, low: 109, close: 110 });
  return source;
}

test('TT 목표는 상승 전환 당시 E+5V/10V/15V로 고정되고 증분 계산은 일괄 계산과 같다', () => {
  const source = signalBars();
  const first = advanceTrends(source.slice(0, 402));
  assert.ok(first.signal);
  assert.deepEqual(first.signal.targets, [5, 10, 15].map(k => first.signal!.entry + k * first.signal!.width));
  const saved = JSON.parse(JSON.stringify(first));
  const incremented = advanceTrends(source.slice(390), saved);
  assert.deepEqual(incremented, advanceTrends(source));
  assert.deepEqual(incremented.signal, first.signal);
  assert.deepEqual(saved, first);
  assert.deepEqual(advanceTrends(source, incremented), incremented);
});

test('미완성 봉은 추세 계산에서 제외하며 초기 na→상승을 새 전환 신호로 오인하지 않는다', () => {
  const source = signalBars();
  const cutoff = source[400].closeTime;
  assert.deepEqual(advanceTrends(source, undefined, cutoff), advanceTrends(source.slice(0, 401)));
  const initialUp = bars(401);
  Object.assign(initialUp[400], { high: 111, low: 99, close: 110 });
  const state = advanceTrends(initialUp);
  assert.equal(state.ttDirection, true); assert.equal(state.signal, null);
});

test('오래된 상태와 새 캐시 사이에 공백이 있으면 연결하지 않고 캐시로 재초기화한다', () => {
  const source = signalBars();
  assert.deepEqual(advanceTrends(source.slice(410), advanceTrends(source.slice(0, 400))), advanceTrends(source.slice(410)));
});

const level = (price: number, id = String(price), structural = true): Level => ({ price, id, structural, source: structural ? '확정 고점' : '확장 목표' });
const planArgs = { entryLow: 99.9, entryAnchor: 100, entryHigh: 100.1, rawStop: 98, atr: 1,
  execution: { spreadPct: 0.1, buySlippagePct: 0.02, sufficientDepth: true, tickSize: 0.1, tickSizeReferencePrice: 100 },
  levels: [level(103), level(106), level(110)], market: 'KRW-TEST', strategy: 'scalp' as const,
  signalTime: 1000, expiresAt: 2000, feeRate: 0.0005, entryReason: '돌파 지지', stopReason: '확정 저점' };

test('손절폭 변경은 매수가와 목표가에 영향을 주지 않고 RR 참고값만 바꾼다', () => {
  const a = buildConfluencePlan(planArgs)!;
  const b = buildConfluencePlan({ ...planArgs, rawStop: 90 })!;
  assert.deepEqual(a.targets, b.targets);
  assert.equal(a.entryAnchor, b.entryAnchor);
  assert.notEqual(a.netRewardRiskAtTarget2, b.netRewardRiskAtTarget2);
  assert.equal(b.version, 'confluence-v3');
  assert.ok(b.netRewardRiskAtTarget2 < 1.5);
});

test('목표는 저항 앞 호가이며 근거가 부족하면 R배수로 채우지 않는다', () => {
  const one = buildConfluencePlan({ ...planArgs, levels: [level(103)] })!;
  assert.deepEqual(one.targets, [102.9]);
  assert.equal(one.netSplitReturn, null);
  assert.equal(buildConfluencePlan({ ...planArgs, levels: [] }), null);
  assert.equal(one.targetEvidence![0].kind, 'resistance');
  const projection = buildConfluencePlan({ ...planArgs, levels: [level(103, 'fib', false)] })!;
  assert.equal(projection.targetEvidence![0].kind, 'projection');
});

test('동일 근거를 중복 집계하지 않고 연쇄 군집으로 먼 저항까지 합치지 않는다', () => {
  const zones = mergeLevels([level(103), level(103), level(103.1), level(103.2)], 0.15);
  assert.equal(zones.length, 2);
  assert.equal(zones[0].levels.length, 2);
});

test('첫 저항의 비용 후 여력이 없으면 더 먼 목표만 골라 추천하지 않는다', () => {
  assert.equal(buildConfluencePlan({ ...planArgs, levels: [level(100.2), level(110)] }), null);
  const costly = { ...planArgs, execution: { ...planArgs.execution, buySlippagePct: 2 } };
  assert.equal(buildConfluencePlan(costly), null);
});

test('분할 수익 여력은 1/3씩 청산 및 양방향 비용 가정으로 계산한다', () => {
  const plan = buildConfluencePlan(planArgs)!;
  const result = costedPlan(plan, 0.001, 0.1);
  const expected = result.targets.map(t => (t * 0.998 / 100.2 - 1) * 100);
  expected.forEach((value, i) => assert.ok(Math.abs(value - result.netReturns![i]) < 1e-10));
  assert.ok(Math.abs(result.netSplitReturn! - expected.reduce((a, b) => a + b) / 3) < 1e-10);
});

test('고점·저점은 오른쪽 두 봉이 확정되기 전에는 생성하지 않는다', () => {
  const source = bars(5);
  source[2].high = 110;
  assert.equal(confirmedPivots(source.slice(0, 4)).length, 0);
  const high = confirmedPivots(source).find(p => p.kind === 'high')!;
  assert.equal(high.price, 110); assert.equal(high.confirmedAt, source[4].closeTime);
});

test('전일·전주 피벗은 UTC 기준 완성된 기간만 사용한다', () => {
  const day = bars(12, 240);
  day[5].high = 105;
  const period = previousPeriod(day, 100_000_000, 1)!;
  assert.equal(period.high, 105); assert.equal(period.time, 86_400_000);
  assert.equal(previousPeriod(day.slice(1), 100_000_000, 1), null);
  day[3].synthetic = true;
  assert.equal(previousPeriod(day, 100_000_000, 1), null);
  const week = bars(42, 240).map(c => ({ ...c, openTime: c.openTime + 4 * 86_400_000, closeTime: c.closeTime + 4 * 86_400_000 }));
  assert.ok(previousPeriod(week, 11 * 86_400_000, 7));
});

test('저항 생성은 기준 시점 이후의 고점·전일 데이터에 영향받지 않는다', () => {
  const source = bars(60, 240);
  const now = source[30].closeTime;
  const data = { '15': [], '60': [], '240': source };
  const states = { '15': advanceTrends([]), '60': advanceTrends([]), '240': advanceTrends(source, undefined, now) };
  const initial = resistanceLevels(data, 'swing', now, states);
  source.slice(31).forEach(c => { c.high = 99999; });
  assert.deepEqual(resistanceLevels(data, 'swing', now, states), initial);
});

test('확정 ABC 상승 파동은 C 기준 확장을 생성하고 C 저점 이탈 후에는 폐기한다', () => {
  const knots = [[0, 100], [30, 100], [35, 90], [45, 130], [55, 105], [65, 120], [71, 120]];
  const source = bars(72).map((bar, i) => {
    const next = knots.findIndex(k => k[0] >= i);
    const [rightTime, right] = knots[next];
    const [leftTime, left] = knots[Math.max(0, next - 1)];
    const close = rightTime === leftTime ? right : left + (right - left) * (i - leftTime) / (rightTime - leftTime);
    return { ...bar, open: close, close, high: close + 0.5, low: close - 0.5 };
  });
  const data = { '15': source, '60': [], '240': [] };
  const states = { '15': advanceTrends(source), '60': advanceTrends([]), '240': advanceTrends([]) };
  const fib = resistanceLevels(data, 'scalp', source.at(-1)!.closeTime, states).filter(l => l.id.startsWith('fib:'));
  assert.equal(fib.length, 3);
  assert.deepEqual(fib.map(l => l.price), [1, 1.272, 1.618].map(k => 104.5 + 41 * k));
  source[70].low = 103;
  assert.equal(resistanceLevels(data, 'scalp', source.at(-1)!.closeTime, states).filter(l => l.id.startsWith('fib:')).length, 0);
});

function strategyInput(): StrategyInput {
  const candles = {} as StrategyInput['candles'];
  const end = 1_800_000_000_000;
  for (const unit of [15, 60, 240] as const) {
    let previous = 1280;
    const data = bars(801, unit).map((c, i) => {
      const close = previous + (i % 2 === 0 ? 10 : -8);
      const result = { ...c, openTime: end - (801 - i) * unit * 60_000, closeTime: end - (800 - i) * unit * 60_000,
        open: previous, close, high: Math.max(previous, close) + 1, low: Math.min(previous, close) - 10, quoteVolume: i === 800 ? 200 : 100 };
      previous = close; return result;
    });
    data[797].low = data[795].low - 0.1;
    if (unit === 240) data[793].low -= 12; // 전일 변동폭이 진입 직상단에 붙지 않는 정상 여력 사례.
    candles[String(unit) as keyof typeof candles] = data;
  }
  const trends = { '15': advanceTrends(candles['15']), '60': advanceTrends(candles['60']), '240': advanceTrends(candles['240']) };
  for (const unit of ['15', '60'] as const) {
    trends[unit].ttDirection = true;
    trends[unit].signal = { entry: 2090, stop: 2060, time: end, width: 6, targets: [2120, 2150, 2180] };
  }
  return { candles, trends, market: { market: 'KRW-TEST', koreanName: '테스트', englishName: 'Test', warned: false },
    ticker: { market: 'KRW-TEST', tradePrice: 2090, signedChangeRate: 0.035, quoteVolume24h: 30_000_000_000, timestamp: end },
    execution: { spreadPct: 0.04, buySlippagePct: 0.03, sufficientDepth: true, tickSize: 1, tickSizeReferencePrice: 2090 },
    marketRegime: 'BULLISH', btcChangeRate: 0.01, feeRate: 0.0005 };
}

for (const [name, evaluate] of [['단타', evaluateScalp], ['스윙', evaluateSwing]] as const) {
  test(`${name} 신규 전략은 구조 목표를 사용하고 스프레드를 주의로만 표시한다`, () => {
    const input = strategyInput();
    const normal = evaluate(input);
    assert.equal(normal.accepted, true, normal.accepted ? undefined : normal.code);
    const wide = evaluate({ ...input, execution: { ...input.execution, spreadPct: 2 } });
    assert.equal(wide.accepted, true, wide.accepted ? undefined : wide.code);
    if (!normal.accepted || !wide.accepted) return;
    assert.equal(normal.candidate.plan.version, 'confluence-v3');
    assert.deepEqual(wide.candidate.plan, normal.candidate.plan);
    assert.equal(wide.candidate.score, normal.candidate.score);
    assert.ok(wide.candidate.warnings.some(w => w.includes('스프레드')));
    assert.ok(normal.candidate.plan.targetEvidence!.length > 0);
    assert.ok(normal.candidate.charts['15'].some(c => c.supertrend !== null));
  });
}

test('신규 전략은 상위 Supertrend 하락·준비 부족·합성 봉만으로 채운 이력을 구분한다', () => {
  const input = strategyInput();
  input.trends!['60'].stDirection = -1;
  assert.deepEqual(evaluateScalp(input), { accepted: false, category: 'technicalConditions', code: 'TREND_MISMATCH' });
  input.trends!['240'].ttUpper = null;
  assert.deepEqual(evaluateSwing(input), { accepted: false, category: 'insufficientData', code: 'ENGINE_WARMUP' });
  const synthetic = strategyInput();
  synthetic.candles['240'].slice(0, 450).forEach(c => { c.synthetic = true; });
  assert.equal(trendsReady(synthetic.candles, synthetic.trends!), false);
});
