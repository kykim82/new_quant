// 단타·스윙 전략의 필터, 가격 계획, 시장 국면과 순위를 검증한다
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Candle, Candidate, Strategy } from '../lib/domain';
import { evaluateScalp as evaluateLegacyScalp } from '../lib/legacy-strategy';
import {
  deriveBtcRegime,
  evaluateScalp,
  evaluateSwing,
  rankCandidates,
  type StrategyInput,
} from '../lib/pre-confluence-strategy';

function trendCandles(count: number, unit: 15 | 60 | 240, start = 2_000): Candle[] {
  const width = unit * 60_000;
  let previous = start;
  const candles = Array.from({ length: count }, (_, index) => {
    const change = index % 2 === 0 ? 10 : -8;
    const close = previous + change;
    const result: Candle = {
      market: 'KRW-TEST',
      unit,
      openTime: index * width,
      closeTime: (index + 1) * width,
      open: previous,
      high: Math.max(previous, close) + 1,
      low: Math.min(previous, close) - 10,
      close,
      baseVolume: 100,
      quoteVolume: index === count - 1 ? 200 : 100,
      synthetic: false,
    };
    previous = close;
    return result;
  });
  if (count === 81) candles[77].low = candles[75].low - 0.1;
  return candles;
}

function input(): StrategyInput {
  return {
    market: { market: 'KRW-TEST', koreanName: '테스트', englishName: 'Test', warned: false },
    ticker: {
      market: 'KRW-TEST',
      tradePrice: 2_090,
      signedChangeRate: 0.035,
      quoteVolume24h: 30_000_000_000,
      timestamp: Date.now(),
    },
    candles: {
      '15': trendCandles(81, 15),
      '60': trendCandles(81, 60),
      '240': trendCandles(220, 240),
    },
    execution: { spreadPct: 0.04, buySlippagePct: 0.03, sufficientDepth: true, tickSize: 1, tickSizeReferencePrice: 2_090 },
    marketRegime: 'BULLISH',
    btcChangeRate: 0.01,
    feeRate: 0.0005,
  };
}

test('단타 전략은 위험회피 시장에서 즉시 거절한다', () => {
  const evaluation = evaluateScalp({ ...input(), marketRegime: 'RISK_OFF' });
  assert.deepEqual(evaluation, { accepted: false, category: 'technicalConditions', code: 'BTC_RISK_OFF' });
});

test('스윙 전략은 충분하지 않은 호가 물량을 여전히 거절한다', () => {
  const evaluation = evaluateSwing({
    ...input(),
    execution: { spreadPct: 0.4, buySlippagePct: 0.03, sufficientDepth: false, tickSize: 1, tickSizeReferencePrice: 2_090 },
  });
  assert.deepEqual(evaluation, { accepted: false, category: 'executionQuality', code: 'POOR_EXECUTION' });
});

for (const [strategy, evaluate] of [['scalp', evaluateScalp], ['swing', evaluateSwing]] as const) {
  test(`${strategy} 스프레드는 합격·점수·가격에 영향 없이 주의만 표시한다`, () => {
    const source = input();
    const normal = evaluate(source);
    const wide = evaluate({ ...source, execution: { ...source.execution, spreadPct: 2 } });
    assert.equal(normal.accepted, true);
    assert.equal(wide.accepted, true);
    if (!normal.accepted || !wide.accepted) return;
    assert.equal(wide.candidate.score, normal.candidate.score);
    assert.deepEqual(wide.candidate.plan, normal.candidate.plan);
    assert.ok(!normal.candidate.warnings.some(warning => warning.startsWith('호가 스프레드 ')));
    assert.ok(wide.candidate.warnings.some(warning => warning.includes('2.000%')));
    assert.equal(wide.candidate.metrics.spreadPct, 2);
  });

  test(`${strategy} 스프레드가 작아도 과도한 슬리피지는 거절한다`, () => {
    const source = input();
    assert.deepEqual(evaluate({ ...source, execution: { ...source.execution, buySlippagePct: 1 } }),
      { accepted: false, category: 'executionQuality', code: 'POOR_EXECUTION' });
  });
}

test('합성 결측 봉이 최근 구간에 있으면 추천하지 않는다', () => {
  const source = input();
  source.candles['15'].at(-3)!.synthetic = true;
  const evaluation = evaluateScalp(source);
  assert.deepEqual(evaluation, { accepted: false, category: 'insufficientData', code: 'MISSING_RECENT_CANDLES' });
});

