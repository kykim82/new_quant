// 단타와 스윙 후보의 조건·점수·가격 계획을 결정하는 순수 전략 엔진
import type {
  Candle,
  Candidate,
  ExecutionQuality,
  MarketDefinition,
  MarketRegime,
  MarketTicker,
  PricePlan,
  Strategy,
} from '@/lib/domain';
import {
  atr,
  buildChartPoints,
  cmf,
  dmi,
  donchianHigh,
  ema,
  lastConfirmedPivotLow,
  lastValue,
  ppo,
  rsi,
  rvol,
  trueRanges,
} from '@/lib/indicators';
import { resolvedKrwTickSize } from '@/lib/tick-size';

export type RejectCategory =
  | 'technicalConditions'
  | 'executionQuality'
  | 'insufficientData';

export interface RejectedEvaluation {
  accepted: false;
  category: RejectCategory;
  code: string;
}

export interface AcceptedEvaluation {
  accepted: true;
  candidate: Candidate;
}

export type StrategyEvaluation = RejectedEvaluation | AcceptedEvaluation;

export interface StrategyInput {
  market: MarketDefinition;
  ticker: MarketTicker;
  candles: Record<'15' | '60' | '240', Candle[]>;
  execution: ExecutionQuality;
  marketRegime: MarketRegime;
  btcChangeRate: number;
  feeRate: number;
}

