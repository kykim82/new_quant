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
          <div><span>대표가 기준 2차 · {candidate.plan.netRewardRiskAtTarget2.toFixed(1)}R</span><strong className="text-rise">{formatPrice(candidate.plan.targets[1])}</strong></div>
        </div>
        <div className="flex flex-wrap gap-2">
          {candidate.reasons.slice(0, 3).map((reason) => <span className="reason-chip" key={reason}>{reason}</span>)}
        </div>
        <Button className="h-11 w-full justify-between" onClick={onSelect} variant="outline">
          차트와 가격 계획 보기<BarChart3 />
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
        {candidate.plan.targets.map((target, index) => (
          <div className="level-stat target" key={target}><span>{index + 1}차 매도가</span><strong>{formatPrice(target)}</strong></div>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="detail-stat"><Clock3 /><span>신호 유효</span><strong>{remainingText(candidate.plan.expiresAt, now)}</strong></div>
        <div className="detail-stat"><ShieldCheck /><span>2차 손익비</span><strong>{candidate.plan.netRewardRiskAtTarget2.toFixed(2)} R</strong></div>
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
            <div><dt>호가 스프레드</dt><dd>{candidate.metrics.spreadPct.toFixed(3)}%</dd></div>
            <div><dt>예상 슬리피지</dt><dd>{candidate.metrics.slippagePct.toFixed(3)}%</dd></div>
            {candidate.metrics.adx !== undefined && <div><dt>ADX</dt><dd>{candidate.metrics.adx.toFixed(1)}</dd></div>}
          </dl>
        </div>
      </div>

      {candidate.warnings.length > 0 && (
        <Alert className="mt-4 border-warning/30 bg-warning/8 text-warning-foreground">
          <AlertTriangle /><AlertTitle>주의할 점</AlertTitle><AlertDescription>{candidate.warnings.join(' · ')}</AlertDescription>
        </Alert>
      )}
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">표시 가격은 확률 기반 분석 결과이며 주문은 자동으로 실행되지 않습니다. 급변 시 실제 체결 가격이 달라질 수 있습니다.</p>
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
          scalp: dataRef.current.scalp.filter((candidate) => candidate.plan.expiresAt > now),
          swing: dataRef.current.swing.filter((candidate) => candidate.plan.expiresAt > now),
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

  const chooseCandidate = (candidate: Candidate) => {
    setSelectedMarket(candidate.market);
    if (compactLayout) setMobileDetailOpen(true);
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
              {data ? (data.scalp.length + data.swing.length > 0 ? '조건을 통과한 매수 후보입니다' : '현재 기준을 충족한 후보가 없습니다') : '원화마켓을 분석하고 있습니다'}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{data?.notice ?? '첫 분석은 약 10~20초가 걸릴 수 있습니다.'}</p>
          </div>
          <div className="market-metrics">
            <div><span>BTC 시장</span><strong className={regime?.className}>{regime?.label ?? '확인 중'}</strong></div>
            <div><span>분석 범위</span><strong>{data ? `${data.coverage.analyzedMarketCount}/${data.coverage.krwMarketCount}종목` : '—'}</strong></div>
            <div><span>마지막 분석</span><strong>{data ? `${formatKst(data.generatedAt)} KST` : '—'}</strong></div>
          </div>
        </section>

        {(state === 'error' || data?.error) && (
          <Alert className="mt-4 border-warning/30 bg-warning/8 text-warning-foreground">
            {state === 'error' ? <WifiOff /> : <AlertTriangle />}
            <AlertTitle>{data ? '최근 정상 결과를 유지합니다' : '데이터를 불러오지 못했습니다'}</AlertTitle>
            <AlertDescription>{data?.error ?? message}</AlertDescription>
          </Alert>
        )}

        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,0.92fr)_minmax(420px,1.08fr)]">
          <Tabs className="min-w-0" onValueChange={(value) => { setActiveStrategy(value as Strategy); setSelectedMarket(null); }} value={activeStrategy}>
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
                      <EmptyDescription>기준을 낮춰 종목을 채우지 않습니다. 다음 완성 봉에서 다시 분석합니다.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
                {data?.[strategy].map((candidate) => (
                  <CandidateCard candidate={candidate} key={candidate.market} onSelect={() => chooseCandidate(candidate)} selected={selectedCandidate?.market === candidate.market} />
                ))}
              </TabsContent>
            ))}
          </Tabs>

          <aside className="detail-panel hidden lg:block" aria-label="선택 종목 상세">
            {selectedCandidate ? <CandidateDetail candidate={selectedCandidate} now={clock} /> : (
              <Empty className="min-h-[470px]"><EmptyHeader><EmptyMedia variant="icon"><BarChart3 /></EmptyMedia><EmptyTitle>표시할 후보가 없습니다</EmptyTitle><EmptyDescription>조건을 통과한 종목이 생기면 차트와 가격 계획이 여기에 표시됩니다.</EmptyDescription></EmptyHeader></Empty>
            )}
          </aside>
        </div>

        <footer className="mt-8 border-t border-border py-5 text-xs leading-relaxed text-muted-foreground">
          추천 점수는 성공 확률이 아닌 후보 간 상대 순위입니다. 본 서비스는 투자 판단을 보조하며 수익을 보장하지 않습니다.
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
