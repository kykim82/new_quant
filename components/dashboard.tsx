'use client';
// 실시간 추천 조회와 모바일·데스크톱 상호작용을 담당하는 대시보드

import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  Clock3,
  Gauge,
  RefreshCcw,
  ShieldCheck,
  Signal,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PriceChart } from '@/components/price-chart';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { Candidate, CandleUnit, DashboardPayload, Strategy } from '@/lib/domain';
import { krwTickSize } from '@/lib/tick-size';
import { REASONS } from '@/lib/market-cycle';

type LoadState = 'loading' | 'ready' | 'refreshing' | 'error';

interface ModelContextLike {
  registerTool(tool: {
    name: string;
    title: string;
    description: string;
    inputSchema: object;
    annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
    execute(input: unknown): unknown;
  }, options?: { signal?: AbortSignal }): void | Promise<void>;
}

function formatPrice(price: number): string {
  const tickSize = krwTickSize(price);
  const maximumFractionDigits = tickSize >= 1 ? 0 : Math.min(8, Math.ceil(-Math.log10(tickSize)));
  return `${new Intl.NumberFormat('ko-KR', { maximumFractionDigits }).format(price)}원`;
}

function formatCompactKrw(value: number): string {
  if (value >= 1_000_000_000_000) return `${(value / 1_000_000_000_000).toFixed(1)}조원`;
  if (value >= 100_000_000) return `${Math.round(value / 100_000_000).toLocaleString('ko-KR')}억원`;
  return `${Math.round(value / 10_000).toLocaleString('ko-KR')}만원`;
}

function formatKst(timestamp: number): string {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timestamp);
}

function remainingText(expiresAt: number, now: number): string {
  const minutes = Math.max(0, Math.ceil((expiresAt - now) / 60_000));
  if (minutes === 0) return '만료됨';
  if (minutes >= 60) return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
  return `${minutes}분`;
}

function regimeLabel(payload: DashboardPayload): { label: string; className: string } {
  if (payload.marketRegime === 'BULLISH') return { label: '▲ 상승 우위', className: 'text-rise' };
  if (payload.marketRegime === 'RISK_OFF') return { label: '▼ 매수 제한', className: 'text-fall' };
  return { label: '― 중립', className: 'text-warning' };
}

function CandidateCard({
  candidate,
  selected,
  onSelect,
}: {
  candidate: Candidate;
  selected: boolean;
  onSelect: () => void;
}) {
  const isUp = candidate.signedChangeRate >= 0;
  return (
    <Card className={`signal-card bg-card/80 py-0 ${selected ? 'selected-card' : ''}`} size="sm">
      <CardHeader className="border-b border-border/70 py-4">
        <div>
          <div className="flex items-center gap-2">
            <CardTitle className="text-base font-semibold">{candidate.koreanName}</CardTitle>
            <span className="font-mono text-xs text-muted-foreground">{candidate.market}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            <Badge className="bg-signal/15 text-signal" variant="outline">{candidate.setup === 'breakout' ? '돌파형' : '눌림목형'}</Badge>
            <span className={isUp ? 'text-rise' : 'text-fall'}>
              {isUp ? <ArrowUpRight className="inline size-4" /> : <ArrowDownRight className="inline size-4" />}
              {isUp ? '+' : ''}{(candidate.signedChangeRate * 100).toFixed(2)}%
            </span>
            <span className="text-xs text-muted-foreground">24h {formatCompactKrw(candidate.quoteVolume24h)}</span>
          </div>
        </div>
        <div className="score-pill" aria-label={`추천 점수 ${candidate.score}점, ${candidate.rank}위`}>
          <strong>{candidate.score}</strong><span>점</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 py-4">
        <div className="price-grid">
          <div className="col-span-2"><span>매수 구간</span><strong>{formatPrice(candidate.plan.entryLow)} ~ {formatPrice(candidate.plan.entryHigh)}</strong></div>
          <div><span>대표가 기준 손절 · {candidate.plan.riskPct.toFixed(2)}%</span><strong className="text-fall">{formatPrice(candidate.plan.stop)}</strong></div>
          <div><span>1차 수익 여력 · 비용 전 {candidate.plan.grossReturns?.[0]?.toFixed(2) ?? '—'}%</span><strong className="text-rise">{formatPrice(candidate.plan.targets[0])}</strong></div>
        </div>
        <div className="flex flex-wrap gap-2">
          {candidate.reasons.slice(0, 3).map((reason) => <span className="reason-chip" key={reason}>{reason}</span>)}
        </div>
        {candidate.warnings.filter(warning => warning.startsWith('호가 스프레드 ')).map(warning => (
          <p className="text-sm text-warning" key={warning}><AlertTriangle className="mr-1 inline size-4" />{warning}</p>
        ))}
        <Button className="h-11 w-full justify-between" onClick={onSelect} variant="outline">
          <span className="lg:hidden">차트와 가격 계획 보기</span><span className="hidden lg:inline">{selected ? '표시 중인 차트로 이동' : '오른쪽에 차트·가격 계획 표시'}</span><BarChart3 />
        </Button>
      </CardContent>
    </Card>
  );
}

