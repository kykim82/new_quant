// 거래대금 예외 편입·상위 구조·일봉 집계·증분 호출과 관찰 제외를 검증한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Candle, MarketTicker } from '../lib/domain';
import { dailyContext, frameStructure, liquidityEligible, screenLiquidity } from '../lib/opportunity';
import { summarizeMarkets } from '../lib/scanner';
import { candleUnitDue, refreshCandleUnit } from '../lib/upbit';
import { emptyCandles } from '../lib/market-cycle';
import { advanceTrends } from '../lib/trend-state';

const now = Math.floor(1_800_000_000_000 / 86_400_000) * 86_400_000;
const ticker: MarketTicker = { market: 'KRW-X', tradePrice: 100, signedChangeRate: 0, quoteVolume24h: 200_000_000, timestamp: now };
function bars(count: number, unit: 15 | 60 | 240 = 60): Candle[] {
  return Array.from({ length: count }, (_, i) => ({ market: 'KRW-X', unit,
    openTime: now - (count - i) * unit * 60_000, closeTime: now - (count - i - 1) * unit * 60_000,
    open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, baseVolume: 100,
    quoteVolume: 1_000_000, synthetic: false }));
}

test('10억은 단타·스윙 공통으로 통과하고 저거래대금의 단순 정체는 기본 감시로 둔다', () => {
  assert.equal(liquidityEligible({ ...ticker, quoteVolume24h: 1e9 }, undefined, now), true);
  assert.equal(liquidityEligible(ticker, screenLiquidity(bars(96), now), now), false);
});

test('3개의 비중복 24시간 거래대금 연속 증가를 확인하고 만료 시 예외를 해제한다', () => {
  const data = bars(96).map((c, i) => ({ ...c, quoteVolume: i < 48 ? 1e6 : i < 72 ? 2e6 : 3e6 }));
  const screen = screenLiquidity(data, now);
  assert.equal(screen.increasing, true);
  assert.equal(screen.burst, false);
  assert.equal(screen.average3d, 32e6);
  assert.equal(liquidityEligible(ticker, screen, now), true);
  assert.equal(liquidityEligible(ticker, screen, now + 3_600_000), false);
});

test('갑작스러운 거래대금 증가는 직전 20시간과 비교하며 진행 봉과 극소액은 제외한다', () => {
  const data = bars(96);
  data.at(-1)!.quoteVolume = 10e6;
  const screen = screenLiquidity(data, now);
  assert.equal(screen.burst, true);
  assert.equal(screen.hourlyRatio, 10);
  assert.equal(liquidityEligible(ticker, screen, now), true);
  data.at(-1)!.closeTime += 3_600_000;
  assert.equal(screenLiquidity(data, now).burst, false);
  assert.equal(screenLiquidity(bars(96).map((c, i) => ({ ...c, quoteVolume: i === 95 ? 100 : 1 })), now).burst, false);
});

test('미수집 시간 공백이 있으면 거래대금 증가를 확정하지 않는다', () => {
  const data = bars(96).filter((_, i) => i !== 80);
  data.at(-1)!.quoteVolume = 30e6;
  assert.equal(screenLiquidity(data, now).burst, false);
  assert.equal(screenLiquidity(data, now).increasing, false);
});

test('거래대금 미달 종목은 관찰을 채우지 않으며 신규 고거래대금은 미분석으로 집계한다', () => {
  const market = { market: ticker.market, koreanName: '엑스', englishName: 'X', warned: false };
  const stored = { market: market.market, engineVersion: 5 as const, analyzedAt: now, complete: false, candidates: [], legacy: [],
    observations: [{ market: market.market, koreanName: '엑스', strategy: 'scalp' as const, currentPrice: 100, quoteVolume24h: 2e8, analyzedAt: now, code: 'LOW_LIQUIDITY', reason: '대기', trendScore: 50 }] };
  const payload = summarizeMarkets([stored], [market], [ticker], 'NEUTRAL', now);
  assert.equal(payload.watchlist?.length, 0);
  assert.equal(payload.coverage.eligibleMarketCount, 0);
  assert.equal(payload.coverage.monitoringMarketCount, 1);
  const promoted = summarizeMarkets([], [market], [{ ...ticker, quoteVolume24h: 1e9 }], 'NEUTRAL', now);
  assert.equal(promoted.coverage.pendingMarketCount, 1);
});

