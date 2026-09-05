// 전체시장 순환과 만료·경고 재검사 및 비용 검증을 회귀 검사한다
import assert from 'node:assert/strict';
import test from 'node:test';
import { activityRatio, candleCost, emptyCandles, nextMarkets, retainPricePlan } from '../lib/market-cycle';
import { summarizeMarkets } from '../lib/scanner';
import { withSpreadWarning } from '../lib/execution-warning';
import type { Candidate, ExecutionQuality, MarketDefinition, MarketTicker } from '../lib/domain';
import type { MarketResult } from '../lib/cycle-store';

const now = 1_800_000_000_000;
const market: MarketDefinition = { market: 'KRW-X', koreanName: '엑스', englishName: 'X', warned: false };
const ticker: MarketTicker = { market: market.market, tradePrice: 100, signedChangeRate: 0, quoteVolume24h: 1_500_000_000, timestamp: now };
const candidate: Candidate = { ...market, strategy: 'scalp', setup: 'breakout', score: 80, rank: 1,
  currentPrice: 100, signedChangeRate: 0, quoteVolume24h: ticker.quoteVolume24h, signalTime: now,
  reasons: [], warnings: [], charts: { '15': [], '60': [], '240': [] },
  plan: { entryLow: 99.9, entryAnchor: 100, entryHigh: 100.1, stop: 98, targets: [102, 104, 106], riskPct: 2, netRewardRiskAtTarget2: 1.8, expiresAt: now + 600_000 },
  metrics: { rsi: 60, atrPct: 1, rvol: 1.5, spreadPct: 0.01, slippagePct: 0.01 } };
const execution: ExecutionQuality = { spreadPct: 0.01, buySlippagePct: 0.01, sufficientDepth: true, tickSize: 0.1, tickSizeReferencePrice: 100 };
const result: MarketResult = { market: market.market, engineVersion: 3, analyzedAt: now, complete: true, candidates: [candidate], legacy: [], observations: [] };
const quality = new Map([[market.market, execution]]);

test('저장된 단타·스윙 후보의 넓은 스프레드도 제외하지 않고 최신 주의로 교체한다', () => {
  for (const strategy of ['scalp', 'swing'] as const) {
    const stored = { ...result, candidates: [{ ...candidate, strategy, warnings: ['기존 주의', '호가 스프레드 0.500% · 이전 값'] }] };
    const wide = new Map([[market.market, { ...execution, spreadPct: 2 }]]);
    const payload = summarizeMarkets([stored], [market], [ticker], 'NEUTRAL', now, wide);
    assert.equal(payload[strategy].length, 1);
    assert.equal(payload[strategy][0].score, candidate.score);
    assert.equal(payload[strategy][0].metrics.spreadPct, 2);
    assert.equal(payload[strategy][0].warnings.length, 2);
    assert.ok(payload[strategy][0].warnings[1].includes('2.000%'));
    const recovered = summarizeMarkets([{ ...stored, candidates: payload[strategy] }], [market], [ticker], 'NEUTRAL', now, quality);
    assert.deepEqual(recovered[strategy][0].warnings, ['기존 주의']);
    const expensive = new Map([[market.market, { ...execution, buySlippagePct: 1 }]]);
    assert.equal(summarizeMarkets([stored], [market], [ticker], 'NEUTRAL', now, expensive)[strategy].length, 0);
  }
});

test('스프레드 주의 기준 경계와 중복 제거를 검증한다', () => {
  for (const [strategy, threshold] of [['scalp', 0.2], ['swing', 0.35]] as const) {
    assert.deepEqual(withSpreadWarning([], strategy, threshold), []);
    const warnings = withSpreadWarning([], strategy, threshold + 0.001);
    assert.equal(warnings.length, 1);
    assert.deepEqual(withSpreadWarning(warnings, strategy, threshold + 0.001), warnings);
  }
});

test('거래대금 가속도는 최근 24봉을 제외한 이전 72시간의 일평균과 비교한다', () => {
  const candles = Array.from({ length: 96 }, (_, i) => ({ quoteVolume: i < 72 ? 10 : 9999 } as never));
  assert.equal(activityRatio(candles, 480), 2);
  assert.equal(activityRatio([], 480), null);
});

