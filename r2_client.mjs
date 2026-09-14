// 비공개 R2 버킷의 압축 백업 객체를 S3 서명 요청으로 읽고 쓰며 사용량을 기록한다.
import {createHash,createHmac} from 'node:crypto';
const hash=v=>createHash('sha256').update(v).digest('hex');
const hmac=(key,v)=>createHmac('sha256',key).update(v).digest();
const escape=v=>encodeURIComponent(v).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
export function signRequest({url,method,body=Buffer.alloc(0),accessKey,secretKey,now,region='auto'}){
  const u=new URL(url),date=new Date(now).toISOString().replace(/[:-]|\.\d{3}/g,''),day=date.slice(0,8),digest=hash(body);
  const headers={host:u.host,'x-amz-content-sha256':digest,'x-amz-date':date};
  const signed=Object.keys(headers).sort().join(';');
  const query=[...u.searchParams].map(([k,v])=>[escape(k),escape(v)]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:a[1]<b[1]?-1:a[1]>b[1]?1:0).map(p=>p.join('=')).join('&');
  const canonical=[method,u.pathname,query,Object.keys(headers).sort().map(k=>k+':'+headers[k]+'\n').join(''),signed,digest].join('\n');
  const scope=day+'/'+region+'/s3/aws4_request',key=hmac(hmac(hmac(hmac('AWS4'+secretKey,day),region),'s3'),'aws4_request');
  headers.Authorization='AWS4-HMAC-SHA256 Credential='+accessKey+'/'+scope+', SignedHeaders='+signed+', Signature='+hmac(key,['AWS4-HMAC-SHA256',date,scope,hash(canonical)].join('\n')).toString('hex');
  return headers;
}
const decode=v=>v.replace(/&(?:amp|lt|gt|quot|apos);/g,m=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[m]));
export function parseList(xml){
  if(!xml.includes('<ListBucketResult'))throw new Error('R2 목록 응답 형식 확인 필요');
  const tag=(s,t)=>decode(s.match(new RegExp('<'+t+'>([\\s\\S]*?)</'+t+'>'))?.[1]??'');
  const items=[...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(m=>({key:tag(m[1],'Key'),size:Number(tag(m[1],'Size'))}));
  if(items.some(i=>!i.key||!Number.isSafeInteger(i.size)||i.size<0))throw new Error('R2 목록의 파일 크기 확인 필요');
  const truncated=tag(xml,'IsTruncated')==='true',next=tag(xml,'NextContinuationToken');
  if(truncated&&!next)throw new Error('R2 목록의 다음 페이지 정보 없음');
  return {items,next:truncated?next:null};
}
export function r2Client(config,{transport=fetch,clock=Date.now,meter=()=>{}}={}){
  const {accountId,bucket,accessKey,secretKey}=config;
  if(!/^[a-f0-9]{32}$/i.test(accountId)||!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)||!accessKey||!secretKey)throw new Error('R2 연결 설정을 확인해 주세요.');
  const base=`https://${accountId}.r2.cloudflarestorage.com/${bucket}/`;
  async function call(method,key='',query={},body=Buffer.alloc(0)){
    if(key&&(key.startsWith('/')||key.split('/').some(p=>p==='.'||p==='..')))throw new Error('R2 객체 경로 오류');
    const url=new URL(base+key.split('/').map(escape).join('/'));for(const [k,v]of Object.entries(query))url.searchParams.set(k,v);
    const op=method==='PUT'||Object.hasOwn(query,'list-type')?'A':method==='DELETE'?'delete':'B';
    meter(op,body.length);
    const headers=signRequest({url,method,body,accessKey,secretKey,now:clock()});
    if(method==='PUT')headers['Content-Type']='application/octet-stream';
    let response;try{response=await transport(url,{method,headers,body:method==='PUT'?body:undefined,redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw new Error('R2 연결 지연·실패. 백업 자료를 유지하고 재시도합니다.');}
    if(response.status===404&&(method==='GET'||method==='DELETE'))return null;
    if(!response.ok)throw new Error(`R2 HTTP ${response.status}. 권한·연결·사용량 확인 필요`);
    if(method==='DELETE')return null;
    const size=Number(response.headers.get('content-length')??0);if(size>64000000)throw new Error('R2 단일 백업 파일 크기 확인 필요');
    return Buffer.from(await response.arrayBuffer());
  }
  return {put:(key,body)=>call('PUT',key,{},body),get:key=>call('GET',key),remove:key=>call('DELETE',key),
    list:async(prefix,next)=>parseList((await call('GET','',{'list-type':'2',prefix,...(next?{'continuation-token':next}:{})})).toString('utf8'))};
}
