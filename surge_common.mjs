// 일일 급등 연구를 기존 기준으로 검증하고 서버 순위에 전달한다.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {run as collect,loadEngine,features,qualifies} from './surge_study.mjs';
import {RULES,describe,summarize,evaluate,SCHEMA} from './surge_common_rules.mjs';
const DAY=86400000;
const engine=loadEngine();
export const SEED=JSON.parse(readFileSync(new URL('./surge_common_seed.json',import.meta.url)));
export const latestRecord=model=>model.records.at(-1);
export const completedDate=now=>new Date(Math.floor(now/DAY)*DAY-DAY).toISOString().slice(0,10);
export function encodeModel(model){
  const {archives,...document}=model;
  const value=JSON.stringify({schema:'surge-common-envelope-v1',through:model.through,generatedAt:model.generatedAt,
    body:gzipSync(Buffer.from(JSON.stringify(document))).toString('base64')});
  if(Buffer.byteLength(value)>1800000)throw new Error('연구 원장 저장 크기 점검 필요. 기존 기준은 보존합니다.');
  return value;
}
export function decodeModel(value){const row=JSON.parse(value);return validateModel(row.schema==='surge-common-envelope-v1'
  ?JSON.parse(gunzipSync(Buffer.from(row.body,'base64'),{maxOutputLength:32000000})):row);}
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function evidenceArchives(raw,now){
  const date=new Date(raw.dayStart).toISOString().slice(0,10);
  return raw.markets.flatMap(m=>{
    const day=raw.days[m.market].find(b=>Date.parse(b.candle_date_time_utc.replace(/Z$/,'')+'Z')===raw.dayStart);
    if(!qualifies(day))return [];
    return [{key:`research:${date}:${m.market}`,date,payload:JSON.stringify({version:'surge-evidence-v1',checkedAt:now,date,market:m.market,
      body:gzipSync(Buffer.from(JSON.stringify({day,history:raw.histories[m.market][1440].rows}))).toString('base64')})}];
  });
}
function turnover(raw){
  const base=raw.slice(-25,-5),tail=raw.slice(-3),avg=bs=>bs.reduce((sum,b)=>sum+b.candle_acc_trade_price,0)/bs.length;
  return base.length===20&&tail.length===3&&[...base,...tail].every(b=>Number.isFinite(b.candle_acc_trade_price)&&b.candle_acc_trade_price>=0)&&avg(base)>0?avg(tail)/avg(base):null;
}
export function dailyDescription(raw,cutoff,market='candidate',date=completedDate(cutoff+DAY)){
  const before=raw.filter(b=>Date.parse(b.candle_date_time_utc.replace(/Z$/,'')+'Z')+DAY<=cutoff)
    .sort((a,b)=>a.candle_date_time_utc.localeCompare(b.candle_date_time_utc));
  const frame=features(engine,before,1440,cutoff),ratio=turnover(before);
  return {...describe({date,market,dayStart:cutoff,pre:{frames:{1440:frame}}},ratio),
    evidence:{cutoff,actualBars:frame.actualBars,gaps:frame.gaps,volume3Ratio:frame.volume3dRatio,turnover3Ratio:ratio,
      averages:frame.averages,slopes:frame.slopes,distanceToMaPct:frame.distanceToMaPct}};
}
export function appendDay(model,raw,now){
  const date=new Date(raw.dayStart).toISOString().slice(0,10);
  if(date<=model.through)throw new Error('이미 보존한 연구 일자입니다. 기존 기준을 덮어쓰지 않습니다.');
  if(raw.dayStart!==Date.parse(model.through+'T00:00:00Z')+DAY||raw.dayEnd!==raw.dayStart+DAY||raw.dayEnd>now)
    throw new Error('완료 일자 순서·시간 경계를 확인해야 합니다.');
  const universe=raw.markets.map(m=>m.market);
  if(!universe.length||new Set(universe).size!==universe.length||raw.errors.length||universe.some(m=>!Array.isArray(raw.days[m])))
    throw new Error('전체 종목 수집 미완료. 기존 연구 기준을 유지합니다.');
  const rows=[];
  for(const m of raw.markets){
    const day=raw.days[m.market].find(b=>Date.parse(b.candle_date_time_utc.replace(/Z$/,'')+'Z')===raw.dayStart);
    if(!qualifies(day))continue;
    const history=raw.histories[m.market]?.[1440]?.rows;
    if(!history)throw new Error(m.market+' 급등 사례 사전 이력 응답 누락');
    rows.push({...dailyDescription(history,raw.dayStart,m.market,date),name:m.korean_name,
      event:{open:day.opening_price,high:day.high_price,close:day.trade_price,sourceHash:digest({day,history})}});
  }
  const all=[...model.rows,...rows];
  if(new Set(all.map(r=>r.id)).size!==all.length)throw new Error('급등 사례 중복');
  const previous=latestRecord(model),assessment=evaluate(previous,rows),stats=summarize(all);
  const record={schema:SCHEMA,through:date,createdAt:now,cases:all.length,uniqueMarkets:new Set(all.map(r=>r.market)).size,
    dailyReady:all.filter(r=>r.valid).length,caseIds:all.map(r=>r.id),
    sources:[...(previous.sources??[]),{date,sha256:digest(raw)}],assessment,features:stats,
    commonIds:stats.filter(f=>f.total>=5&&f.ratio>=.7).map(f=>f.id),
    collection:{universe:universe.length,screened:Object.keys(raw.days).length,newCases:rows.length,requests:raw.requests}};
  return {...model,through:date,generatedAt:now,rows:all,records:[...model.records,record]};
}
export function scoreCommon(description,record){
  const ids=record.commonIds,known=ids.filter(id=>typeof description.values[id]==='boolean');
  const matched=ids.filter(id=>description.values[id]===true);
  return {score:ids.length?100*matched.length/ids.length:0,hits:matched.length,total:ids.length,known:known.length,
    missing:ids.length-known.length,matched,labels:matched.map(id=>RULES.find(r=>r[0]===id)[1])};
}
export function validateModel(model){
  const last=model?.records?.at(-1);
  if(model?.schema!==SEED.schema||!Array.isArray(model.rows)||!last||last.schema!==SCHEMA||last.through!==model.through
    ||!Number.isFinite(model.generatedAt)||model.generatedAt!==last.createdAt||last.cases!==model.rows.length
    ||new Set(model.rows.map(r=>r.id)).size!==model.rows.length||!last.commonIds.every(id=>RULES.some(r=>r[0]===id)))
    throw new Error('급등 연구 저장본 형식 오류. 새 순위 확정을 보류합니다.');
  return model;
}
export class CommonResearch {
  constructor({clock=Date.now,collector=collect,seed=SEED}={}){
    this.clock=clock;this.collector=collector;this.model=validateModel(structuredClone(seed));
    this.seedArchives=(this.model.archives??[]).filter(a=>a.date<=this.model.through);delete this.model.archives;
    this.busy=null;this.error=null;this.retryAt=0;this.stage=null;this.persisted=false;
  }
  async refresh(db){
    const saved=await db.prepare('SELECT payload_json FROM radar_snapshot WHERE id=2').first();
    if(saved){const parsed=decodeModel(saved.payload_json);
      if(parsed.through<this.model.through){await this.save(db,this.model,this.seedArchives);this.seedArchives=[];return;}
      if(parsed.through>this.model.through)this.model=parsed;
      else if(parsed.through===this.model.through&&digest(parsed.records)!==digest(this.model.records)){
        // 서버에서 먼저 확정한 동일 날짜의 기준을 재작성하지 않는다.
        this.model=parsed;
      }
      this.persisted=true;
    }
    if(!this.persisted){await this.save(db,this.model,this.seedArchives);this.seedArchives=[];}
  }
  async save(db,model,archives=[]){
    const queries=archives.map(a=>db.prepare('INSERT OR IGNORE INTO radar_state VALUES (?,?)').bind(a.key,a.payload));
    queries.push(db.prepare('INSERT INTO radar_snapshot VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json WHERE COALESCE(json_extract(radar_snapshot.payload_json,\'$.generatedAt\'),0)<=COALESCE(json_extract(excluded.payload_json,\'$.generatedAt\'),0)')
      .bind(2,encodeModel(model)));
    await db.batch(queries);
    this.persisted=true;
  }
  tick(db){
    if(this.busy)return this.busy;
    if(this.clock()<this.retryAt)return Promise.resolve();
    this.busy=this.work(db).catch(e=>{this.error=e.message;this.retryAt=this.clock()+300000;})
      .finally(()=>{this.busy=null;this.stage=null;});
    return this.busy;
  }
  async work(db){
    await this.refresh(db);
    while(this.model.through<completedDate(this.clock())){
      const date=new Date(Date.parse(this.model.through+'T00:00:00Z')+DAY).toISOString().slice(0,10);
      this.stage=date+' 완료 일봉 사례 수집 중';
      const raw=await this.collector({date,output:false,dailyOnly:true,requestIntervalMs:1000});
      await this.refresh(db);
      if(date<=this.model.through)continue;
      const next=appendDay(this.model,raw,this.clock());
      await this.save(db,next,evidenceArchives(raw,this.clock()));this.model=next;
    }
    this.error=null;this.retryAt=0;
  }
  status(){const r=latestRecord(this.model);return {through:r.through,createdAt:r.createdAt,cases:r.cases,dailyReady:r.dailyReady,
    commonCount:r.commonIds.length,common:r.features.filter(f=>r.commonIds.includes(f.id)).map(({matched,exceptions,...f})=>f),
    assessment:r.assessment,busy:!!this.busy,stage:this.stage,error:this.error,retryAt:this.retryAt,
    current:r.through===completedDate(this.clock())&&this.persisted};}
}
