// 실제 상위 추천 목록과 과거 판정의 가격 성과를 분리해 복구·관찰한다.
import {validBar, RECOMMEND_UNITS} from './quant_core.mjs';

export const PERIOD = 900000;
export const DAY = 86400000;
// 업비트 거래일은 한국시간 오전 9시, 즉 UTC 0시에 끝난다.
export const dailyCutoff = now => Math.floor(now / DAY) * DAY;
const floor = at => Math.floor(at / PERIOD) * PERIOD;
const first = (...a) => {const v=a.filter(x=>Number.isFinite(x)&&x>0);return v.length?Math.min(...v):null;};
const positive = n => Number.isFinite(n) && n > 0;
export function terminalAt(row) {return first(row.plan.stoppedAt,row.plan.completedAt);}

export function createObservation(row, at, price, source, rank=null) {
  const start = Math.ceil(at / PERIOD) * PERIOD;
  return {version:1,source,at,price:positive(price)?price:null,rank,entry:row.plan.entry,stop:row.plan.stop,
    targets:[...row.plan.targets],eligibleTargets:row.plan.targets.map(t=>positive(price)&&t>price),
    cursor:start,checkedThrough:null,high:positive(price)?price:null,low:positive(price)?price:null,last:positive(price)?price:null,lastAt:at,
    targetTimes:[null,null,null],stopAt:null,sameBarConflict:false,initialPartial:at!==start,
    finalPartial:false,endedAt:null,done:false,error:null,attemptedAt:0,daily:{}};
}

export function seedLegacy(row) {
  if(!row.performance && positive(row.firstShownAt) && RECOMMEND_UNITS.includes(row.unit)
    && Array.isArray(row.plan.targets) && row.plan.targets.length===3) {
    row.performance={legacy:createObservation(row,row.firstShownAt,row.plan.entryTracking?.qualificationPrice,'legacy')};
    return true;
  }
  return false;
}

// Python 공개 화면 필터와 같은 발행 시점 조건으로 시간대별 10개를 고른다.
export function publishedRows(payload) {
  const now=payload.generatedAt, counts=new Map();
  if(!payload.exclusions?.ready || now-payload.exclusions.checkedAt<0 || now-payload.exclusions.checkedAt>120000)return [];
  const excluded=new Set(['KRW-USDT',...(payload.excluded??[]).map(r=>r.market)]);
  return payload.rows.filter(r=>{
    const p=r.plan,q=r.quote,t=r.turnover,u=r.unit,end=Math.floor(now/(u*60000))*u*60000;
    const prices=[p?.stop,p?.entry,...(p?.targets??[])];
    if(!RECOMMEND_UNITS.includes(u)||excluded.has(r.market)||p?.source!=='tt'||p.stoppedAt||p.completedAt
      ||prices.length!==5||!prices.every((v,i)=>positive(v)&&(!i||v>prices[i-1]))
      ||!positive(q?.tradePrice)||now-q.receivedAt<0||now-q.receivedAt>45000
      ||!(q.tradePrice>p.stop&&q.tradePrice<p.targets[2])||!(r.checkedThrough>=end-u*60000&&r.checkedThrough<=end)
      ||!(t?.average3d>=1e9&&t.asOf>=Math.floor(now/3600000)*3600000-3600000&&t.asOf<=now))return false;
    const rank=(counts.get(u)??0)+1;counts.set(u,rank);return rank<=10;
  });
}

export function capturePublished(plans,payload,dirty) {
  const counts=new Map();let added=0;
  for(const r of publishedRows(payload)) {
    const rank=(counts.get(r.unit)??0)+1;counts.set(r.unit,rank);
    const row=plans.get(r.plan.id);if(!row||row.performance?.live)continue;
    row.performance??={};row.performance.live=createObservation(row,payload.generatedAt,r.quote.tradePrice,'live',rank);
    dirty.add(r.plan.id);added++;
  }
  return added;
}

function observePrice(p,high,low,last,at) {
  p.high=p.high===null?high:Math.max(p.high,high);p.low=p.low===null?low:Math.min(p.low,low);
  if(at>=p.lastAt){p.last=last;p.lastAt=at;}
  p.targets.forEach((v,i)=>{if(p.eligibleTargets[i]&&high>=v)p.targetTimes[i]=first(p.targetTimes[i],at);});
  if(low<=p.stop)p.stopAt=first(p.stopAt,at);
  if(low<=p.stop&&p.targets.some((v,i)=>p.eligibleTargets[i]&&high>=v))p.sameBarConflict=true;
}

