// 실제 급등 전 사례의 유사 후보와 하루 고정 평가 원장·비선정 비교군을 보존한다.
import {createHash} from 'node:crypto';
import {endOf, rawBars, covered, sma, mean} from './quant_core.mjs';
import {priorRise} from './surge_patterns.mjs';
import {CommonResearch,SEED,latestRecord,dailyDescription,scoreCommon,completedDate} from './surge_common.mjs';

export const BETA_RULE = 'surge-common-v1';
export const DAY = 86400000;
const HOUR = 3600000;
const pct = (value, base) => (value / base - 1) * 100;
const positive = value => Number.isFinite(value) && value > 0;
export const betaDay = now => new Date(endOf(1440, now)).toISOString().slice(0, 10);
export function freshBetaQuote(quote, now) {
  return quote && positive(quote.tradePrice) && Number.isFinite(quote.receivedAt)
    && now >= quote.receivedAt && now - quote.receivedAt <= 45000;
}

export function inspectBeta(market, cache, quote, now, record=latestRecord(SEED)) {
  const end = endOf(1440, now), meta = cache?.verified?.[1440], bars = rawBars(cache, 1440, end);
  const base = {market: market.market, name: market.koreanName, inspected: false, ready: false};
  if (!meta || meta.checkedThrough < end) return {...base, reason: '일봉 수집 중'};
  if(bars.length<400&&!meta.exhausted)return {...base,reason:'장기 공통점 비교용 일봉 수집 중'};
  base.inspected = true;
  if (bars.length < 63) return {...base, reason: '일봉 이력 부족'};
  if (!covered(cache, 1440, bars.at(-63).openTime, end) || bars.at(-1).closeTime !== end)
    return {...base, reason: '일봉 연결 확인 필요'};
  if (!freshBetaQuote(quote, now) || !positive(quote.dayOpen) || !positive(quote.dayHigh)
      || quote.dayHigh < Math.max(quote.dayOpen, quote.tradePrice) || endOf(1440, quote.receivedAt) !== end)
    return {...base, reason: '현재 시세 확인 중'};
  const ma = Object.fromEntries([7,20,60,100,200,365].map(n => [n, sma(bars, n)]));
  const slopes = Object.fromEntries([7,20,60,100].map(n => {
    const old = sma(bars, n, 3); return [n, old === null ? null : ma[n] - old];
  }));
  const current = quote.tradePrice, distance20 = pct(current, ma[20]), rise5 = pct(current, bars.at(-6).close);
  const riseHistory = priorRise(bars, {open:quote.dayOpen,high:quote.dayHigh,openTime:end});
  const recentSurge = riseHistory.alreadyRisen;
  const baseline = mean(bars.slice(-25, -5).map(b => b.baseVolume));
  const volume3 = baseline > 0 ? mean(bars.slice(-3).map(b => b.baseVolume)) / baseline : null;
  const volume5 = baseline > 0 ? mean(bars.slice(-5).map(b => b.baseVolume)) / baseline : null;
  const evidence = {dailyThrough: end, dailyBars: bars.length, ma, slopes, distance20, rise5, recentSurge,
    volume3, volume5, riseHistory, price: current, quoteAt: quote.receivedAt};
  if (recentSurge || distance20 > 12 || rise5 > 20)
    return {...base, ready: true, eligible: false, score: 0, evidence, reason: '이미 큰 상승 · 새 준비 후보 제외'};
  if(record.through!==completedDate(now)||record.createdAt>now)
    return {...base,reason:'오늘 적용할 누적 공통점 갱신 대기',evidence};
  const raw=bars.map(b=>({candle_date_time_utc:new Date(b.openTime).toISOString(),opening_price:b.open,
    high_price:b.high,low_price:b.low,trade_price:b.close,candle_acc_trade_volume:b.baseVolume,candle_acc_trade_price:b.quoteVolume}));
  const description=dailyDescription(raw,end,market.market),common=scoreCommon(description,record);
  if(!description.valid)return {...base,reason:'공통점 비교용 일봉 이력 확인 필요',evidence};
  const hourly=rawBars(cache,60,endOf(60,now)).slice(-21),last=hourly.at(-1);
  const flowKnown=hourly.length===21&&last.closeTime===endOf(60,now)
    &&covered(cache,60,hourly[0].openTime,last.closeTime);
  const average=flowKnown?mean(hourly.slice(0,-1).map(b=>b.baseVolume)):null;
  const flow=flowKnown&&average>0?last.close>last.open&&last.close>hourly.at(-2).close&&last.baseVolume>average:null;
  Object.assign(evidence,{description,common,flow,criterionThrough:record.through,criterionCreatedAt:record.createdAt});
  const reason=common.hits+'/'+common.total+'개 일치 · '+common.labels.join(' · ');
  return {...base, ready: true, eligible: common.total>0, score:common.score, evidence,
    reason,commonHits:common.hits,commonTotal:common.total,commonKnown:common.known,
    flowRank:flow===true?2:flow===false?1:0,flowLabel:flow===true?'가격·거래량 동반 상승':flow===false?'동반 상승 미확인':'1시간 이력 확인 중',
    quote, quoteVolume24h: quote.quoteVolume24h};
}