test('하락 구조와 최근 누락 봉은 상위 시간대 통과로 위장하지 않는다', () => {
  const rising = bars(100);
  assert.equal(frameStructure(rising).alive, true);
  assert.equal(frameStructure(rising.map((c, i) => ({ ...c, open: 300 - i, high: 302 - i, low: 299 - i, close: 301 - i }))).alive, false);
  rising.at(-1)!.synthetic = true;
  assert.equal(frameStructure(rising).ready, false);
});

test('ST가 늦게 전환되어도 확정 저점 상승과 고점 회복이면 초기 전환으로 분류한다', () => {
  const data = bars(100).map((c, i) => ({ ...c, open: 100 + i * 0.1, close: 100 + i * 0.1, high: 101 + i * 0.1, low: 99 + i * 0.1 }));
  data[88].low = 100;
  data[91].high = 114;
  data[94].low = 104;
  Object.assign(data[99], { open: 110, high: 117, low: 109, close: 116 });
  const trend = advanceTrends(data);
  trend.stDirection = -1;
  const structure = frameStructure(data, trend);
  assert.equal(structure.alive, true);
  assert.equal(structure.early, true);
  data[99].low = 103;
  assert.equal(frameStructure(data, trend).alive, false);
});

test('10억 미만이어도 최신 거래대금 급증 예외는 상세 범위와 관찰에 남는다', () => {
  const hourly = bars(96);
  hourly.at(-1)!.quoteVolume = 20e6;
  const screen = screenLiquidity(hourly, now);
  const market = { market: 'KRW-X', koreanName: '엑스', englishName: 'X', warned: false };
  const result = { market: market.market, engineVersion: 5 as const, analyzedAt: now, complete: true, screen, candidates: [], legacy: [],
    observations: [{ market: market.market, koreanName: '엑스', strategy: 'scalp' as const, currentPrice: 100, quoteVolume24h: 2e8, analyzedAt: now, code: 'NO_ENTRY_SETUP', reason: '눌림 대기', trendScore: 80 }] };
  const payload = summarizeMarkets([result], [market], [ticker], 'NEUTRAL', now);
  assert.equal(payload.coverage.volumeGrowthMarketCount, 1);
  assert.equal(payload.coverage.eligibleMarketCount, 1);
  assert.equal(payload.watchlist?.[0].code, 'NO_ENTRY_SETUP');
});

test('일봉 배경은 UTC 완성 4시간 봉 여섯 개만 집계한다', () => {
  const data = bars(144, 240);
  assert.equal(dailyContext(data, now), 'up');
  assert.equal(dailyContext(data.slice(0, -1), now), 'unknown');
  data.at(-3)!.synthetic = true;
  assert.equal(dailyContext(data, now), 'unknown');
});

test('800봉 미만이어도 최신 봉은 재수집하지 않고 경계 이후 한 페이지만 추가한다', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const cache = { ...emptyCandles(), '60': bars(200) };
  globalThis.fetch = (async () => {
    calls++;
    return Response.json([{ market: 'KRW-X', candle_date_time_utc: new Date(now).toISOString(), unit: 60,
      opening_price: 300, high_price: 302, low_price: 299, trade_price: 301, candle_acc_trade_price: 1e6, candle_acc_trade_volume: 100 }]);
  }) as typeof fetch;
  try {
    assert.equal(candleUnitDue(cache, 60, now), false);
    await refreshCandleUnit('KRW-X', 60, cache, now);
    assert.equal(calls, 0);
    const updated = await refreshCandleUnit('KRW-X', 60, cache, now + 3_600_000);
    assert.equal(calls, 1);
    assert.equal(updated['60'].length, 201);
    assert.equal(updated['60'].at(-1)?.closeTime, now + 3_600_000);
  } finally { globalThis.fetch = original; }
});