export function pageBars(raw,to) {
  if(!Array.isArray(raw))throw new Error('성과 캔들 응답 형식 오류');
  const bars=raw.map(r=>({openTime:Date.parse(r.candle_date_time_utc+'Z'),closeTime:Date.parse(r.candle_date_time_utc+'Z')+PERIOD,
    open:r.opening_price,high:r.high_price,low:r.low_price,close:r.trade_price,baseVolume:r.candle_acc_trade_volume,quoteVolume:r.candle_acc_trade_price}));
  if(bars.length>200||bars.some(b=>!validBar(b)||b.openTime%PERIOD!==0||b.closeTime>to)
    ||new Set(bars.map(b=>b.openTime)).size!==bars.length)throw new Error('성과 캔들 값·시각 검증 실패');
  return bars.sort((a,b)=>a.openTime-b.openTime);
}

export function applyPage(p,bars,from,to,endedAt,now) {
  if(from>p.cursor||to<p.cursor)throw new Error('성과 복구 구간 연결 오류');
  for(const b of bars)if(b.openTime>=p.cursor&&b.closeTime<=to){
    observePrice(p,b.high,b.low,b.close,b.closeTime);
    if(b.low<=p.stop||b.high>=p.targets[2]){to=b.closeTime;endedAt=first(endedAt,b.closeTime);break;}
  }
  p.cursor=to;p.checkedThrough=to;p.endedAt=endedAt;p.finalPartial=!!endedAt&&endedAt!==floor(endedAt);
  p.done=!!endedAt&&p.cursor>=floor(endedAt);p.error=null;p.attemptedAt=now;
}

export function recordDay(p,asOf,now) {
  p.daily??={};const key=String(asOf);
  if(p.daily[key])return;
  p.daily[key]={asOf,summarizedAt:now,checkedThrough:p.checkedThrough,high:p.high,low:p.low,last:p.last,lastAt:p.lastAt,
    targetTimes:[...p.targetTimes],stopAt:p.stopAt,endedAt:p.endedAt,sameBarConflict:p.sameBarConflict,
    initialPartial:p.initialPartial,finalPartial:p.finalPartial};
}

export function mergePerformance(a,b) {
  if(!a)return b;if(!b)return a;const out={};
  for(const kind of ['live','legacy']) {
    const x=a[kind],y=b[kind];if(!x&&!y)continue;if(!x||!y){out[kind]=structuredClone(x??y);continue;}
    // 시작 기준이 다르면 더 이른 실제 기록을 보존하며 서로 다른 기준 성과를 합치지 않는다.
    if(x.at!==y.at||x.price!==y.price){out[kind]=structuredClone(x.at<=y.at?x:y);continue;}
    const newest=(x.attemptedAt??0)>=(y.attemptedAt??0)?x:y,p=structuredClone(newest);
    p.daily={...y.daily,...x.daily};
    const highs=[x.high,y.high].filter(positive),lows=[x.low,y.low].filter(positive);
    p.high=highs.length?Math.max(...highs):null;p.low=lows.length?Math.min(...lows):null;
    const last=x.lastAt>=y.lastAt?x:y;p.last=last.last;p.lastAt=last.lastAt;
    p.cursor=Math.max(x.cursor,y.cursor);p.checkedThrough=Math.max(x.checkedThrough??0,y.checkedThrough??0)||null;p.targetTimes=[0,1,2].map(i=>first(x.targetTimes[i],y.targetTimes[i]));
    p.stopAt=first(x.stopAt,y.stopAt);p.sameBarConflict=x.sameBarConflict||y.sameBarConflict;
    p.endedAt=first(x.endedAt,y.endedAt);p.done=!!p.endedAt&&p.cursor>=floor(p.endedAt);out[kind]=p;
  }
  return out;
}

export function performanceSnapshot(plans,status={}) {
  const rows=[];
  for(const row of plans.values())for(const p of Object.values(row.performance??{})) {
    const pct=value=>positive(p.price)&&positive(value)?(value/p.price-1)*100:null;
    const {daily,...detail}=p,dates=Object.keys(daily??{}).map(Number);
    rows.push({id:row.plan.id,market:row.market,name:row.name,unit:row.unit,...detail,dailyCount:dates.length,
      lastSummaryAt:dates.length?Math.max(...dates):null,maxPct:pct(p.high),lastPct:pct(p.last)});
  }
  const totals=[];
  for(const source of ['live','legacy'])for(const unit of RECOMMEND_UNITS){
    const group=rows.filter(r=>r.source===source&&r.unit===unit);
    const observed=group.filter(r=>positive(r.price)&&!r.error&&r.cursor>Math.ceil(r.at/PERIOD)*PERIOD);
    totals.push({source,unit,total:group.length,observed:observed.length,up5:observed.filter(r=>r.maxPct>=5).length,
      up10:observed.filter(r=>r.maxPct>=10).length,target1:observed.filter(r=>r.targetTimes[0]).length,
      stopped:observed.filter(r=>r.stopAt).length,ended:observed.filter(r=>r.done).length});
  }
  rows.sort((a,b)=>b.at-a.at);
  return {version:1,...status,totals,rows:['live','legacy'].flatMap(s=>rows.filter(r=>r.source===s).slice(0,200))};
}