export function makeBetaCohort(assessments, now, record=latestRecord(SEED)) {
  const pool = assessments.filter(a => a.ready && a.eligible);
  const ranked = [...pool].sort((a,b) => b.score - a.score
    || (b.commonKnown??0)-(a.commonKnown??0) || (b.flowRank??0)-(a.flowRank??0)
    || (b.evidence?.volume3??-Infinity)-(a.evidence?.volume3??-Infinity)
    || (b.quoteVolume24h ?? 0) - (a.quoteVolume24h ?? 0) || a.market.localeCompare(b.market));
  const selected = ranked.filter(a => a.commonHits>0).slice(0, 10), markets = new Set(selected.map(a => a.market));
  const day = betaDay(now), hash = a => createHash('sha256').update(day + ':' + a.market).digest('hex');
  const controls = pool.filter(a => !markets.has(a.market)).sort((a,b) => hash(a).localeCompare(hash(b))).slice(0, 10);
  const recordRow = (a, role, index) => ({market: a.market, name: a.name, role, rank: index + 1, score: a.score,
    commonHits:a.commonHits,commonTotal:a.commonTotal,commonKnown:a.commonKnown,flowLabel:a.flowLabel,
    reason: a.reason, selectedAt: now, entryPrice: a.quote.tradePrice, quoteAt: a.quote.receivedAt,
    evidence: a.evidence, windows: Object.fromEntries([24,72].map(hours => [hours, {
      high: a.quote.tradePrice, low: a.quote.tradePrice, hit30At: null, returnPrice: null,
      returnAt: null, lastObservationAt: now, closed: false
    }]))});
  return {id: BETA_RULE + ':' + day, rule: BETA_RULE, day, selectedAt: now, sourceDayThrough: endOf(1440, now),
    criterion:{through:record.through,createdAt:record.createdAt,cases:record.cases,dailyReady:record.dailyReady,
      commonIds:record.commonIds,features:record.features.filter(f=>record.commonIds.includes(f.id))},
    universe: assessments.length, ready: assessments.filter(a => a.ready).length,
    excluded: assessments.filter(a => !a.eligible).map(a => ({market: a.market, reason: a.reason})),
    selected: selected.map((a,i) => recordRow(a, 'candidate', i)),
    controls: controls.map((a,i) => recordRow(a, 'control', i)), savedAt: null};
}