function CandidateDetail({ candidate, now }: { candidate: Candidate; now: number }) {
  const defaultUnit: CandleUnit = candidate.strategy === 'scalp' ? 15 : 240;
  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <span className="eyebrow">{candidate.strategy === 'scalp' ? '15분 단타' : '1~4시간 스윙'} · {candidate.rank}위</span>
          <h2 className="mt-2 text-xl font-bold">{candidate.koreanName} <span className="font-mono text-sm text-muted-foreground">{candidate.market}</span></h2>
          <p className="mt-1 font-mono text-lg font-semibold">{formatPrice(candidate.currentPrice)}</p>
        </div>
        <Badge className="bg-signal/15 text-signal" variant="outline">{candidate.score}점</Badge>
      </div>

      <Tabs className="mt-5" defaultValue={String(defaultUnit)}>
        <TabsList className="grid h-10 w-full grid-cols-3 border border-border bg-background/45 p-1">
          <TabsTrigger value="15">15분</TabsTrigger>
          <TabsTrigger value="60">1시간</TabsTrigger>
          <TabsTrigger value="240">4시간</TabsTrigger>
        </TabsList>
        {([15, 60, 240] as const).map((unit) => (
          <TabsContent className="mt-3" key={unit} value={String(unit)}><PriceChart candidate={candidate} unit={unit} /></TabsContent>
        ))}
      </Tabs>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="level-stat entry"><span>대표 매수가</span><strong>{formatPrice(candidate.plan.entryAnchor)}</strong></div>
        <div className="level-stat stop"><span>손절가</span><strong>{formatPrice(candidate.plan.stop)}</strong></div>
        {[0, 1, 2].map((index) => (
          <div className="level-stat target" key={index}><span>{index + 1}차 매도가</span><strong>{candidate.plan.targets[index] === undefined ? '산정 대기' : formatPrice(candidate.plan.targets[index])}</strong></div>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="detail-stat"><Clock3 /><span>신호 유효</span><strong>{remainingText(candidate.plan.expiresAt, now)}</strong></div>
        <div className="detail-stat"><ShieldCheck /><span>분할 순수익 여력</span><strong>{candidate.plan.netSplitReturn == null ? '산정 대기' : `${candidate.plan.netSplitReturn.toFixed(2)}%`}</strong></div>
        <div className="detail-stat"><Gauge /><span>RSI</span><strong>{candidate.metrics.rsi.toFixed(1)}</strong></div>
        <div className="detail-stat"><Signal /><span>거래대금</span><strong>{candidate.metrics.rvol.toFixed(2)}배</strong></div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <div className="evidence-box">
          <h3><CheckCircle2 />추천 근거</h3>
          <ul>{candidate.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        </div>
        <div className="evidence-box">
          <h3><Activity />지표 값</h3>
          <dl>
            <div><dt>ATR 변동성</dt><dd>{candidate.metrics.atrPct.toFixed(2)}%</dd></div>
            <div><dt>호가 스프레드 · 참고용</dt><dd>{candidate.metrics.spreadPct.toFixed(3)}%</dd></div>
            <div><dt>예상 슬리피지</dt><dd>{candidate.metrics.slippagePct.toFixed(3)}%</dd></div>
            {candidate.metrics.adx !== undefined && <div><dt>ADX</dt><dd>{candidate.metrics.adx.toFixed(1)}</dd></div>}
            {candidate.metrics.activityRatio !== undefined && <div><dt>평소 대비 24h 거래대금</dt><dd>{candidate.metrics.activityRatio.toFixed(2)}배</dd></div>}
          </dl>
        </div>
      </div>

      {candidate.plan.version === 'confluence-v3' && (
        <section className="mt-5 space-y-3 rounded-xl border border-border p-4 text-sm" aria-label="가격 계획 산정 근거">
          <h3 className="font-semibold">가격 계획 산정 근거</h3>
          <p>매수. {candidate.plan.entryReason}.</p><p>손절. {candidate.plan.stopReason}.</p>
          {[0, 1, 2].map(index => {
            const evidence = candidate.plan.targetEvidence?.[index];
            return <div className="border-t border-border pt-2" key={index}>
              <p className="font-semibold">{index + 1}차. {evidence ? (evidence.kind === 'resistance' ? '가격 구조 포함 구간' : '예상 확장 구간') : '목표 근거 산정 대기'}</p>
              {evidence && <><p>{evidence.reasons.join(' · ')}</p><p className="text-muted-foreground">비용 전 {candidate.plan.grossReturns?.[index]?.toFixed(2)}% · 비용 가정 후 {candidate.plan.netReturns?.[index]?.toFixed(2)}%</p></>}
            </div>;
          })}
          <p className="text-xs text-muted-foreground">도달 확률을 반영한 기대수익이 아닙니다. 분할 수익은 각 목표에서 1/3씩 모두 매도했을 때입니다. 미래 매도 비용은 현재 매수 슬리피지와 같은 비율로 가정하며 실제 체결 비용과 다를 수 있습니다.</p>
          <p className="text-xs text-muted-foreground">계획 발행 {formatKst(candidate.plan.issuedAt ?? candidate.signalTime)} KST · 가격 고정 · 2차 손익비 {candidate.plan.targets.length > 1 ? `${candidate.plan.netRewardRiskAtTarget2.toFixed(2)}R (참고용)` : '산정 대기'}</p>
        </section>
      )}
      {candidate.warnings.length > 0 && (
        <Alert className="mt-4 border-warning/30 bg-warning/8 text-warning-foreground">
          <AlertTriangle /><AlertTitle>주의할 점</AlertTitle><AlertDescription>{candidate.warnings.join(' · ')}</AlertDescription>
        </Alert>
      )}
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">표시 가격은 규칙 기반 분석 결과이며 주문은 자동으로 실행되지 않습니다. 급변 시 실제 체결 가격이 달라질 수 있습니다.</p>
    </div>
  );
}

function LoadingCards() {
  return <div className="space-y-3">{[0, 1, 2].map((key) => <Skeleton className="h-[280px] rounded-xl bg-card" key={key} />)}</div>;
}

export function Dashboard() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [activeStrategy, setActiveStrategy] = useState<Strategy>('scalp');
  const [selectedMarket, setSelectedMarket] = useState<string | null>(null);
  const [watchPage, setWatchPage] = useState(0);
  const [watchQuery, setWatchQuery] = useState('');
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [compactLayout, setCompactLayout] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const [message, setMessage] = useState('업비트 데이터를 불러오는 중입니다.');
  const dataRef = useRef<DashboardPayload | null>(null);

  const load = useCallback(async (refresh = false, silent = false) => {
    if (!silent) {
      setState((current) => current === 'loading' ? 'loading' : 'refreshing');
      setMessage(refresh ? '원화마켓을 다시 분석하고 있습니다.' : '업비트 데이터를 불러오는 중입니다.');
    }
    try {
      const response = await fetch(refresh ? '/api/refresh' : '/api/recommendations', {
        method: refresh ? 'POST' : 'GET',
        cache: 'no-store',
      });
      const payload = await response.json() as DashboardPayload | { error?: string };
      if (!response.ok || !('generatedAt' in payload)) throw new Error(payload.error ?? '추천 데이터를 불러오지 못했습니다.');
      dataRef.current = payload;
      setData(payload);
      setState('ready');
      if (!silent) setMessage(payload.source === 'cached' ? '저장된 최신 분석 결과를 표시합니다.' : '새 분석이 완료되었습니다.');
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : '추천 데이터를 불러오지 못했습니다.';
      if (dataRef.current) {
        const now = Date.now();
        const degraded = {
          ...dataRef.current,
          stale: true,
          error: failureMessage,
          scalp: [],
          swing: [],
        };
        dataRef.current = degraded;
        setClock(now);
        setData(degraded);
        setState('ready');
      } else {
        setState('error');
      }
      setMessage(failureMessage);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load(false));
    const refreshVisibleDashboard = () => {
      if (document.visibilityState !== 'visible') return;
      setClock(Date.now());
      void load(false, true);
    };
    const interval = window.setInterval(refreshVisibleDashboard, 60_000);
    document.addEventListener('visibilitychange', refreshVisibleDashboard);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refreshVisibleDashboard);
    };
  }, [load]);
  useEffect(() => {
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');
  }, []);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1023px)');
    const syncLayout = () => setCompactLayout(query.matches);
    query.addEventListener('change', syncLayout);
    queueMicrotask(syncLayout);
    return () => query.removeEventListener('change', syncLayout);
  }, []);
  useEffect(() => {
    const modelContext = (document as Document & { modelContext?: ModelContextLike }).modelContext;
    if (!modelContext?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(modelContext.registerTool({
      name: 'get_current_recommendations',
      title: '현재 추천 조회',
      description: '화면에 표시된 최신 단타 또는 스윙 추천을 구조화된 데이터로 조회합니다.',
      inputSchema: {
        type: 'object',
        properties: { strategy: { type: 'string', enum: ['scalp', 'swing'] } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute(input) {
        const strategy = (input as { strategy?: unknown } | null)?.strategy;
        if (strategy !== undefined && strategy !== 'scalp' && strategy !== 'swing') throw new Error('strategy는 scalp 또는 swing이어야 합니다.');
        const current = dataRef.current;
        if (!current) return { status: 'loading', candidates: [] };
        const candidates = strategy ? current[strategy] : [...current.scalp, ...current.swing];
        return {
          generatedAt: current.generatedAt,
          stale: current.stale,
          marketRegime: current.marketRegime,
          candidates: candidates.map((candidate) => ({
            market: candidate.market,
            name: candidate.koreanName,
            strategy: candidate.strategy,
            score: candidate.score,
            entry: candidate.plan.entryAnchor,
            stop: candidate.plan.stop,
            targets: candidate.plan.targets,
          })),
        };
      },
    }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, []);

  const activeCandidates = useMemo(() => data?.[activeStrategy] ?? [], [activeStrategy, data]);
  const selectedCandidate = useMemo(
    () => activeCandidates.find((candidate) => candidate.market === selectedMarket) ?? activeCandidates[0] ?? null,
    [activeCandidates, selectedMarket],
  );
  const regime = data ? regimeLabel(data) : null;
  const degraded = state === 'error' || Boolean(data?.stale);
  const watchRows = (data?.watchlist ?? []).filter(row => row.strategy === activeStrategy
    && `${row.market} ${row.koreanName} ${row.reason}`.toLowerCase().includes(watchQuery.toLowerCase()));
  const pageCount = Math.max(1, Math.ceil(watchRows.length / 10));
  const currentWatchPage = Math.min(watchPage, pageCount - 1);

  const chooseCandidate = (candidate: Candidate) => {
    setSelectedMarket(candidate.market);
    if (compactLayout) setMobileDetailOpen(true);
    else requestAnimationFrame(() => document.getElementById('candidate-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="ambient-grid" aria-hidden="true" />
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1280px] items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="brand-mark"><Activity /></div>
            <div><h1 className="text-base font-bold tracking-tight">KRW 퀀트 레이더</h1><p className="text-xs text-muted-foreground">업비트 원화마켓 · 추천 전용</p></div>
          </div>
          <Button aria-label="추천 새로고침" className="h-11 px-3" disabled={state === 'loading' || state === 'refreshing'} onClick={() => void load(true)} variant="outline">
            <RefreshCcw className={state === 'refreshing' ? 'animate-spin' : ''} /><span className="hidden sm:inline">새로고침</span>
          </Button>
        </div>
      </header>

      <div className="relative mx-auto max-w-[1280px] px-4 py-5 sm:px-6 sm:py-7">
        <section aria-labelledby="market-status" className="status-panel">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <span className={degraded ? 'stale-dot' : 'live-dot'} />
              <span className={`text-xs font-semibold tracking-wide ${degraded ? 'text-warning' : 'text-signal'}`}>{state === 'error' ? '연결 오류' : data?.stale ? '데이터 지연됨' : state === 'refreshing' ? '갱신 중' : '데이터 정상'}</span>
            </div>
            <h2 className="text-xl font-bold tracking-tight sm:text-2xl" id="market-status">
              {data ? (data.stale ? '분석 갱신을 기다리고 있습니다' : data.scalp.length + data.swing.length > 0 ? '조건을 통과한 매수 후보입니다' : (data.coverage.pendingMarketCount ?? 0) > 0 ? '전체시장을 순차 분석하고 있습니다' : '현재 분석 범위에서 진입 신호를 기다립니다') : '원화마켓을 분석하고 있습니다'}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{data?.notice ?? '첫 묶음을 준비 중입니다. 전체 수집은 여러 번의 갱신에 걸쳐 진행됩니다.'}</p>
          </div>
          <div className="market-metrics">
            <div><span>BTC 시장</span><strong className={regime?.className}>{regime?.label ?? '확인 중'}</strong></div>
            <div><span>주의·경고 제외 순회</span><strong>{data ? `${data.coverage.analyzedMarketCount}/${data.coverage.eligibleMarketCount}종목` : '—'}</strong></div>
            <div><span>마지막 분석</span><strong>{data ? `${formatKst(data.generatedAt)} KST` : '—'}</strong></div>
          </div>
        </section>

        {data?.schemaVersion === 3 && (
          <section className="mt-4 rounded-xl border border-border bg-card/55 p-4 text-sm" aria-label="전체시장 분석 진행률">
            <div className="flex flex-wrap justify-between gap-2">
              <span>전체 {data.coverage.krwMarketCount}개 · 주의·경고 제외 {data.rejections.marketWarning}개</span>
              <span>미분석 {data.coverage.pendingMarketCount}개 · 분석 지연 {data.coverage.delayedMarketCount}개 · 이력 충족 {data.coverage.completedMarketCount}개</span>
            </div>
            <progress className="mt-3 h-2 w-full accent-lime-400" max={data.coverage.eligibleMarketCount || 1} value={data.coverage.analyzedMarketCount} aria-label="전체 종목 최초 분석 진행률" />
            <p className="mt-2 text-xs text-muted-foreground">매분 다음 묶음을 분석합니다. 원본 TT용 800봉 이력을 순차 확보하므로 최초 전체 준비는 1시간 이상 걸릴 수 있습니다. 분석 후 20분이 지난 종목은 진입 후보에서 제외합니다. 현재가 갱신 {formatKst(data.priceUpdatedAt ?? data.generatedAt)} KST.</p>
          </section>
        )}

        {(state === 'error' || data?.error) && (
          <Alert className="mt-4 border-warning/30 bg-warning/8 text-warning-foreground">
            {state === 'error' ? <WifiOff /> : <AlertTriangle />}
            <AlertTitle>{data ? '최근 정상 결과를 유지합니다' : '데이터를 불러오지 못했습니다'}</AlertTitle>
            <AlertDescription>{data?.error ?? message}</AlertDescription>
          </Alert>
        )}

        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,0.92fr)_minmax(420px,1.08fr)]">
          <Tabs className="min-w-0" onValueChange={(value) => { setActiveStrategy(value as Strategy); setSelectedMarket(null); setWatchPage(0); }} value={activeStrategy}>
            <TabsList className="sticky top-[69px] z-10 grid h-12 w-full grid-cols-2 border border-border bg-card/95 p-1 backdrop-blur">
              <TabsTrigger className="text-[15px]" value="scalp">15분 단타 <Badge variant="secondary">{data?.scalp.length ?? 0}</Badge></TabsTrigger>
              <TabsTrigger className="text-[15px]" value="swing">1~4시간 스윙 <Badge variant="secondary">{data?.swing.length ?? 0}</Badge></TabsTrigger>
            </TabsList>
            {(['scalp', 'swing'] as const).map((strategy) => (
              <TabsContent className="mt-4 space-y-3" key={strategy} value={strategy}>
                {state === 'loading' && <LoadingCards />}
                {state !== 'loading' && (data?.[strategy].length ?? 0) === 0 && (
                  <Empty className="min-h-[320px] border border-border bg-card/55">
                    <EmptyHeader>
                      <EmptyMedia className="size-11 rounded-xl text-muted-foreground" variant="icon"><Signal /></EmptyMedia>
                      <EmptyTitle className="text-base">현재 {strategy === 'scalp' ? '단타' : '스윙'} 매수 후보가 없습니다</EmptyTitle>
                      <EmptyDescription>아래 관찰·대기 목록에서 종목별 미충족 조건을 확인할 수 있습니다. 미분석 종목은 순차적으로 추가됩니다.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
                {data?.[strategy].map((candidate) => (
                  <CandidateCard candidate={candidate} key={candidate.market} onSelect={() => chooseCandidate(candidate)} selected={selectedCandidate?.market === candidate.market} />
                ))}
              </TabsContent>
            ))}
          </Tabs>

          <aside id="candidate-detail" className="detail-panel hidden scroll-mt-20 lg:block" aria-label="선택 종목 상세">
            {selectedCandidate ? <CandidateDetail candidate={selectedCandidate} now={clock} /> : (
              <Empty className="min-h-[470px]"><EmptyHeader><EmptyMedia variant="icon"><BarChart3 /></EmptyMedia><EmptyTitle>표시할 후보가 없습니다</EmptyTitle><EmptyDescription>조건을 통과한 종목이 생기면 차트와 가격 계획이 여기에 표시됩니다.</EmptyDescription></EmptyHeader></Empty>
            )}
          </aside>
        </div>

        <section className="mt-6 rounded-xl border border-border bg-card/60 p-4 sm:p-5" aria-label="관찰 및 대기 종목">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h2 className="font-semibold">{activeStrategy === 'scalp' ? '15분 단타' : '1~4시간 스윙'} 관찰·대기 {watchRows.length}개</h2>
              <p className="mt-1 text-xs text-muted-foreground">매수 추천이 아닙니다. 상승 구조 점수가 높은 순서이며 아직 충족하지 못한 조건을 표시합니다.</p></div>
            <input className="h-10 rounded-md border border-border bg-background px-3 text-sm" aria-label="관찰 종목 또는 사유 검색" placeholder="종목·대기 사유 검색" value={watchQuery} onChange={event => { setWatchQuery(event.target.value); setWatchPage(0); }} />
          </div>
          <div className="mt-4 space-y-2">
            {watchRows.slice(currentWatchPage * 10, currentWatchPage * 10 + 10).map(row => (
              <div className="grid gap-2 rounded-lg border border-border/60 p-3 sm:grid-cols-[1fr_1fr_2fr]" key={`${row.market}:${row.strategy}`}>
                <div><strong className="text-sm">{row.koreanName}</strong><span className="ml-2 text-xs text-muted-foreground">{row.market}</span></div>
                <div className="text-sm">{formatPrice(row.currentPrice)}<span className="ml-2 text-xs text-muted-foreground">24h {formatCompactKrw(row.quoteVolume24h)}</span></div>
                <div><p className="text-sm text-warning">{row.reason}</p><p className="mt-1 text-xs text-muted-foreground">분석 {formatKst(row.analyzedAt)} KST</p></div>
              </div>
            ))}
            {watchRows.length === 0 && <p className="py-4 text-sm text-muted-foreground">아직 표시할 관찰 결과가 없습니다. 분석 진행률을 확인해 주세요.</p>}
          </div>
          <div className="mt-3 flex items-center justify-end gap-3 text-sm">
            <Button variant="outline" disabled={currentWatchPage === 0} onClick={() => setWatchPage(currentWatchPage - 1)}>이전</Button>
            <span>{currentWatchPage + 1} / {pageCount}</span>
            <Button variant="outline" disabled={currentWatchPage + 1 >= pageCount} onClick={() => setWatchPage(currentWatchPage + 1)}>다음</Button>
          </div>
        </section>

        {data?.diagnostics && (
          <details className="mt-4 rounded-xl border border-border p-4 text-sm">
            <summary className="cursor-pointer font-semibold">조건별 대기 사유와 기준 비교</summary>
            <p className="mt-3 text-xs text-muted-foreground">사유는 종목×전략별 첫 미충족 조건입니다. 한 종목이 단타·스윙에 각각 집계됩니다.</p>
            <div className="mt-3 flex flex-wrap gap-2">{Object.entries(data.diagnostics).sort((a, b) => b[1] - a[1]).map(([code, count]) => <span className="reason-chip" key={code}>{REASONS[code] ?? code} · {count}</span>)}</div>
            {data.comparison && <p className="mt-4">기존 기준 {data.comparison.legacy}개 / 개선 기준 {data.comparison.improved}개. {data.comparison.note}</p>}
            <p className="mt-3 text-xs text-muted-foreground">모의 성과는 버전별로 분리합니다. 산정된 목표에서 각각 1/3씩 청산하고, 목표가 없는 잔량은 손절 또는 보유기한에 청산합니다. 동일 봉 진입·청산이나 목표·손절 동시 도달은 불명확으로 분리하며 종료 평균에서 제외되어 편향될 수 있습니다. 과거 전체 기간 백테스트나 실제 체결 성과가 아닙니다.</p>
            {(data.paper ?? []).map(stat => <p className="mt-2" key={stat.variant}>{stat.variant === 'confluence-v3' ? '구조 목표 v3' : stat.variant === 'pre-confluence-v2' ? '이전 R목표 비교군' : `이전 기록 (${stat.variant})`} · 모의 기록 {stat.total}건 · 진입 대기 {stat.pending} · 보유 {stat.open} · 종료 {stat.closed} · 불명확/누락 {stat.ambiguous} · 종료 평균 {stat.meanNetPct === null ? '집계 대기' : `${stat.meanNetPct.toFixed(2)}%`}</p>)}
          </details>
        )}

        <footer className="mt-8 border-t border-border py-5 text-xs leading-relaxed text-muted-foreground">
          추천 점수는 성공 확률이 아닌 후보 간 상대 순위입니다. 본 서비스는 투자 판단을 보조하며 수익을 보장하지 않습니다.
          <a className="ml-2 underline" href="/indicator-notices.txt" target="_blank" rel="noreferrer">지표 출처·이용 조건</a>
          <span aria-live="polite" className="sr-only">{message}</span>
        </footer>
      </div>

      {compactLayout && (
        <Sheet onOpenChange={setMobileDetailOpen} open={mobileDetailOpen}>
          <SheetContent className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border-border bg-card p-0 sm:max-w-full" side="bottom">
            <SheetHeader className="border-b border-border px-5 py-4">
              <SheetTitle>후보 상세 분석</SheetTitle>
              <SheetDescription>차트, 진입 구간, 손절가와 분할 매도가를 확인합니다.</SheetDescription>
            </SheetHeader>
            <div className="p-5">{selectedCandidate && <CandidateDetail candidate={selectedCandidate} now={clock} />}</div>
          </SheetContent>
        </Sheet>
      )}
    </main>
  );
}