// 오전 9시까지 완료된 거래일만 하루씩 집계한다. 같은 날짜는 커서로 중복 저장을 막는다.
export class PerformanceTracker {
  constructor(){this.busy=null;this.nextAt=0;this.round=0;this.lastJob=new Map();this.status={stage:'성과 기록 준비',error:null};}
  tick(radar) {
    if(this.busy||!radar.token||radar.clock()<this.nextAt)return this.busy;
    this.busy=this.work(radar).catch(e=>{this.status={stage:'성과 복구 재시도 대기',error:e.message};this.nextAt=radar.clock()+60000;})
      .finally(()=>{this.busy=null;});return this.busy;
  }
  async work(radar) {
    const now=radar.clock(),cutoff=dailyCutoff(now),jobs=[];this.nextAt=now+5000;
    for(const row of radar.plans.values())for(const [kind,p] of Object.entries(row.performance??{})) {
      if(!positive(p.price)||p.done)continue;
      if(p.at>=cutoff)continue;
      const initialEnd=dailyCutoff(p.at)+DAY;
      const dayEnd=Math.min(p.checkedThrough===null&&!p.daily?.[initialEnd]?initialEnd:dailyCutoff(p.cursor)+DAY,cutoff);
      const terminal=terminalAt(row),endedAt=terminal&&terminal<=dayEnd?terminal:null,end=floor(Math.min(dayEnd,endedAt??dayEnd));
      if(endedAt&&endedAt<=p.at){p.done=true;p.endedAt=endedAt;p.error='추천 판정 이전에 종료된 계획';radar.planDirty.add(row.plan.id);continue;}
      if(p.cursor>=end){
        if(endedAt){p.done=true;p.endedAt=endedAt;p.finalPartial=endedAt!==end;recordDay(p,dayEnd,now);radar.planDirty.add(row.plan.id);}
        else if(!p.daily?.[dayEnd]&&Math.ceil(p.at/PERIOD)*PERIOD>=end){recordDay(p,dayEnd,now);radar.planDirty.add(row.plan.id);}
        continue;
      }
      const key=row.plan.id+':'+kind;
      if(now-(p.attemptedAt??0)<60000&&p.error)continue;
      jobs.push({row,kind,p,end,dayEnd,endedAt,key});
    }
    const preferred=this.round++%4===3?'legacy':'live';
    jobs.sort((a,b)=>(a.kind===preferred?0:1)-(b.kind===preferred?0:1)||(this.lastJob.get(a.key)??0)-(this.lastJob.get(b.key)??0)||a.p.cursor-b.p.cursor);
    const job=jobs[0];if(!job){this.status={stage:'성과 일별 집계 완료 · 다음 오전 9시 대기',error:null,nextDailyAt:cutoff+DAY};return;}
    const {row,p,kind,dayEnd}=job,from=p.cursor,to=job.end;
    this.lastJob.set(job.key,now);this.status={stage:`${row.market} ${kind==='live'?'추천 성과':'과거 참고'} 복구 중`,error:null};
    try {
      const cache=radar.caches.get(row.market),range=cache?.verified?.[15]?.ranges?.some(r=>r[0]<=from&&r[1]>=to);
      // 메타 범위만 남고 압축 정리된 오래된 캔들은 캐시에서 복구했다고 간주하지 않는다.
      const retained=cache?.[15]?.[0]?.openTime;
      let bars;
      if(range&&Number.isFinite(retained)&&retained<=from)bars=cache[15].filter(b=>!b.synthetic&&b.openTime>=from&&b.closeTime<=to&&validBar(b));
      else {
        const raw=await radar.request(`/candles/minutes/15?market=${encodeURIComponent(row.market)}&to=${encodeURIComponent(new Date(to).toISOString())}&count=200`);
        bars=pageBars(raw,to);
        if(bars.length===200&&bars[0].openTime>from)throw new Error('성과 과거 캔들 연결 미확인');
      }
      // 네트워크 대기 중 D1/R2 원장이 복원됐으면 최신 객체를 기준으로 병합한다.
      const current=radar.plans.get(row.plan.id),target=current?.performance?.[kind];
      if(!target||target.done||target.at!==p.at||target.cursor>to)return;
      const terminal=terminalAt(current),final=terminal&&terminal<=dayEnd?terminal:null,limit=Math.min(to,floor(final??dayEnd));
      if(limit>=target.cursor){applyPage(target,bars,from,limit,final,now);recordDay(target,dayEnd,now);}
      radar.planDirty.add(row.plan.id);this.status={stage:'성과 일별 집계·과거 복구 진행 중',error:null};
    }catch(e){
      const current=radar.plans.get(row.plan.id)?.performance?.[kind];
      if(current&&current.error!==e.message){current.error=e.message;radar.planDirty.add(row.plan.id);}
      this.status={stage:'일부 성과 복구 재시도 대기',error:e.message};this.nextAt=now+60000;
    }
  }
}
