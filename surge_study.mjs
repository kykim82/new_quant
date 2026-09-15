// 업비트 장중 30% 급등 사례와 급등 이전 시간대별 특징을 원본과 함께 누적 저장한다.
import {readFileSync, writeFileSync, mkdirSync, existsSync, renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

export const DAY = 86400000;
export const pct = (a,b) => b > 0 ? (a/b-1)*100 : null;
export const qualifies = day => day && day.opening_price > 0 && day.high_price / day.opening_price >= 1.3;
const root = new URL('./', import.meta.url), dataRoot = new URL('data/',root);
// 마지막 정상 연구와 같은 지표 계산본을 사용해 운영 개편의 영향을 차단한다.
const enginePath = new URL('surge_indicator_baseline.txt', root);
export function loadEngine() {
  const source = readFileSync(enginePath,'utf8').replaceAll('\r\n','\n');
  if(createHash('sha256').update(source).digest('hex')!=='7bef4bac65c090f286450c48bf9ffcdcbf8288f6a1ec369aa0dd67816dfcc39e')throw new Error('연구 지표 기준본 해시 불일치');
  const body = source.slice(0,source.indexOf('// runtime/engine.ts\nvar emit')).replace(/^import .*;$/gm,'');
  return {hash:createHash('sha256').update(source).digest('hex'),
    ...new Function('sleep','sleep2',body+';return {normalizeCandles,movingAverageState,dailySelection,advanceTrends};')(delay,delay)};
}
const openAt = row => Date.parse(row.candle_date_time_utc.endsWith('Z') ? row.candle_date_time_utc : row.candle_date_time_utc+'Z');
const average = xs => xs.length ? xs.reduce((s,x)=>s+x,0)/xs.length : null;
const save = (url,value) => {const temp=new URL(url.href+'.tmp');writeFileSync(temp,JSON.stringify(value,null,2));renameSync(temp,url);};
export function preEventRows(rows, unit, cutoff) {
  return rows.filter(r=>openAt(r)+unit*60000<=cutoff).sort((a,b)=>openAt(a)-openAt(b));
}
export function mergeCase(old, next) {
  const high=Math.max(old?.high??0,next.high);
  return {...old,...next,firstObservedAt:old?.firstObservedAt??next.firstObservedAt,high,
    maxRisePct:pct(high,next.open),pullbackFromHighPct:pct(next.last,high),
    pre:old?.pre?.complete && old.pre.intradayCoverage !== undefined ? old.pre : next.pre};
}
export function features(engine, raw, unit, cutoff) {
  const before=preEventRows(raw,unit,cutoff), bars=engine.normalizeCandles(before,unit,cutoff);
  const recent=bars.slice(-400), actual=recent.filter(b=>!b.synthetic);
  const state=engine.movingAverageState(bars), baseline=average(bars.slice(-25,-5).map(b=>b.baseVolume));
  const last=bars.at(-1), last3=bars.slice(-3);
  return {cutoff,unit,actualBars:actual.length,gaps:recent.filter(b=>b.synthetic).length,
    latestClose:last?.closeTime??null,state:state.state,alignment:state.alignment,averages:state.ma,slopes:state.slopes,crosses:state.crosses,
    volume3dRatio:unit===1440&&baseline>0?average(last3.map(b=>b.baseVolume))/baseline:null,
    volumeIncreasing3:last3.length===3&&last3[0].baseVolume<last3[1].baseVolume&&last3[1].baseVolume<last3[2].baseVolume,
    previousBarVolumeRatio:baseline>0?last?.baseVolume/baseline:null,
    distanceToMaPct:Object.fromEntries(Object.entries(state.ma).map(([p,v])=>[p,v===null||!last?null:pct(last.close,v)])),
    daily:unit===1440?engine.dailySelection(bars,cutoff):null,
    ready:actual.length>=63&&recent.every(b=>!b.synthetic)&&last?.closeTime===Math.floor(cutoff/(unit*60000))*unit*60000};
}
export async function run({date, today=false, get:providedGet, output=true, dailyOnly=false, requestIntervalMs=1000}={}) {
  const engine=loadEngine(), now=Date.now(), currentDay=Math.floor(now/DAY)*DAY;
  const dayStart=date?Date.parse(date+'T00:00:00Z'):today?currentDay:currentDay-DAY;
  if(!Number.isFinite(dayStart)||dayStart>currentDay)throw new Error('완료된 일자 또는 오늘 일자를 입력해 주세요.');
  const label=new Date(dayStart).toISOString().slice(0,10), dayEnd=dayStart+DAY;
  const runId=new Date(now).toISOString().replaceAll(':','-');
  const dir=new URL(`${label}/`,dataRoot), runs=new URL('runs/',dir);
  if(output){mkdirSync(runs,{recursive:true});mkdirSync(new URL('cases/',dir),{recursive:true});}
  const raw={startedAt:now,dayStart,dayEnd,engineHash:engine.hash,requests:0,markets:[],tickers:[],days:{},histories:{},errors:[]};
  let lastRequest=0;
  async function get(endpoint,params={}) {
    if(providedGet)return providedGet(endpoint,params);
    const url=new URL('https://api.upbit.com/v1/'+endpoint);
    for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
    for(let attempt=0;attempt<3;attempt++){
      await delay(Math.max(0,requestIntervalMs-(Date.now()-lastRequest)));lastRequest=Date.now();raw.requests++;
      const response=await fetch(url,{signal:AbortSignal.timeout(20000)});
      if(response.status===429&&attempt<2){await delay(Math.min(30000,Math.max(3000,Number(response.headers.get('Retry-After')||3)*1000)));continue;}
      if(!response.ok)throw new Error(`업비트 ${response.status}. ${endpoint}`);
      const result=await response.json();if(/sec=0(?:;|$)/.test(response.headers.get('Remaining-Req')??''))await delay(1100);
      return result;
    }
  }
  async function history(market,unit,to,count=400) {
    const values=new Map();let cursor=to,exhausted=false;
    for(let n=0;n<5&&values.size<count;n++){
      const response=await get(unit===1440?'candles/days':`candles/minutes/${unit}`,{market,to:new Date(cursor).toISOString(),count:200});
      if(!response.length){exhausted=true;break;}
      for(const row of response){const t=openAt(row);if(!Number.isFinite(t)||t>=cursor)throw new Error(`${market} ${unit}분 과거 응답 시각 오류`);values.set(t,row);}
      cursor=Math.min(...response.map(openAt));
    }
    return {rows:[...values.values()].sort((a,b)=>openAt(a)-openAt(b)),exhausted};
  }
  try{
    raw.markets=(await get('market/all')).filter(m=>m.market.startsWith('KRW-'));
    raw.tickers=await get('ticker/all',{quote_currencies:'KRW'});
    const quotes=new Map(raw.tickers.map(t=>[t.market,t]));
    if(dayStart===currentDay)for(const m of raw.markets)if(!quotes.has(m.market))raw.errors.push({market:m.market,message:'전체 시세에서 종목 미수신'});
    // 오늘은 전체 ticker의 일중 고가로 1차 검색하고, 과거 일자는 모든 종목의 일봉을 확인한다.
    const targets=dayStart===currentDay?raw.markets.filter(m=>qualifies(quotes.get(m.market))):raw.markets;
    for(const m of targets){try{
      const days=await get('candles/days',{market:m.market,to:new Date(dayEnd).toISOString(),count:2});
      raw.days[m.market]=days;const day=days.find(r=>openAt(r)===dayStart);if(!qualifies(day))continue;
      const daily=await history(m.market,1440,dayStart);
      // 당일 15분봉으로 최초 임계 도달 봉을 찾는다. 해당 봉 자체는 사전 특징에 포함하지 않는다.
      const intraday=dailyOnly?{rows:[],exhausted:false}:await history(m.market,15,Math.min(dayEnd,Math.floor(now/900000)*900000),200);
      const crossing=intraday.rows.find(r=>openAt(r)>=dayStart&&r.high_price>=day.opening_price*1.3);
      const cutoff=crossing?openAt(crossing):null;
      const histories={1440:daily,day15:intraday};
      if(cutoff!==null)for(const unit of [15,60,240])histories[unit]=await history(m.market,unit,Math.floor(cutoff/(unit*60000))*unit*60000);
      raw.histories[m.market]=histories;
      const preFrames={1440:features(engine,daily.rows,1440,dayStart)};
      if(cutoff!==null)for(const unit of [15,60,240])preFrames[unit]=features(engine,histories[unit].rows,unit,Math.floor(cutoff/(unit*60000))*unit*60000);
      const previous=raw.days[m.market].find(r=>openAt(r)<dayStart);
      const observedUntil=Math.min(dayEnd,Math.floor(now/900000)*900000);
      const intradayCoverage=intraday.rows.filter(r=>openAt(r)>=dayStart&&openAt(r)<observedUntil).length === (observedUntil-dayStart)/900000;
      const event={version:1,market:m.market,name:m.korean_name,date:label,dayStart,dayEnd,
        firstObservedAt:now,updatedAt:Date.now(),final:dayEnd<=now,open:day.opening_price,high:day.high_price,last:day.trade_price,
        maxRisePct:pct(day.high_price,day.opening_price),lastRisePct:pct(day.trade_price,day.opening_price),
        highVsPreviousClosePct:previous?pct(day.high_price,previous.trade_price):null,pullbackFromHighPct:pct(day.trade_price,day.high_price),
        turnover:day.candle_acc_trade_price,crossingBarOpen:cutoff,
        pre:{complete:cutoff!==null&&intradayCoverage&&Object.values(preFrames).every(f=>f.ready),intradayCoverage,engineHash:engine.hash,frames:preFrames},
        evidence:`runs/${runId}.json`};
      if(output){const file=new URL(`cases/${m.market}.json`,dir);save(file,mergeCase(existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null,event));}
    }catch(error){raw.errors.push({market:m.market,message:error.message});}}
  }finally{raw.finishedAt=Date.now();if(output)save(new URL(`${runId}.json`,runs),raw);}
  if(output){
    const ledgerUrl=new URL('index.json',dir),previous=existsSync(ledgerUrl)?JSON.parse(readFileSync(ledgerUrl,'utf8')):{markets:[]};
    const markets=[...new Set([...previous.markets,...Object.keys(raw.histories)])];
    const cases=markets.flatMap(m=>{const file=new URL(`cases/${m}.json`,dir);return existsSync(file)?[JSON.parse(readFileSync(file,'utf8'))]:[];});
    const tally={};for(const event of cases){const daily=event.pre.frames[1440];if(daily.ready)for(const tag of daily.daily?.recommendation.labels??[])tally[tag]=(tally[tag]??0)+1;}
    const summary={date:label,updatedAt:Date.now(),final:dayEnd<=now,universe:raw.markets.length,screened:targetsCount(raw,currentDay),markets,cases,tally,
      errors:raw.errors,complete:raw.errors.length===0,analysisComplete:cases.every(c=>c.pre.complete),
      limitation:'성공 사례의 공통 특징일 뿐 예측 승률이 아니다. 비급등 대조군과 이후 미사용 기간 검증이 필요하다.'};
    save(ledgerUrl,summary);
    const f=n=>n===null?'미확인':n.toFixed(2);
    const report=[`# ${label} 장중 30% 급등 연구`, '',`업비트 일봉 기준 09:00~다음 날 09:00 KST. ${summary.final?'완료 일자':'진행 중 일자'}. 수집 시각 ${new Date(raw.finishedAt).toISOString()}.`,
      '',`현재 원화마켓 ${summary.universe}종목. 오류 ${raw.errors.length}건. 사전 특징 준비 ${cases.filter(c=>c.pre.complete).length}/${cases.length}건.`,
      '', '| 종목 | 시가 | 장중 고가 | 최대 상승 | 현재/종가 상승 | 고가 대비 | 전일 추세 | 전일 3일 거래량/기준 |',
      '|---|---:|---:|---:|---:|---:|---|---:|',
      ...cases.sort((a,b)=>b.maxRisePct-a.maxRisePct).map(c=>`| ${c.name} (${c.market}) | ${c.open} | ${c.high} | +${f(c.maxRisePct)}% | ${f(c.lastRisePct)}% | ${f(c.pullbackFromHighPct)}% | ${c.pre.frames[1440].state} | ${f(c.pre.frames[1440].volume3dRatio)}배 |`),
      '', '## 급등 전 공통 특징', '', ...Object.entries(tally).map(([tag,n])=>`- ${tag}. ${n}/${cases.length}건.`),
      '', '일봉 특징은 급등일 시작 이전 완료 봉만 사용한다. 하위 시간대는 최초 30% 도달 15분봉의 시작 이전 완료 봉만 사용하며, 그 봉 자체와 이후 고가·거래량은 제외한다.',
      '',summary.limitation,'',...raw.errors.map(e=>`- 미수집. ${e.market}. ${e.message}`)];
    writeFileSync(new URL('report.md',dir),report.join('\n')+'\n');
    console.log(JSON.stringify({date:label,requests:raw.requests,errors:raw.errors,cases:cases.map(c=>({market:c.market,maxRisePct:c.maxRisePct,lastRisePct:c.lastRisePct,pre:c.pre.complete})),report:fileURLToPath(new URL('report.md',dir))},null,2));
    if(raw.errors.length)process.exitCode=1;
    return summary;
  }
  return raw;
}
function targetsCount(raw,currentDay){return raw.dayStart===currentDay?raw.tickers.length:Object.keys(raw.days).length;}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  const date=process.argv.find(a=>/^\d{4}-\d{2}-\d{2}$/.test(a));
  run({date,today:process.argv.includes('--today')}).catch(e=>{console.error(e);process.exitCode=1;});
}
