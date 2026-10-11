import json,random,math
from pathlib import Path
random.seed(23)
U=1000000
traces=[]
def allocation(total,n,lo=.7,hi=1.3):
 weights=[random.uniform(lo,hi) for _ in range(n)]
 arr=[round(total*w/sum(weights)) for w in weights]
 arr[-1]+=total-sum(arr)
 return arr

def mkcall(name,cost,provider,model,fn,start=0,duration=1,**kw):
 return dict(name=name,cost=cost,provider=provider,model=model,function=fn,start=start,duration=duration,**kw)

def trace(i,feature,cost,day,env='Production',op=None,group=None,variant=None,calls=None,name=None):
 t=dict(id=name or ('search-request-'+str(2000+i) if feature=='Search' else ('document-batch-' if feature=='Document processing' else 'voice-turn-' if feature=='Voice assistance' else 'operation-')+str(i)),feature=feature,cost=cost,day=day,hour=8+(i*7)%12,minute=(i*13)%60,second=i%60,environment=env,customer=['Meridian','Cedar','Willow','Unassigned'][i%4],service='search-api' if feature=='Search' else 'document-worker' if feature=='Document processing' else 'voice-service' if feature=='Voice assistance' else 'worker',release='2026.09.18' if day>=18 else '2026.09.07',operation=op or ('search.suggest' if feature=='Search' else 'process.document' if feature=='Document processing' else 'voice.respond' if feature=='Voice assistance' else 'custom.operation'),duration=round(1.2+random.random()*6,1),state='Completed',group=group,variant=variant)
 if calls is None:
  if feature=='Search':
   a=round(cost*.07); b=round(cost*.32); c=cost-a-b
   calls=[mkcall('Embed query',a,'OpenAI','Embedding model','embed_query · search-api/embeddings.py',0,.4),mkcall('Build context',b,'Anthropic','Context model','build_context · shared/context.py',.4,1.2),mkcall('Generate answer',c,'OpenAI','Generation model','generate_answer · search-api/answer.py',1.6,t['duration']-1.6 if t['duration']>1.6 else .5)]
  elif feature=='Document processing':
   a=round(cost*.62); b=cost-a
   calls=[mkcall('Build context',a,'Anthropic','Context model','build_context · shared/context.py',0,1.2),mkcall('Extract document',b,'OpenAI','Extraction model','extract_document · document-worker/parse.py',1.2,2.1)]
  elif feature=='Voice assistance':
   a=round(cost*.2);b=round(cost*.45);c=cost-a-b
   calls=[mkcall('Speech recognition',a,'Speech adapter','Speech recognition','transcribe · voice-service/turns.py',0,.8,unit='seconds'),mkcall('Generate response',b,'OpenAI','Generation model','voice_response · voice-service/turns.py',.8,1.1),mkcall('Speech generation',c,'Speech adapter','Speech generation','speak · voice-service/turns.py',1.9,1.5,unit='characters')]
  else: calls=[mkcall('Provider call',cost,'OpenAI','Generation model','Unassigned',0,t['duration'])]
 for j,c in enumerate(calls): c['id']=f'{t["id"]}:c{j+1}'; c.setdefault('source','Mapped location');c.setdefault('basis','Estimated');c.setdefault('http','200');c.setdefault('input',round(c['cost']/10));c.setdefault('output',round(c['cost']/40))
 t['calls']=calls
 traces.append(t); return t

# Two separate nightly invocations, both subsets of Search's $142.80.
for i in range(100):
 gen=60000 if i<20 else 35000
 calls=[mkcall('Generate case',gen-(30000 if i<20 else 0),'OpenAI','Generation model','evaluate_case · eval-worker/search.py',0,1.2,phase='Generation'),mkcall('Score case',12000,'Anthropic','Scoring model','score_case · eval-worker/search.py',1.2,1.1,phase='Scoring'),mkcall('Retrieve evidence',2000,'OpenAI','Embedding model','retrieve_case · eval-worker/search.py',0,.2,phase='Retrieval')]
 if i<20: calls.append(mkcall('Generation retry',30000,'OpenAI','Generation model','evaluate_case · eval-worker/search.py',1.2,1.1,phase='Generation',attempt=2))
 t=trace(i,'Search',gen+14000,19,'Development','eval.search','nightly-search-quality / 19 Sep', 'A' if i%2==0 else 'B',calls=calls,name='eval-0919-case-'+str(i+1).zfill(3))
 if i>=98:t['state']='Failed'