export function observeBeta(cohort, caches, quotes, now) {
  const next = structuredClone(cohort);
  for (const row of [...next.selected, ...next.controls]) {
    const quote = quotes.get(row.market), bars = rawBars(caches.get(row.market), 60, now);
    if (cohort.rule === BETA_RULE && !row.preparationEndedAt && freshBetaQuote(quote, now)
        && positive(quote.dayOpen) && positive(quote.dayHigh)) {
      const daily = rawBars(caches.get(row.market), 1440, endOf(1440, now));
      if (daily.length >= 20 && priorRise(daily, {open:quote.dayOpen,high:quote.dayHigh,openTime:endOf(1440,now)}).alreadyRisen)
        row.preparationEndedAt = now;
    }
    for (const [hours, window] of Object.entries(row.windows)) {
      const until = row.selectedAt + Number(hours) * HOUR;
      const observe = (high, low, at) => {
        window.high = Math.max(window.high, high); window.low = Math.min(window.low, low);
        if (high >= row.entryPrice * 1.3) window.hit30At = Math.min(window.hit30At ?? at, at);
        window.lastObservationAt = Math.max(window.lastObservationAt, at);
      };
      // 선정이 포함된 부분 시간봉과 평가 기간 밖 봉은 사전 고가 혼입 때문에 제외한다.
      for (const b of bars) if (b.openTime >= row.selectedAt && b.closeTime <= Math.min(until, now))
        observe(b.high, b.low, b.closeTime);
      if (freshBetaQuote(quote, now) && quote.receivedAt > row.selectedAt && quote.receivedAt <= until)
        observe(quote.tradePrice, quote.tradePrice, quote.receivedAt);
      if (window.returnAt === null && freshBetaQuote(quote, now)
          && quote.receivedAt >= until && quote.receivedAt <= until + 120000) {
        window.returnPrice = quote.tradePrice; window.returnAt = quote.receivedAt;
      }
      window.closed = now >= until;
    }
  }
  return next;
}

