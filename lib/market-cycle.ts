// 전체 종목 순회와 시간대별 캔들 호출 예산·관찰 사유를 계산한다
import type { Candle, CandleUnit, Candidate, MarketDefinition, MarketTicker, Observation, Strategy } from './domain';
import { ema, lastValue, rsi } from './indicators';
import type { StrategyEvaluation, StrategyInput } from './strategy';

export type CandleCache = Record<'15' | '60' | '240', Candle[]>;
export const ENTRY_VOLUME = { scalp: 1_000_000_000, swing: 500_000_000 };
export const SIGNAL_FRESH_MS = 20 * 60_000;
export const REASONS: Record<string, string> = {
  LOW_LIQUIDITY: '거래대금 부족 · 단타 10억 / 스윙 5억 원 기준',
  BTC_RISK_OFF: 'BTC 위험회피 국면 · 신규 매수 대기',
  POOR_EXECUTION: '호가 데이터·물량 또는 예상 체결 비용 기준 미달',
  TREND_MISMATCH: '상승 추세 형성 대기', WEAK_TREND: '추세 강도 회복 대기',
  NO_BREAKOUT: '직전 20봉 고점 돌파 대기', NO_ENTRY_SETUP: '돌파 또는 눌림 회복 대기',
  LOW_RVOL: '신호봉 거래대금 증가 대기', RSI_OUT_OF_RANGE: 'RSI 과열 또는 모멘텀 부족',
  OVEREXTENDED: '추격 구간 · 진입 가격으로 복귀 대기', PUMP_CANDLE: '비정상 급등 봉 · 안정 대기',
  CURRENT_PRICE_OUTSIDE_ENTRY: '현재가가 진입 허용 구간을 벗어남',
  RISK_TOO_WIDE: '손절 거리 과다', POOR_NET_RR: '비용 반영 손익비 부족',
  NO_CONFIRMED_SWING_LOW: '확인된 지지 저점 대기', INVALID_PRICE_PLAN: '유효한 가격 계획 없음',
  SCORE_TOO_LOW: '진입 신호는 있으나 종합 점수 부족',
  INSUFFICIENT_DATA: '캔들 이력 부족', MISSING_RECENT_CANDLES: '최근 무거래·누락 봉 확인 필요',
  INDICATOR_WARMUP: '지표 계산 이력 부족', ENTRY_DATA_MISSING: '진입 구간 이력 부족',
  ZERO_ATR: '가격 변동 데이터 부족', DATA_DELAYED: '분석 지연 · 재분석 대기',
};

export function nextMarkets(markets: MarketDefinition[], tickers: MarketTicker[], checked: Map<string, number>): MarketDefinition[] {
  const volumes = new Map(tickers.map(t => [t.market, t.quoteVolume24h]));
  return markets.filter(m => !m.warned && volumes.has(m.market)).sort((a, b) =>
    (checked.get(a.market) ?? 0) - (checked.get(b.market) ?? 0)
    || (volumes.get(b.market) ?? 0) - (volumes.get(a.market) ?? 0) || a.market.localeCompare(b.market));
}

export function dueUnits(cache: CandleCache, now: number): CandleUnit[] {
  return ([15, 60, 240] as const).filter(unit => {
    const boundary = Math.floor(now / (unit * 60_000)) * unit * 60_000;
    return (cache[String(unit) as keyof CandleCache].at(-1)?.closeTime ?? 0) < boundary;
  });
}

export function candleCost(cache: CandleCache, now: number): number {
  return dueUnits(cache, now).reduce((sum, unit) => sum + (unit === 240 && cache['240'].length < 220 ? 2 : 1), 0);
}

export function emptyCandles(): CandleCache { return { '15': [], '60': [], '240': [] }; }

export function activityRatio(candles: Candle[], current24h: number): number | null {
  if (candles.length < 96) return null;
  const average = candles.slice(-96, -24).reduce((sum, candle) => sum + candle.quoteVolume, 0) / 3;
  return average > 0 ? current24h / average : null;
}

export function entryStillValid(candidate: Candidate, price: number, now: number): boolean {
  const tolerance = (candidate.plan.entryHigh - candidate.plan.entryLow) * 0.625;
  return candidate.plan.expiresAt > now && price > candidate.plan.stop && price < candidate.plan.targets[0]
    && price >= candidate.plan.entryLow - tolerance && price <= candidate.plan.entryHigh + tolerance;
}

export function makeObservation(input: StrategyInput, strategy: Strategy, result: StrategyEvaluation, now: number): Observation {
  const candles = input.candles[strategy === 'scalp' ? '15' : '240'];
  const closes = candles.map(c => c.close);
  const e20 = lastValue(ema(closes, 20));
  const e50 = lastValue(ema(closes, 50));
  const strength = lastValue(rsi(closes, 14));
  const trendScore = (e20 && e50 && e20 > e50 ? 40 : 0)
    + (e20 && input.ticker.tradePrice > e20 ? 20 : 0)
    + (strength !== null && strength >= 45 && strength <= 70 ? 20 : 0)
    + (input.ticker.quoteVolume24h >= ENTRY_VOLUME[strategy] ? 20 : 0);
  const code = input.ticker.quoteVolume24h < ENTRY_VOLUME[strategy] ? 'LOW_LIQUIDITY'
    : result.accepted ? 'SCORE_TOO_LOW' : result.code;
  return { market: input.market.market, koreanName: input.market.koreanName, strategy,
    currentPrice: input.ticker.tradePrice, quoteVolume24h: input.ticker.quoteVolume24h,
    analyzedAt: now, code, reason: REASONS[code] ?? code, trendScore };
}