for i in range(100):
 calls=[mkcall('Generate case',39000,'OpenAI','Generation model','evaluate_case · eval-worker/search.py',0,1.2,phase='Generation'),mkcall('Score case',11200,'Anthropic','Scoring model','score_case · eval-worker/search.py',1.2,1.1,phase='Scoring'),mkcall('Retrieve evidence',2000,'OpenAI','Embedding model','retrieve_case · eval-worker/search.py',0,.2,phase='Retrieval')]
 trace(100+i,'Search',52200,20,'Development','eval.search','nightly-search-quality / 20 Sep','A' if i%2==0 else 'B',calls=calls,name='eval-0920-case-'+str(i+1).zfill(3))
# Equal-duration finding cohorts: previous $12.80/160 vs current $28.00/200.
a=allocation(12700000,159)
for j,c in enumerate([100000]+a):
 t=trace(200+j,'Search',c,7+j%7,'Production','search.retrieve',name='search-request-0981' if j==0 else None)
 if j==0:
  t['calls']=[mkcall('Embed query',10000,'OpenAI','Embedding model','embed_query · search-api/embeddings.py',0,.4),mkcall('Rank results',20000,'Anthropic','Ranking model','rank_results · search-api/rank.py',.4,.5),mkcall('Generate answer',70000,'OpenAI','Generation model','generate_answer · search-api/answer.py',.9,1.6)]
  t['duration']=2.5
  for k,cc in enumerate(t['calls']):cc.update(id=t['id']+':c'+str(k+1),source='Mapped location',basis='Estimated',http='200',input=1000,output=500)
a=allocation(27580000,199)
for j,c in enumerate([420000]+a):
 t=trace(360+j,'Search',c,20 if j==0 else 14+j%7,'Production','search.retrieve',name='search-request-1042' if j==0 else None)
 if j==0:
  t.update(duration=5.8,hour=14,minute=32,second=8,customer='Meridian')
  specs=[('Embed query',10000,'OpenAI','Embedding model','embed_query · search-api/embeddings.py',0,.4),('Rank results',40000,'Anthropic','Ranking model','rank_results · search-api/rank.py',.4,1.2),('Summarize context',130000,'Anthropic','Context model','build_context · shared/context.py',.4,1.2),('Generate answer',120000,'OpenAI','Generation model','generate_answer · search-api/answer.py',1.6,1.9),('Generation retry',120000,'OpenAI','Generation model','generate_answer · search-api/answer.py',3.5,2.3)]
  t['calls']=[mkcall(*v) for v in specs]
  for k,cc in enumerate(t['calls']):cc.update(id=t['id']+':c'+str(k+1),source='Mapped location',basis='Estimated',http='200',input=10000 if k==2 else 4000,output=1500 if k==2 else 1000)
  t['calls'][3]['http']='503';t['calls'][4]['attempt']=2;t['calls'][4]['operationId']='generation-1042';t['calls'][3]['operationId']='generation-1042'
for j,c in enumerate(allocation(91380000,640)):
 trace(560+j,'Search',c,1+j%20,'Development' if j%4==0 else 'Production')
for feat,n,total,offset in [('Document processing',400,64400000,1200),('Voice assistance',200,26000000,1600),('Unassigned',100,15400000,1800)]:
 for j,c in enumerate((allocation(6180000,40)+allocation(total-6180000,n-40)) if feat=='Document processing' else allocation(total,n)):
  is_job=feat=='Document processing' and j<40
  t=trace(offset+j,feat,c,20 if is_job else 1+j%20,'Production' if is_job else ('Development' if j%5==0 else 'Production'),group='nightly-document-import / 20 Sep' if is_job else None)
  if is_job and j>=38:t['state']='In progress'
for t in traces:
 if t['id']=='search-request-1042':
  for c,key in zip(t['calls'],['embedding','ranking','context-summary','generation','generation-retry']):c['stepKey']=key
 if t['id']=='search-request-0981':
  for c,key in zip(t['calls'],['embedding','ranking','generation']):c['stepKey']=key
traces.sort(key=lambda t:(t['day'],t['hour'],t['minute'],t['second']),reverse=True)
assert len(traces)==1900
assert sum(t['cost'] for t in traces)==248600000
for t in traces:assert sum(c['cost'] for c in t['calls'])==t['cost'],t['id']
(Path(__file__).resolve().parent / 'data.js').write_text('const TRACE_DATA = '+json.dumps(traces,separators=(',',':'))+';\n')
print('1900 fully reconciled synthetic traces',len((Path(__file__).resolve().parent / 'data.js').read_bytes()))