function reject(category: RejectCategory, code: string): RejectedEvaluation {
  return { accepted: false, category, code };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundPrice(
  value: number,
  instrumentTickSize: number,
  referencePrice: number,
  direction: 'up' | 'down' | 'nearest',
): number {
  if (!Number.isFinite(value)) return value;
  const tickSize = resolvedKrwTickSize(value, instrumentTickSize, referencePrice);
  const scaled = value / tickSize;
  const rounded = direction === 'up' ? Math.ceil(scaled) : direction === 'down' ? Math.floor(scaled) : Math.round(scaled);
  return Number((rounded * tickSize).toPrecision(15));
}

function calculateNetRewardRisk(
  entry: number,
  stop: number,
  target: number,
  feeRate: number,
  slippagePct: number,
): number {
  const slippage = slippagePct / 100;
  const netProfit = target * (1 - feeRate - slippage) - entry * (1 + feeRate + slippage);
  const netLoss = entry * (1 + feeRate + slippage) - stop * (1 - feeRate - slippage);
  return netLoss <= 0 ? 0 : netProfit / netLoss;
}

function buildPricePlan(args: {
  entryLow: number;
  entryAnchor: number;
  entryHigh: number;
  rawStop: number;
  tickSize: number;
  tickSizeReferencePrice: number;
  expiresAt: number;
  feeRate: number;
  slippagePct: number;
}): PricePlan | null {
  const entryLow = roundPrice(args.entryLow, args.tickSize, args.tickSizeReferencePrice, 'up');
  const entryAnchor = roundPrice(args.entryAnchor, args.tickSize, args.tickSizeReferencePrice, 'nearest');
  const entryHigh = roundPrice(args.entryHigh, args.tickSize, args.tickSizeReferencePrice, 'down');
  const stop = roundPrice(args.rawStop, args.tickSize, args.tickSizeReferencePrice, 'down');
  if (!(stop < entryLow && entryLow <= entryAnchor && entryAnchor <= entryHigh)) return null;

  const risk = entryAnchor - stop;
  const targets: [number, number, number] = [
    roundPrice(entryAnchor + risk, args.tickSize, args.tickSizeReferencePrice, 'down'),
    roundPrice(entryAnchor + risk * 2, args.tickSize, args.tickSizeReferencePrice, 'down'),
    roundPrice(entryAnchor + risk * 3, args.tickSize, args.tickSizeReferencePrice, 'down'),
  ];
  if (!(entryHigh < targets[0] && targets[0] < targets[1] && targets[1] < targets[2])) return null;

  return {
    entryLow,
    entryAnchor,
    entryHigh,
    stop,
    targets,
    riskPct: (risk / entryAnchor) * 100,
    netRewardRiskAtTarget2: calculateNetRewardRisk(
      entryAnchor,
      stop,
      targets[1],
      args.feeRate,
      args.slippagePct,
    ),
    expiresAt: args.expiresAt,
  };
}

function hasRecentSynthetic(candles: readonly Candle[], count: number): boolean {
  return candles.slice(-count).some((candle) => candle.synthetic);
}

function chartSet(input: StrategyInput): Candidate['charts'] {
  return {
    '15': buildChartPoints(input.candles['15']),
    '60': buildChartPoints(input.candles['60']),
    '240': buildChartPoints(input.candles['240']),
  };
}

export function evaluateScalp(input: StrategyInput): StrategyEvaluation {
  const candles15 = input.candles['15'];
  const candles60 = input.candles['60'];
  if (candles15.length < 60 || candles60.length < 55) return reject('insufficientData', 'INSUFFICIENT_DATA');
  if (hasRecentSynthetic(candles15, 40) || hasRecentSynthetic(candles60, 24)) return reject('insufficientData', 'MISSING_RECENT_CANDLES');
  if (input.marketRegime === 'RISK_OFF') return reject('technicalConditions', 'BTC_RISK_OFF');
  if (!input.execution.sufficientDepth || input.execution.spreadPct > 0.2 || input.execution.buySlippagePct > 0.15) {
    return reject('executionQuality', 'POOR_EXECUTION');
  }

  const close15 = candles15.map((candle) => candle.close);
  const close60 = candles60.map((candle) => candle.close);
  const ema20_15 = lastValue(ema(close15, 20));
  const ema50_15 = lastValue(ema(close15, 50));
  const ema20_60 = lastValue(ema(close60, 20));
  const ema50_60 = lastValue(ema(close60, 50));
  const rsi14 = lastValue(rsi(close15, 14));
  const atrSeries = atr(candles15, 14);
  const atr14 = lastValue(atrSeries);
  const previousAtr = atrSeries.at(-2) ?? null;
  const relativeVolume = lastValue(rvol(candles15, 20));
  const breakout = lastValue(donchianHigh(candles15, 20));
  const latest = candles15.at(-1)!;

  if ([ema20_15, ema50_15, ema20_60, ema50_60, rsi14, atr14, previousAtr, relativeVolume, breakout].some((value) => value === null)) {
    return reject('insufficientData', 'INDICATOR_WARMUP');
  }
  if (atr14! <= 0 || previousAtr! <= 0) return reject('insufficientData', 'ZERO_ATR');
  if (!(ema20_15! > ema50_15! && ema20_60! > ema50_60! && latest.close > ema20_15!)) {
    return reject('technicalConditions', 'TREND_MISMATCH');
  }
  if (!(latest.close > breakout!)) return reject('technicalConditions', 'NO_BREAKOUT');
  if (relativeVolume! < 1.5) return reject('technicalConditions', 'LOW_RVOL');
  if (rsi14! < 55 || rsi14! > 70) return reject('technicalConditions', 'RSI_OUT_OF_RANGE');

  const extensionAtr = (latest.close - breakout!) / atr14!;
  const currentRangeRatio = trueRanges(candles15).at(-1)! / previousAtr!;
  if (extensionAtr > 0.5) return reject('technicalConditions', 'OVEREXTENDED');
  if (currentRangeRatio > 3) return reject('technicalConditions', 'PUMP_CANDLE');

  const pivot = lastConfirmedPivotLow(candles15.slice(-20));
  if (!pivot) return reject('technicalConditions', 'NO_CONFIRMED_SWING_LOW');
  const rawStop = Math.min(pivot.price, breakout! - atr14! * 0.7);
  const plan = buildPricePlan({
    entryLow: breakout!,
    entryAnchor: breakout! + atr14! * 0.1,
    entryHigh: breakout! + atr14! * 0.2,
    rawStop,
    tickSize: input.execution.tickSize,
    tickSizeReferencePrice: input.execution.tickSizeReferencePrice,
    expiresAt: latest.closeTime + 30 * 60_000,
    feeRate: input.feeRate,
    slippagePct: input.execution.buySlippagePct,
  });
  if (!plan) return reject('technicalConditions', 'INVALID_PRICE_PLAN');
  if (plan.riskPct > 2 || plan.entryAnchor - plan.stop > atr14! * 1.5) return reject('technicalConditions', 'RISK_TOO_WIDE');
  if (input.ticker.tradePrice < plan.entryLow - atr14! * 0.25 || input.ticker.tradePrice > plan.entryHigh + atr14! * 0.25) {
    return reject('technicalConditions', 'CURRENT_PRICE_OUTSIDE_ENTRY');
  }
  if (plan.netRewardRiskAtTarget2 < 1.5) return reject('technicalConditions', 'POOR_NET_RR');

  const centeredRsi = clamp(1 - Math.abs(rsi14! - 62.5) / 7.5, 0, 1);
  const rvolStrength = clamp((relativeVolume! - 1.5) / 1.5, 0, 1);
  const extensionQuality = clamp(1 - extensionAtr / 0.5, 0, 1);
  const spreadQuality = clamp(1 - input.execution.spreadPct / 0.2, 0, 1);
  const slippageQuality = clamp(1 - input.execution.buySlippagePct / 0.15, 0, 1);
  const score = Math.round(
    30 + 10 + centeredRsi * 5 + extensionQuality * 10 + 10 + rvolStrength * 15 + spreadQuality * 10 + slippageQuality * 10,
  );

  return {
    accepted: true,
    candidate: {
      market: input.market.market,
      koreanName: input.market.koreanName,
      englishName: input.market.englishName,
      strategy: 'scalp',
      setup: 'breakout',
      score: clamp(score, 0, 100),
      rank: 0,
      currentPrice: input.ticker.tradePrice,
      signedChangeRate: input.ticker.signedChangeRate,
      quoteVolume24h: input.ticker.quoteVolume24h,
      signalTime: latest.closeTime,
      reasons: [
        '1시간·15분 EMA 상승 배열',
        `20봉 고점 돌파 · 거래대금 ${relativeVolume!.toFixed(1)}배`,
        `RSI ${rsi14!.toFixed(1)} · 추격 제한 통과`,
      ],
      warnings: plan.riskPct > 1.5 ? ['손절 폭이 다소 넓습니다'] : [],
      plan,
      metrics: {
        rsi: rsi14!,
        atrPct: (atr14! / latest.close) * 100,
        rvol: relativeVolume!,
        spreadPct: input.execution.spreadPct,
        slippagePct: input.execution.buySlippagePct,
      },
      charts: chartSet(input),
    },
  };
}

export function evaluateSwing(input: StrategyInput): StrategyEvaluation {
  const candles60 = input.candles['60'];
  const candles240 = input.candles['240'];
  if (candles60.length < 60 || candles240.length < 220) return reject('insufficientData', 'INSUFFICIENT_DATA');
  if (hasRecentSynthetic(candles60, 36) || hasRecentSynthetic(candles240, 20)) return reject('insufficientData', 'MISSING_RECENT_CANDLES');
  if (input.marketRegime === 'RISK_OFF') return reject('technicalConditions', 'BTC_RISK_OFF');
  if (!input.execution.sufficientDepth || input.execution.spreadPct > 0.35 || input.execution.buySlippagePct > 0.25) {
    return reject('executionQuality', 'POOR_EXECUTION');
  }

  const close60 = candles60.map((candle) => candle.close);
  const close240 = candles240.map((candle) => candle.close);
  const ema20Series = ema(close240, 20);
  const ema50Series = ema(close240, 50);
  const ema200Series = ema(close240, 200);
  const ema20_240 = lastValue(ema20Series);
  const ema50_240 = lastValue(ema50Series);
  const ema200_240 = lastValue(ema200Series);
  const ema50SlopeBase = ema50Series.at(-4) ?? null;
  const rsi240 = lastValue(rsi(close240, 14));
  const atr240 = lastValue(atr(candles240, 14));
  const atr60 = lastValue(atr(candles60, 14));
  const dmi240 = dmi(candles240, 14);
  const adx240 = lastValue(dmi240.adx);
  const plusDi = lastValue(dmi240.plusDi);
  const minusDi = lastValue(dmi240.minusDi);
  const latest240 = candles240.at(-1)!;
  const latest60 = candles60.at(-1)!;

  if ([ema20_240, ema50_240, ema200_240, ema50SlopeBase, rsi240, atr240, atr60, adx240, plusDi, minusDi].some((value) => value === null)) {
    return reject('insufficientData', 'INDICATOR_WARMUP');
  }
  if (atr240! <= 0 || atr60! <= 0) return reject('insufficientData', 'ZERO_ATR');
  if (!(ema20_240! > ema50_240! && ema50_240! > ema200_240! && ema50_240! > ema50SlopeBase!)) {
    return reject('technicalConditions', 'TREND_MISMATCH');
  }
  if (!(adx240! >= 20 && plusDi! > minusDi!)) return reject('technicalConditions', 'WEAK_TREND');
  if (rsi240! < 50 || rsi240! >= 75) return reject('technicalConditions', 'RSI_OUT_OF_RANGE');
  if (Math.abs(latest240.close - ema20_240!) / atr240! > 1.5) return reject('technicalConditions', 'OVEREXTENDED');

  const breakout = lastValue(donchianHigh(candles60, 20));
  const relativeVolume = lastValue(rvol(candles60, 20));
  const rsi60Series = rsi(close60, 14);
  const rsi60Now = lastValue(rsi60Series);
  const rsi60Previous = rsi60Series.at(-2) ?? null;
  const pivot = lastConfirmedPivotLow(candles60.slice(-30));
  if ([breakout, relativeVolume, rsi60Now, rsi60Previous].some((value) => value === null) || !pivot) {
    return reject('insufficientData', 'ENTRY_DATA_MISSING');
  }

  const isBreakout = latest60.close > breakout! && relativeVolume! >= 1.5 && (latest60.close - breakout!) / atr60! <= 0.75;
  const supportLow = pivot.price - atr60! * 0.25;
  const supportHigh = pivot.price + atr60! * 0.25;
  const trendLow = Math.min(ema20_240!, ema50_240!);
  const trendHigh = Math.max(ema20_240!, ema50_240!);
  const pullbackLow = Math.max(supportLow, trendLow);
  const pullbackHigh = Math.min(supportHigh, trendHigh);
  const isPullback = pullbackLow < pullbackHigh
    && latest60.close >= pullbackLow - atr60! * 0.25
    && latest60.close <= pullbackHigh + atr60! * 0.25
    && rsi60Previous! <= 50
    && rsi60Now! > 50;
  if (!isBreakout && !isPullback) return reject('technicalConditions', 'NO_ENTRY_SETUP');

  const setup = isBreakout ? 'breakout' : 'pullback';
  const entryLowRaw = isBreakout ? breakout! - atr60! * 0.2 : pullbackLow;
  const entryHighRaw = isBreakout ? breakout! + atr60! * 0.2 : pullbackHigh;
  const entryAnchorRaw = isBreakout ? breakout! : (pullbackLow + pullbackHigh) / 2;
  const plan = buildPricePlan({
    entryLow: entryLowRaw,
    entryAnchor: entryAnchorRaw,
    entryHigh: entryHighRaw,
    rawStop: pivot.price - atr60! * 0.3,
    tickSize: input.execution.tickSize,
    tickSizeReferencePrice: input.execution.tickSizeReferencePrice,
    expiresAt: latest60.closeTime + 3 * 60 * 60_000,
    feeRate: input.feeRate,
    slippagePct: input.execution.buySlippagePct,
  });
  if (!plan) return reject('technicalConditions', 'INVALID_PRICE_PLAN');
  if (plan.riskPct > 6 || plan.entryAnchor - plan.stop > atr60! * 2.5) return reject('technicalConditions', 'RISK_TOO_WIDE');
  if (input.ticker.tradePrice < plan.entryLow - atr60! * 0.25 || input.ticker.tradePrice > plan.entryHigh + atr60! * 0.25) {
    return reject('technicalConditions', 'CURRENT_PRICE_OUTSIDE_ENTRY');
  }
  if (plan.netRewardRiskAtTarget2 < 1.5) return reject('technicalConditions', 'POOR_NET_RR');

  const flow = lastValue(cmf(candles60, 20)) ?? 0;
  const momentum = lastValue(ppo(close240).histogram) ?? 0;
  const relativeStrength = input.ticker.signedChangeRate - input.btcChangeRate;
  const rsiQuality = rsi240! <= 70 ? 1 : clamp((75 - rsi240!) / 5, 0, 1);
  const volumeQuality = clamp((relativeVolume! - 1) / 1.5, 0, 1);
  const flowQuality = clamp((flow + 0.1) / 0.3, 0, 1);
  const momentumQuality = momentum > 0 ? 1 : clamp(1 + momentum / 0.5, 0, 1);
  const relativeQuality = clamp((relativeStrength + 0.02) / 0.06, 0, 1);
  const executionQuality = clamp(1 - input.execution.spreadPct / 0.35, 0, 1);
  const score = Math.round(
    30 + 20 + volumeQuality * 10 + flowQuality * 5 + rsiQuality * 8 + momentumQuality * 7 + relativeQuality * 10 + executionQuality * 5 + clamp(plan.netRewardRiskAtTarget2 / 2, 0, 1) * 5,
  );

  return {
    accepted: true,
    candidate: {
      market: input.market.market,
      koreanName: input.market.koreanName,
      englishName: input.market.englishName,
      strategy: 'swing',
      setup,
      score: clamp(score, 0, 100),
      rank: 0,
      currentPrice: input.ticker.tradePrice,
      signedChangeRate: input.ticker.signedChangeRate,
      quoteVolume24h: input.ticker.quoteVolume24h,
      signalTime: latest60.closeTime,
      reasons: [
        '4시간 EMA 정배열·ADX 추세 확인',
        setup === 'breakout' ? `1시간 고점 돌파 · 거래대금 ${relativeVolume!.toFixed(1)}배` : '1시간 지지 구간 눌림 후 회복',
        `RSI ${rsi240!.toFixed(1)} · CMF ${flow.toFixed(2)}`,
      ],
      warnings: relativeStrength < 0 ? ['BTC보다 상대 강도가 낮습니다'] : [],
      plan,
      metrics: {
        rsi: rsi240!,
        atrPct: (atr240! / latest240.close) * 100,
        rvol: relativeVolume!,
        adx: adx240!,
        cmf: flow,
        ppoHistogram: momentum,
        spreadPct: input.execution.spreadPct,
        slippagePct: input.execution.buySlippagePct,
      },
      charts: chartSet(input),
    },
  };
}

export function rankCandidates(candidates: readonly Candidate[], strategy: Strategy, limit = 3): Candidate[] {
  const threshold = strategy === 'scalp' ? 70 : 72;
  return [...candidates]
    .filter((candidate) => candidate.strategy === strategy && candidate.score >= threshold)
    .sort((left, right) => right.score - left.score || right.quoteVolume24h - left.quoteVolume24h || left.market.localeCompare(right.market))
    .slice(0, limit)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

export function deriveBtcRegime(candles60: readonly Candle[], candles240: readonly Candle[]): MarketRegime {
  if (candles60.length < 55 || candles240.length < 205) return 'NEUTRAL';
  const close60 = candles60.map((candle) => candle.close);
  const close240 = candles240.map((candle) => candle.close);
  const e20_60 = lastValue(ema(close60, 20));
  const e50_60 = lastValue(ema(close60, 50));
  const e50_240 = lastValue(ema(close240, 50));
  const e200_240 = lastValue(ema(close240, 200));
  const last60 = close60.at(-1)!;
  const last240 = close240.at(-1)!;
  if (e20_60 === null || e50_60 === null || e50_240 === null || e200_240 === null) return 'NEUTRAL';
  if (last60 < e50_60 && e20_60 < e50_60 && last240 < e200_240) return 'RISK_OFF';
  if (last60 > e20_60 && e20_60 > e50_60 && last240 > e50_240 && e50_240 > e200_240) return 'BULLISH';
  return 'NEUTRAL';
}