test('완성 봉 이후 현재가가 진입 허용 범위를 벗어나면 추격 추천하지 않는다', () => {
  const source = input();
  source.ticker.tradePrice = 2_200;
  const evaluation = evaluateScalp(source);
  assert.deepEqual(evaluation, { accepted: false, category: 'technicalConditions', code: 'CURRENT_PRICE_OUTSIDE_ENTRY' });
});

test('상승 데이터의 단타 신호는 손절과 세 목표가의 순서를 보장한다', () => {
  const evaluation = evaluateScalp(input());
  assert.equal(evaluation.accepted, true, evaluation.accepted ? undefined : evaluation.code);
  if (!evaluation.accepted) return;
  const { plan } = evaluation.candidate;
  assert.ok(plan.stop < plan.entryLow);
  assert.ok(plan.entryLow <= plan.entryAnchor && plan.entryAnchor <= plan.entryHigh);
  assert.ok(plan.entryHigh < plan.targets[0]);
  assert.ok(plan.targets[0] < plan.targets[1] && plan.targets[1] < plan.targets[2]);
  assert.ok(plan.riskPct <= 2);
  assert.ok(plan.netRewardRiskAtTarget2 >= 1.5);
});

test('상승 데이터의 스윙 신호는 4시간 추세와 1시간 돌파를 결합한다', () => {
  const evaluation = evaluateSwing(input());
  assert.equal(evaluation.accepted, true, evaluation.accepted ? undefined : evaluation.code);
  if (!evaluation.accepted) return;
  assert.equal(evaluation.candidate.strategy, 'swing');
  assert.equal(evaluation.candidate.setup, 'breakout');
  assert.ok(evaluation.candidate.metrics.adx! >= 20);
  assert.ok(evaluation.candidate.plan.riskPct <= 6);
});

test('BTC 시장 국면은 정배열 상승과 역배열 하락을 구분한다', () => {
  const bullish = deriveBtcRegime(trendCandles(100, 60), trendCandles(240, 240));
  const descending = (count: number, unit: 60 | 240) => trendCandles(count, unit)
    .map((item, index) => ({
      ...item,
      open: 500 - index,
      high: 500.5 - index,
      low: 498.5 - index,
      close: 499 - index,
      openTime: index * unit * 60_000,
      closeTime: (index + 1) * unit * 60_000,
    }));
  assert.equal(bullish, 'BULLISH');
  assert.equal(deriveBtcRegime(descending(100, 60), descending(240, 240)), 'RISK_OFF');
});

function rankedCandidate(market: string, strategy: Strategy, score: number, quoteVolume24h: number): Candidate {
  const base = input();
  const accepted = evaluateScalp(base);
  if (!accepted.accepted) throw new Error(`테스트 후보 생성 실패: ${accepted.code}`);
  return { ...accepted.candidate, market, strategy, score, quoteVolume24h };
}

test('거래대금 1.3배 돌파는 개선 전략에서 평가하고 기존 전략은 거절한다', () => {
  const source = input();
  source.candles['15'].at(-1)!.quoteVolume = 130;
  assert.equal(evaluateLegacyScalp(source).accepted, false);
  assert.equal(evaluateScalp(source).accepted, true);
});

test('단타는 EMA20 눌림 이후 직전 고가 회복도 진입 신호로 평가한다', () => {
  const source = input();
  Object.assign(source.candles['15'].at(-2)!, { open: 2069, close: 2068, high: 2070, low: 2065 });
  Object.assign(source.candles['15'].at(-1)!, { open: 2068, close: 2076, high: 2077, low: 2066 });
  source.candles['15'][77].low = 2058;
  source.ticker.tradePrice = 2074;
  const evaluation = evaluateScalp(source);
  assert.equal(evaluation.accepted, true, evaluation.accepted ? undefined : evaluation.code);
  if (evaluation.accepted) assert.equal(evaluation.candidate.setup, 'pullback');
});

test('후보 순위는 임계값과 최대 3개 제한을 적용하고 동점을 거래대금으로 정렬한다', () => {
  const ranked = rankCandidates([
    rankedCandidate('KRW-A', 'scalp', 80, 10),
    rankedCandidate('KRW-B', 'scalp', 80, 20),
    rankedCandidate('KRW-C', 'scalp', 75, 30),
    rankedCandidate('KRW-D', 'scalp', 70, 40),
    rankedCandidate('KRW-E', 'scalp', 69, 50),
  ], 'scalp');
  assert.deepEqual(ranked.map(({ market, rank }) => [market, rank]), [
    ['KRW-B', 1],
    ['KRW-A', 2],
    ['KRW-C', 3],
  ]);
});