test('거래대금이 작은 종목도 전체 순회 대상이고 경고만 제외한다', () => {
  const markets = Array.from({ length: 30 }, (_, i) => ({ ...market, market: `KRW-${i}`, warned: i === 29 }));
  const tickers = markets.map((m, i) => ({ ...ticker, market: m.market, quoteVolume24h: i + 1 }));
  const checked = new Map<string, number>();
  const first = nextMarkets(markets, tickers, checked).slice(0, 9);
  first.forEach(m => checked.set(m.market, now));
  const second = nextMarkets(markets, tickers, checked).slice(0, 9);
  assert.equal(nextMarkets(markets, tickers, checked).length, 29);
  assert.ok(second.every(m => !first.some(f => f.market === m.market)));
});

test('첫 종목 800봉 캔들은 12회이며 충분한 최신 캐시는 0회로 계산한다', () => {
  const cache = emptyCandles();
  assert.equal(candleCost(cache, now), 12);
  for (const unit of [15, 60, 240] as const) {
    const boundary = Math.floor(now / (unit * 60_000)) * unit * 60_000;
    cache[String(unit) as keyof typeof cache] = Array.from({ length: 800 }, () => ({ closeTime: boundary } as never));
  }
  assert.equal(candleCost(cache, now), 0);
});

test('기존 100억보다 낮은 15억 종목도 개선 단타 후보가 된다', () => {
  const payload = summarizeMarkets([result], [market], [ticker], 'NEUTRAL', now, quality);
  assert.equal(payload.scalp.length, 1);
});
test('새 주의·경고 종목의 저장된 추천과 관찰은 모두 제외한다', () => {
  const payload = summarizeMarkets([result], [{ ...market, warned: true }], [ticker], 'NEUTRAL', now, quality);
  assert.equal(payload.scalp.length, 0); assert.equal(payload.watchlist?.length, 0);
});
test('분석이 20분을 넘으면 매수 후보 대신 지연으로 표시한다', () => {
  const payload = summarizeMarkets([{ ...result, analyzedAt: now - 1_200_001 }], [market], [ticker], 'NEUTRAL', now, quality);
  assert.equal(payload.scalp.length, 0); assert.equal(payload.watchlist?.[0].code, 'DATA_DELAYED');
});
test('현재가 이탈·거래대금 하락·호가 실패를 저장된 후보에도 재적용한다', () => {
  assert.equal(summarizeMarkets([result], [market], [{ ...ticker, tradePrice: 110 }], 'NEUTRAL', now, quality).scalp.length, 0);
  assert.equal(summarizeMarkets([result], [market], [{ ...ticker, quoteVolume24h: 500_000_000 }], 'NEUTRAL', now, quality).scalp.length, 0);
  assert.equal(summarizeMarkets([result], [market], [ticker], 'NEUTRAL', now).scalp.length, 0);
  assert.equal(summarizeMarkets([result], [market], [ticker], 'RISK_OFF', now, quality).scalp.length, 0);
});

test('미분석 종목을 분석 완료나 후보 없음으로 집계하지 않는다', () => {
  const payload = summarizeMarkets([], [market], [ticker], 'NEUTRAL', now);
  assert.equal(payload.coverage.pendingMarketCount, 1);
  assert.equal(payload.coverage.analyzedMarketCount, 0);
});

test('구 엔진 후보는 새 목표가 후보로 표시하지 않고 준비 대기로 분류한다', () => {
  const payload = summarizeMarkets([{ ...result, engineVersion: undefined }], [market], [ticker], 'NEUTRAL', now, quality);
  assert.equal(payload.scalp.length, 0);
  assert.equal(payload.coverage.completedMarketCount, 0);
  assert.equal(payload.coverage.pendingMarketCount, 1);
  assert.equal(payload.watchlist?.[0].code, 'ENGINE_WARMUP');
});

test('같은 진입 계획이 유효하면 목표·손절·발행 시각을 고정하고 만료 이후만 새로 발행한다', () => {
  const next = { ...candidate, signalTime: now + 300_000, plan: { ...candidate.plan, targets: [110, 120, 130] } };
  const frozen = retainPricePlan(next, [candidate], 100, now + 300_000);
  assert.deepEqual(frozen.plan, candidate.plan);
  assert.equal(frozen.signalTime, candidate.signalTime);
  assert.deepEqual(retainPricePlan(next, [candidate], 100, now + 600_001), next);
});