export class SurgeBeta {
  constructor() {
    this.research = new CommonResearch();
    this.cohorts = new Map(); this.attempts = new Map(); this.ready = false; this.error = null;
    this.initAttempt = -Infinity; this.lastWrite = -Infinity; this.scanned = 0; this.total = 0;
  }
  async init(radar) {
    this.initAttempt = radar.clock();
    try {
      await radar.db.batch([
        radar.db.prepare('CREATE TABLE IF NOT EXISTS surge_beta_cohorts (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, payload_json TEXT NOT NULL)'),
        radar.db.prepare('CREATE INDEX IF NOT EXISTS surge_beta_created ON surge_beta_cohorts(created_at)')
      ]);
      const rows = await radar.db.prepare('SELECT payload_json FROM surge_beta_cohorts WHERE created_at>=? ORDER BY created_at DESC')
        .bind(radar.clock() - 7 * DAY).all();
      const restored = new Map();
      for (const row of rows.results) {const c = JSON.parse(row.payload_json); restored.set(c.id, c);}
      this.cohorts = restored; this.ownerToken = radar.token;
      this.ready = true; this.error = null;
    } catch (e) {this.error = '베타 기록 DB 확인 실패. ' + e.message;}
  }
  observe(radar) {
    const now = radar.clock();
    for (const [id,c] of this.cohorts) {
      if (c.selectedAt < now - 7 * DAY) {this.cohorts.delete(id); continue;}
      this.cohorts.set(id, observeBeta(c, radar.caches, radar.quotes, now));
    }
  }
  async save(radar, cohort, create = false) {
    const saved = {...cohort, savedAt: radar.clock()};
    if (create) {
      await radar.db.prepare('INSERT OR IGNORE INTO surge_beta_cohorts VALUES (?,?,?)')
        .bind(saved.id, saved.selectedAt, JSON.stringify(saved)).run();
      const first = await radar.db.prepare('SELECT payload_json FROM surge_beta_cohorts WHERE id=?').bind(saved.id).first();
      return JSON.parse(first.payload_json);
    }
    await radar.db.prepare('UPDATE surge_beta_cohorts SET payload_json=? WHERE id=? AND created_at=?')
      .bind(JSON.stringify(saved), saved.id, saved.selectedAt).run();
    return saved;
  }
  async run(radar, collectDaily, {maxRequests = 4, budgetMs = 2500} = {}) {
    const start = radar.clock();
    this.research.clock=radar.clock;
    void this.research.tick(radar.db);
    if (this.ready && this.ownerToken !== radar.token) {this.ready = false; this.initAttempt = -Infinity;}
    if (!this.ready && start - this.initAttempt >= 60000) await this.init(radar);
    if (!this.ready) return;
    this.observe(radar);
    try {
      const id = BETA_RULE + ':' + betaDay(start);
      const allowed = radar.exclusions.ready && start >= radar.exclusions.checkedAt && start - radar.exclusions.checkedAt <= 120000;
      if (!this.cohorts.has(id) && allowed && radar.markets.length && this.research.status().current && !this.research.error) {
        const markets = radar.markets.filter(m => !m.warned && m.market !== 'KRW-USDT');
        this.total = markets.length;
        const end = endOf(1440, start);
        const needsDaily=m=>{const cache=radar.caches.get(m.market),meta=cache?.verified?.[1440];
          return (meta?.checkedThrough??0)<end||(!meta?.exhausted&&rawBars(cache,1440,end).length<400);};
        const pending = markets.filter(needsDaily)
          .sort((a,b) => (this.attempts.get(a.market) ?? 0) - (this.attempts.get(b.market) ?? 0) || a.market.localeCompare(b.market));
        let requests = 0;
        for (const info of pending) {
          if (requests >= maxRequests || radar.clock() - start >= budgetMs || endOf(15, radar.clock()) !== endOf(15, start)) break;
          if (radar.clock() - (this.attempts.get(info.market) ?? -Infinity) < 60000) continue;
          this.attempts.set(info.market, radar.clock());
          radar.stage('베타 일봉 수집', info.market, 1440);
          const cache = await radar.load(info.market);
          if (needsDaily(info)) {
            requests++;
            const changed = await collectDaily(cache, info.market, radar.clock());
            if (changed) radar.dirty.add(info.market);
          }
          radar.progress('베타 일봉 확인 완료');
        }
        const now = radar.clock();
        const criterion=latestRecord(this.research.model);
        const assessments = markets.map(m => inspectBeta(m, radar.caches.get(m.market), radar.quotes.get(m.market), now,criterion));
        this.scanned = assessments.filter(a => a.inspected).length;
        // 시장 전체의 일봉 조회가 끝난 뒤 한 번 확정한다. 시세 장애로 빈 원장을 확정하지 않는다.
        if (betaDay(now) === betaDay(start) && this.scanned === markets.length && assessments.some(a => a.ready)) {
          const cohort = makeBetaCohort(assessments, now,criterion);
          this.cohorts.set(cohort.id, await this.save(radar, cohort, true));
          radar.snapshotSavedAt = 0;
        }
      }
      if (radar.clock() - this.lastWrite >= 300000) {
        for (const [key,c] of this.cohorts) {
          // 만료 후 1일까지만 늦게 도착한 완료봉을 보충하며 원본은 DB에 계속 남긴다.
          if (radar.clock() - c.selectedAt <= 4 * DAY) {
            const saved = await this.save(radar, c);
            const live = this.cohorts.get(key);
            this.cohorts.set(key, {...live, savedAt: saved.savedAt});
          }
        }
        this.lastWrite = radar.clock();
      }
      this.error = null;
    } catch (e) {
      this.error = '베타 수집·기록 재시도 대기. ' + e.message;
      if (e.status === 429 || e.status === 418) this.attempts = new Map(radar.markets.map(m => [m.market, radar.clock()]));
    }
  }
  snapshot(radar) {
    const now = radar.clock(), current = this.cohorts.get(BETA_RULE + ':' + betaDay(now));
    const publicRow = ({evidence, ...row}) => row;
    const display = row => ({...publicRow(row), quote: freshBetaQuote(radar.quotes.get(row.market), now) ? radar.quotes.get(row.market) : null});
    return {rule: BETA_RULE, experimental: true, error: this.error, storageReady: this.ready,
      research:this.research.status(),criterion:current?.criterion??null,
      scanned: this.scanned, total: this.total, selectedAt: current?.selectedAt ?? null,
      savedAt: current?.savedAt ?? null,
      rows: current?.selected.filter(r=>!r.preparationEndedAt && !r.windows[72].hit30At).map(display) ?? [],
      progressed: current?.selected.filter(r=>r.preparationEndedAt || r.windows[72].hit30At).length ?? 0,
      history: [...this.cohorts.values()].sort((a,b) => b.selectedAt - a.selectedAt).map(c => ({
        rule:c.rule, day: c.day, selectedAt: c.selectedAt, savedAt: c.savedAt, selected: c.selected.map(publicRow), controls: c.controls.map(publicRow)
      }))};
  }
}
