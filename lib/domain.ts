// 업비트 시세와 추천 결과가 공유하는 도메인 타입을 정의한다
export type CandleUnit = 15 | 60 | 240;
export type Strategy = 'scalp' | 'swing';
export type SetupType = 'breakout' | 'pullback' | 'reversal';
export type MarketRegime = 'BULLISH' | 'NEUTRAL' | 'RISK_OFF';

export interface Candle {
  market: string;
  unit: CandleUnit;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  baseVolume: number;
  quoteVolume: number;
  synthetic: boolean;
}

export interface MarketDefinition {
  market: string;
  koreanName: string;
  englishName: string;
  warned: boolean;
}

export interface MarketTicker {
  market: string;
  tradePrice: number;
  signedChangeRate: number;
  quoteVolume24h: number;
  timestamp: number;
}

export interface OrderbookLevel {
  askPrice: number;
  bidPrice: number;
  askSize: number;
  bidSize: number;
}

export interface OrderbookSnapshot {
  market: string;
  timestamp: number;
  levels: OrderbookLevel[];
}

export interface ExecutionQuality {
  spreadPct: number;
  buySlippagePct: number;
  sufficientDepth: boolean;
  tickSize: number;
  tickSizeReferencePrice: number;
}

export interface ChartPoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  quoteVolume: number;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  supertrend?: number | null;
  targetBand?: number | null;
}

export interface PricePlan {
  entryLow: number;
  entryAnchor: number;
  entryHigh: number;
  stop: number;
  targets: number[];
  riskPct: number;
  netRewardRiskAtTarget2: number;
  expiresAt: number;
  version?: 'confluence-v3';
  id?: string;
  issuedAt?: number;
  entryReason?: string;
  stopReason?: string;
  targetEvidence?: Array<{ low: number; high: number; kind: 'resistance' | 'projection'; reasons: string[] }>;
  grossReturns?: number[];
  netReturns?: number[];
  netSplitReturn?: number | null;
}

export interface Candidate {
  entryStatus?: 'ready' | 'waiting' | 'stopped';
  entryBlockReason?: string;
  entryValidUntil?: number;
  market: string;
  koreanName: string;
  englishName: string;
  strategy: Strategy;
  setup: SetupType;
  score: number;
  rank: number;
  currentPrice: number;
  signedChangeRate: number;
  quoteVolume24h: number;
  signalTime: number;
  reasons: string[];
  warnings: string[];
  plan: PricePlan;
  metrics: {
    rsi: number;
    atrPct: number;
    rvol: number;
    adx?: number;
    cmf?: number;
    ppoHistogram?: number;
    activityRatio?: number;
    averageTurnover3d?: number;
    hourlyTurnoverRatio?: number;
    spreadPct: number;
    slippagePct: number;
  };
  charts: Record<'15' | '60' | '240', ChartPoint[]>;
}

export interface SavedPlan {
  candidate: Candidate;
  checkedThrough: number;
  stoppedAt?: number;
  targetReachedAt?: number;
  hasGap?: boolean;
}

export interface RejectionSummary {
  lowLiquidity: number;
  marketWarning: number;
  technicalConditions: number;
  executionQuality: number;
  insufficientData: number;
}

export interface DashboardPayload {
  savedPlans?: Candidate[];
  schemaVersion?: number;
  priceUpdatedAt?: number;
  watchlist?: Observation[];
  diagnostics?: Record<string, number>;
  comparison?: { legacy: number; improved: number; note: string };
  paper?: Array<{ variant: string; total: number; pending: number; open: number; closed: number; ambiguous: number; meanNetPct: number | null }>;
  generatedAt: number;
  source: 'live' | 'cached';
  stale: boolean;
  analysisNotionalKrw: number;
  marketRegime: MarketRegime;
  btcPrice: number | null;
  btcChangeRate: number | null;
  coverage: {
    krwMarketCount: number;
    eligibleMarketCount: number;
    analyzedMarketCount: number;
    completedMarketCount: number;
    pendingMarketCount?: number;
    freshMarketCount?: number;
    delayedMarketCount?: number;
    oldestAnalysisAt?: number;
    monitoringMarketCount?: number;
    volumeGrowthMarketCount?: number;
  };
  scalp: Candidate[];
  swing: Candidate[];
  rejections: RejectionSummary;
  notice: string;
  error?: string;
}

export interface Observation {
  market: string;
  koreanName: string;
  strategy: Strategy;
  currentPrice: number;
  quoteVolume24h: number;
  analyzedAt: number;
  code: string;
  reason: string;
  trendScore: number;
}
