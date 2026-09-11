// 원본 ST·Target Trend와 새 거래대금·가격·순위 규칙을 계산한다.
// Target Trend 원안 © BigBeluga, CC BY-NC-SA 4.0, https://creativecommons.org/licenses/by-nc-sa/4.0/
export const VERSION = 7;
export const ST_SETTINGS = '7-2.5-hlc3-rma-v1';
export const HISTORY_BARS = 2000;
export const RETENTION_VERSION = 1;
export const RETAINED_BARS = 600;
export const MIN_TURNOVER = 1_000_000_000;
export const UNITS = [15, 60];
export const RECOMMEND_UNITS = [15, 60, 240, 1440];
export const endOf = (unit, now) => Math.floor(now / (unit * 60000)) * unit * 60000;
export const mean = a => a.length ? a.reduce((s,v)=>s+v,0)/a.length : null;
export const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
export function sma(bars,n,offset=0) { const end=bars.length-offset; return end>=n ? mean(bars.slice(end-n,end).map(b=>b.close)) : null; }
function advanceRsi(bars,previous,n=14){const state=previous?{...previous}:{lastClose:0,previousClose:null,count:0,gain:0,loss:0};
  for(const b of bars){if(b.closeTime<=state.lastClose)continue;if(state.previousClose!==null){const d=b.close-state.previousClose;state.count++;
    if(state.count<=n){state.gain+=Math.max(d,0)/n;state.loss+=Math.max(-d,0)/n;}
    else {state.gain=(state.gain*(n-1)+Math.max(d,0))/n;state.loss=(state.loss*(n-1)+Math.max(-d,0))/n;}}
    state.previousClose=b.close;state.lastClose=b.closeTime;}
  return state;
}
function rsiValue(state,n=14){return state.count<n?null:state.loss===0?state.gain===0?50:100:100-100/(1+state.gain/state.loss);}
export function rsi(bars,n=14){return rsiValue(advanceRsi(bars,null,n),n);}
export function validBar(b){return [b.openTime,b.closeTime,b.open,b.high,b.low,b.close,b.baseVolume,b.quoteVolume].every(Number.isFinite)&&b.openTime<b.closeTime&&b.low>0&&b.low<=Math.min(b.open,b.close)&&b.high>=Math.max(b.open,b.close)&&b.baseVolume>=0&&b.quoteVolume>=0;}
export function rawBars(cache,unit,now=Infinity){return (cache?.[unit]??[]).filter(b=>!b.synthetic&&b.closeTime<=now&&validBar(b)).sort((a,b)=>a.openTime-b.openTime);}
export function initialTrend(){return {version:7,count:0,lastClose:0,previousClose:null,trSeed:[],atr10:null,atr200:null,atrWindow:[],highs:[],lows:[],stLower:null,stUpper:null,stDirection:1,stFlipAt:null,ttUpper:null,ttLower:null,ttDirection:null,signal:null};}
// ST는 차트의 7·2.5·HLC3·RMA 설정으로 TT와 별도 누적한다.
export function advanceSupertrend(bars,previous,initialDirection=1){
  const reusable=previous?.settings===ST_SETTINGS&&(!bars.length||bars[0].openTime>=previous.firstOpenTime);
  const s=reusable?structuredClone(previous):{settings:ST_SETTINGS,count:0,lastClose:0,firstOpenTime:bars[0]?.openTime,previousClose:null,seed:[],atr:null,lower:null,upper:null,direction:initialDirection,flipAt:null,restarted:false};
  for(const b of bars){if(b.closeTime<=s.lastClose)continue;const pc=s.previousClose,tr=pc===null?b.high-b.low:Math.max(b.high-b.low,Math.abs(b.high-pc),Math.abs(b.low-pc));s.count++;
    if(s.seed.length<7)s.seed.push(tr);s.atr=s.atr===null?(s.count===7?mean(s.seed):null):(s.atr*6+tr)/7;
    if(s.atr!==null){const source=(b.high+b.low+b.close)/3,lower=source-2.5*s.atr,upper=source+2.5*s.atr,priorLower=s.lower??lower,priorUpper=s.upper??upper,prior=s.direction;
      s.lower=pc!==null&&pc>priorLower?Math.max(lower,priorLower):lower;s.upper=pc!==null&&pc<priorUpper?Math.min(upper,priorUpper):upper;
      if(s.direction===-1&&b.close>priorUpper)s.direction=1;else if(s.direction===1&&b.close<priorLower)s.direction=-1;if(prior!==s.direction)s.flipAt=b.closeTime;}
    s.previousClose=b.close;s.lastClose=b.closeTime;
  }return s;
}
function attachST(trend,st){trend.st=st;trend.stLower=st.lower;trend.stUpper=st.upper;trend.stDirection=st.direction;trend.stFlipAt=st.flipAt;return trend;}
export function advanceTrends(bars,previous){
  const reusable=previous?.version===7&&(!bars.length||!previous.firstOpenTime||bars[0].openTime>=previous.firstOpenTime);
  const state=reusable?structuredClone(previous):initialTrend();
  state.firstOpenTime??=bars[0]?.openTime;
  for(const b of bars){if(b.closeTime<=state.lastClose)continue;
    const pc=state.previousClose,tr=pc===null?b.high-b.low:Math.max(b.high-b.low,Math.abs(b.high-pc),Math.abs(b.low-pc));state.count++;
    if(state.trSeed.length<200)state.trSeed.push(tr);
    state.atr10=state.atr10===null?(state.count===10?mean(state.trSeed):null):(state.atr10*9+tr)/10;
    state.atr200=state.atr200===null?(state.count===200?mean(state.trSeed):null):(state.atr200*199+tr)/200;
    if(state.atr200!==null){state.atrWindow.push(state.atr200);if(state.atrWindow.length>200)state.atrWindow.shift();}
    state.highs.push(b.high);state.lows.push(b.low);if(state.highs.length>10){state.highs.shift();state.lows.shift();}
    if(state.atrWindow.length===200){const width=mean(state.atrWindow)*.8,upper=mean(state.highs)+width,lower=mean(state.lows)-width,prior=state.ttDirection;
      if(pc!==null&&state.ttUpper!==null&&pc<=state.ttUpper&&b.close>upper)state.ttDirection=true;
      if(pc!==null&&state.ttLower!==null&&pc>=state.ttLower&&b.close<lower)state.ttDirection=false;
      if(state.ttDirection!==prior&&prior!==null){const up=state.ttDirection===true;state.signal={time:b.closeTime,direction:up?'up':'down',entry:b.close,stop:up?lower:upper,targets:[5,10,15].map(k=>b.close+(up?1:-1)*k*width),hits:[false,false,false],stoppedAt:null,completedAt:null};}
      state.ttUpper=upper;state.ttLower=lower;}
    const signal=state.signal;
    if(signal&&b.openTime>=signal.time){const touched=p=>b.low<=p&&p<=b.high;
      signal.targets.forEach((p,i)=>{if(touched(p))signal.hits[i]=true;});
      if(touched(signal.stop))signal.stoppedAt??=b.closeTime;
      if(signal.hits[2])signal.completedAt??=b.closeTime;}
    state.lastClose=b.closeTime;state.previousClose=b.close;
  }
  const st=advanceSupertrend(bars,state.st);if(reusable&&!previous.st)st.restarted=true;
  return attachST(state,st);
}
export function mergeRanges(ranges){const out=[];for(const r of ranges.filter(r=>r[0]<r[1]).sort((a,b)=>a[0]-b[0])){const last=out.at(-1);if(last&&r[0]<=last[1])last[1]=Math.max(last[1],r[1]);else out.push([...r]);}return out;}
export function covered(cache,unit,start,end){return (cache?.verified?.[unit]?.ranges??[]).some(r=>r[0]<=start&&r[1]>=end);}
export function turnoverClass(cache,now){const end=endOf(60,now),start=end-72*3600000,bars=rawBars(cache,60,end),meta=cache?.verified?.[60],first=bars[0];
  const enough=meta?.checkedThrough>=end&&(covered(cache,60,start,end)||meta?.exhausted&&(!first||covered(cache,60,first.openTime,end)));
  if(!enough)return {ready:false,group:'pending',asOf:end,reason:'거래대금 72시간 수집 중'};
  const sum=(a,b)=>bars.filter(c=>c.openTime>=a&&c.openTime<b).reduce((s,c)=>s+c.quoteVolume,0),average3d=sum(start,end)/3,lastDay=sum(end-86400000,end),previousDay=sum(end-172800000,end-86400000);
  return {ready:true,group:average3d>=MIN_TURNOVER?'high':'low',average3d,lastDay,previousDay,increasing:lastDay>previousDay,asOf:end};
}
export function tickSize(p){return p>=1e6?1000:p>=5e5?500:p>=1e5?100:p>=5e4?50:p>=1e4?10:p>=5e3?5:p>=100?1:p>=10?.1:p>=1?.01:p>=.1?.001:p>=.01?.0001:p>=.001?.00001:p>=.0001?.000001:p>=.00001?.0000001:.00000001;}
// ATR 시작점에 민감한 TT는 상장 전체 이력 또는 서로 다른 시작점의 수렴을 확인한다.
export function indicatorBars(cache,unit,now){
  const end=endOf(unit,now),range=cache?.verified?.[unit]?.ranges?.find(r=>r[1]>=end);
  return range?rawBars(cache,unit,end).filter(b=>b.openTime>=range[0]):[];
}
export function assessHistory(cache,unit,now){
  const end=endOf(unit,now),meta=cache?.verified?.[unit],bars=indicatorBars(cache,unit,now),checkpoint=cache?.checkpoints?.[unit];
  const fail=reason=>({ready:false,reason,bars:bars.length});
  if(!meta||meta.checkedThrough<end)return fail('최신 봉 연결 확인 중');
  if(!bars.length)return fail('실제 봉 이력 수집 중');
  if(meta.retainedFrom!=null&&(!checkpoint||checkpoint.version!==RETENTION_VERSION||checkpoint.trend?.version!==VERSION||checkpoint.rsi?.lastClose!==checkpoint.trend.lastClose||checkpoint.trend.lastClose>bars[0].openTime||!covered(cache,unit,checkpoint.trend.lastClose,end)||checkpoint.kind==='converged'&&!checkpoint.shadow))return fail('누적 계산 상태 확인 필요 · 이력 보존');
  const complete=checkpoint?checkpoint.kind==='listing':meta.exhausted&&covered(cache,unit,0,end),count=(checkpoint?.trend.count??0)+bars.length;
  if(!complete&&count<HISTORY_BARS)return fail(`TT 초기 이력 검증 중 (${count}/${HISTORY_BARS}봉)`);
  const trend=advanceTrends(bars,checkpoint?.trend),value=rsiValue(advanceRsi(rawBars(cache,unit,end),checkpoint?.rsi));
  const recovery=cache.stRecovery?.[unit],stBars=recovery?[...recovery.bars,...bars]:bars;
  if(recovery){const st=advanceSupertrend(stBars);st.restarted=!recovery.exhausted;attachST(trend,st);}
  if(trend.st.restarted){const sameST=other=>trend.st.direction===other.direction&&['atr','lower','upper'].every(k=>trend.st[k]===other[k]||Number.isFinite(trend.st[k])&&Number.isFinite(other[k])&&Math.abs(trend.st[k]-other[k])<=Math.max(1e-12,Math.abs(trend.st[k])*1e-12));
    if(stBars.length<400||!sameST(advanceSupertrend(stBars,null,-1))||!sameST(advanceSupertrend(stBars.slice(200),null,-1)))return {...fail('ST 새 설정 이력 추가 검증 중'),stPending:true};
    trend.st.restarted=false;
  }
  const result={ready:true,kind:complete?'listing':'converged',bars:count,trend,rsi:value};
  if(complete)return result;
  const shadow=advanceTrends(checkpoint?bars:bars.slice(200),checkpoint?.shadow);
  const close=(a,b)=>a===null&&b===null||Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=Math.max(1e-12,tickSize(Math.max(Math.abs(a),Math.abs(b)))*.01);
  const displayed=v=>Number((Math.floor(v/tickSize(v)+1e-9)*tickSize(v)).toPrecision(14));
  const same=(checkpoint||trend.stDirection===shadow.stDirection&&close(trend.stLower,shadow.stLower)&&close(trend.stUpper,shadow.stUpper))&&trend.ttDirection===shadow.ttDirection
    &&close(trend.ttUpper,shadow.ttUpper)&&close(trend.ttLower,shadow.ttLower)
    &&(trend.signal?.time??null)===(shadow.signal?.time??null)
    &&(!trend.signal||trend.signal.direction===shadow.signal.direction
      &&[trend.signal.entry,trend.signal.stop,...trend.signal.targets].every((v,i)=>{const other=[shadow.signal.entry,shadow.signal.stop,...shadow.signal.targets][i];return close(v,other)&&displayed(v)===displayed(other);})
      &&JSON.stringify(trend.signal.hits)===JSON.stringify(shadow.signal.hits)
      &&trend.signal.stoppedAt===shadow.signal.stoppedAt&&trend.signal.completedAt===shadow.signal.completedAt);
  if(!same||trend.stDirection===1&&trend.ttDirection===true&&!trend.signal)return fail(`TT 시작 이력 추가 검증 중 (${bars.length}봉)`);
  return result;
}
// 과거 가격 도달도 보존하여 정리한 구간을 누적 상태로 재현한다.
export function compactCandles(cache,unit,now,history=assessHistory(cache,unit,now)){
  const bars=indicatorBars(cache,unit,now);if(!history.ready||bars.length<=RETAINED_BARS||bars.length!==rawBars(cache,unit,endOf(unit,now)).length)return 0;
  const count=bars.length-RETAINED_BARS,prefix=bars.slice(0,count),prior=cache.checkpoints?.[unit];
  const trend=advanceTrends(prefix,prior?.trend),shadow=history.kind==='listing'?null:advanceTrends(prior?prefix:prefix.slice(200),prior?.shadow);
  const recovery=cache.stRecovery?.[unit];if(recovery)attachST(trend,advanceSupertrend([...recovery.bars,...prefix]));
  trend.st.restarted=false;if(shadow)attachST(shadow,structuredClone(trend.st));
  if(recovery)delete cache.stRecovery[unit];
  let observed=trend.signal?.direction==='up'?pricePlan({...trend.signal,source:'tt'},'checkpoint',unit,now):null;
  if(observed&&prior?.observed?.signalTime===observed.signalTime){observed.stoppedAt??=prior.observed.stoppedAt;observed.completedAt??=prior.observed.completedAt;observed.hits=observed.hits.map((h,i)=>h||prior.observed.hits[i]);}
  observed=observePlan(observed,prefix,null,now);
  cache.checkpoints??={};cache.checkpoints[unit]={version:RETENTION_VERSION,kind:history.kind,trend,shadow,rsi:advanceRsi(prefix,prior?.rsi),observed:observed?{signalTime:observed.signalTime,stoppedAt:observed.stoppedAt,completedAt:observed.completedAt,hits:observed.hits}:null};
  cache[unit]=[...bars.slice(count),...(cache[unit]??[]).filter(b=>b.closeTime>endOf(unit,now))];cache.verified[unit].retainedFrom=cache[unit][0].openTime;
  return count;
}
export function pricePlan(raw,market,unit,now){
  if(!raw||raw.source!=='tt'||!Array.isArray(raw.targets)||raw.targets.length!==3)return null;
  const round=(v,dir)=>{const t=tickSize(v);return Number(((dir==='down'?Math.floor(v/t+1e-9):Math.round(v/t))*t).toPrecision(14));};
  const entry=round(raw.entry,'near'),stop=round(raw.stop,'down'),targets=raw.targets.map(p=>round(p,'down'));
  if(![entry,stop,...targets].every(v=>Number.isFinite(v)&&v>0)||!(stop<entry&&entry<targets[0]&&targets[0]<targets[1]&&targets[1]<targets[2]))return null;
  return {id:`v7:${market}:${unit}:${raw.source}:${raw.time}`,source:raw.source,signalTime:raw.time,createdAt:now,entry,stop,targets,raw:{entry:raw.entry,stop:raw.stop,targets:raw.targets},riskPct:(entry-stop)/entry*100,rewardRisk:(targets[1]-entry)/(entry-stop),stoppedAt:raw.stoppedAt??null,completedAt:raw.completedAt??null,hits:raw.hits??[false,false,false]};
}
// 추천 판정 이후 확인한 가격 경로만 진입 기록에 사용한다.
export function observeEntry(plan,bars,quote,now){
  const t=plan.entryTracking;if(!t)return;
  t.targetTimes??=[null,null,null];
  const target=(at,index=0)=>{t.targetTimes[index]??=at;t.firstTargetAt=t.firstTargetAt==null?at:Math.min(t.firstTargetAt,at);};
  const contact=(at,ambiguous=false)=>{
    if(t.enteredAt)return;
    if(ambiguous||(t.firstTargetAt!=null&&t.firstTargetAt<=at)){t.reviewAt??=at;return;}
    t.enteredAt=at;
  };
  for(const b of bars){
    if(b.synthetic||b.openTime<t.startedAt||b.closeTime>now||b.closeTime<=(t.checkedThrough??0))continue;
    const hit=b.high>=plan.targets[0];
    if(b.low<=plan.entry&&b.high>=plan.entry&&b.low>plan.stop)contact(b.closeTime,hit);
    plan.targets.forEach((price,i)=>{if(b.high>=price)target(b.closeTime,i);});
    t.checkedThrough=b.closeTime;
  }
  if(quote&&Number.isFinite(quote.tradePrice)&&now-quote.receivedAt>=0&&now-quote.receivedAt<=45000
      &&(now===t.startedAt||quote.timestamp>=t.startedAt&&quote.timestamp<=now)){
    plan.targets.forEach((price,i)=>{if(quote.tradePrice>=price)target(now,i);});
    if(quote.tradePrice>plan.stop&&quote.tradePrice<=plan.entry)contact(now);
  }
}
export function observePlan(plan,bars,quote,now){if(!plan)return null;const p=structuredClone(plan);p.hits??=[false,false,false];
  observeEntry(p,bars,quote,now);
  for(const b of bars){if(b.openTime<p.signalTime)continue;if(b.low<=p.stop)p.stoppedAt??=b.closeTime;p.targets.forEach((t,i)=>{if(b.high>=t)p.hits[i]=true;});if(p.hits[2])p.completedAt??=b.closeTime;}
  if(quote&&now-quote.receivedAt>=0&&now-quote.receivedAt<=45000){if(quote.tradePrice<=p.stop)p.stoppedAt??=now;p.targets.forEach((t,i)=>{if(quote.tradePrice>=t)p.hits[i]=true;});if(p.hits[2])p.completedAt??=now;}
  return p;
}
export function rankScore(bars,trend,plan,turnover,upper=[],r=rsi(bars)){const current=bars.at(-1).close,volRatio=turnover.previousDay>0?turnover.lastDay/turnover.previousDay:1;
  const parts={st:trend.stDirection===1?20:0,targets:20,rewardRisk:20*clamp(plan.rewardRisk/4,0,1),risk:10/(1+plan.riskPct/5),activity:10*clamp(volRatio/2,0,1),upper:upper.reduce((s,t)=>s+(t.stDirection===1?5:0)+(t.signal?.direction==='up'&&!t.signal.stoppedAt&&!t.signal.completedAt?5:0),0),overheat:-(r===null?0:clamp((r-70)/30,0,1)*10),extension:trend.atr10>0?-clamp((current-trend.stLower)/trend.atr10-4,0,5):0};
  return {score:Math.round(clamp(Object.values(parts).reduce((s,v)=>s+v,0),0,100)*100)/100,parts,rsi:r};
}
export function evaluateMarket({market,cache,unit,quote,now,exclusionsReady,previousTrend,previousPlan,turnover,upper=[],history}){
  const fail=(code,reason,extra={})=>({market:market.market,name:market.koreanName,unit,status:code,reason,checkedAt:now,stRule:ST_SETTINGS,...extra});
  if(!exclusionsReady)return fail('exclusions','공식 제외 정보 확인 중');
  if(market.warned||market.market==='KRW-USDT')return fail('excluded','유의·거래지원 종료·테더 제외');
  if(!turnover?.ready||turnover.asOf!==endOf(60,now))return fail('volume_pending','거래대금 최신 분류 중');
  if(turnover.group!=='high')return fail('monitor','10억 미만 · 거래대금 변화 관찰');
  const bars=rawBars(cache,unit,endOf(unit,now)),meta=cache?.verified?.[unit];
  if(!bars.length||meta?.checkedThrough<endOf(unit,now)||!meta)return fail('collecting','주 시간대 최신 봉 수집 중');
  history??=assessHistory(cache,unit,now);
  if(!history.ready)return fail('history_pending',history.reason,{checkedThrough:endOf(unit,now),actualBars:history.bars,historyReady:false});
  const trend=history.trend,extra={trend,checkedThrough:endOf(unit,now),actualBars:history.bars,historyReady:true,historyKind:history.kind,historyExhausted:meta.exhausted===true};
  if((trend.st?trend.st.atr:trend.atr10)===null)return fail('new_listing','신규 상장 · ST 계산 이력 수집 중',extra);
  if(UNITS.includes(unit)&&trend.stDirection!==1)return fail('sell','ST Sell',extra);
  let raw=trend.signal?.direction==='up'?{...trend.signal,source:'tt'}:null;
  if(raw?.stoppedAt||raw?.completedAt)return fail('ended','타겟 트렌드 종료 · 새 신호 대기',extra);
  if(!raw)return fail('tt_wait','타겟 트렌드 상승 신호 대기',{...extra,code:'TT_SIGNAL_WAIT',turnover,quote});
  let plan=pricePlan(raw,market.market,unit,now);
  if(!plan)return fail('price_pending','유효한 매수·손절·3단계 목표 구조 없음',extra);
  const observed=cache.checkpoints?.[unit]?.observed;
  if(observed?.signalTime===plan.signalTime){plan.stoppedAt??=observed.stoppedAt;plan.completedAt??=observed.completedAt;plan.hits=plan.hits.map((h,i)=>h||observed.hits[i]);}
  if(previousPlan?.id===plan.id)plan={...plan,createdAt:previousPlan.createdAt,entryTracking:previousPlan.entryTracking,entry:previousPlan.entry,stop:previousPlan.stop,targets:previousPlan.targets,stoppedAt:previousPlan.stoppedAt??plan.stoppedAt,completedAt:previousPlan.completedAt??plan.completedAt,hits:plan.hits.map((h,i)=>h||previousPlan.hits?.[i])};
  plan=observePlan(plan,bars,quote,now);
  if(plan.stoppedAt||plan.completedAt)return fail('ended','가격 계획 손절·3차 목표 종료 · 새 신호 대기',{...extra,plan});
  if(!quote||!Number.isFinite(quote.receivedAt)||now-quote.receivedAt<0||now-quote.receivedAt>45000)return fail('quote_pending','최신 시세 조회 대기',{...extra,plan});
  if(!(quote.tradePrice>0))return fail('quote_pending','시세 값 확인 대기',{...extra,plan});
  const rank=rankScore(bars,trend,plan,turnover,upper,history.rsi);
  return {...fail('ready','가격 계획 확인 완료',extra),plan,turnover,...rank,quote,st:trend.stDirection===1?'Buy':'Sell',newListing:trend.count<399,priceMethod:'원본 Target Trend'};
}
export function promisingMarket(market,cache,turnover,quote,now){const bars=rawBars(cache,60,endOf(60,now)),ma=sma(bars,20),old=sma(bars,20,3);if(!turnover?.ready||turnover.group!=='low'||!turnover.increasing||ma===null||old===null||!(ma>old&&bars.at(-1).close>=ma))return null;return {market:market.market,name:market.koreanName,quote,turnover,reason:'거래대금 증가 · 1시간 이평선 상승 및 가격 회복',score:turnover.previousDay>0?turnover.lastDay/turnover.previousDay:1};}
