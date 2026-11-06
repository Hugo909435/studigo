import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../lib/store.mjs';
import { browserStatus, browserBlockers, saveBrowserAccount, browserJobs, claimBrowserJob, browserResult, recoverBrowserJobs } from '../lib/browser-agent.mjs';
import { createWorker, purgeDelivered } from '../lib/worker.mjs';
import { coverFor } from '../lib/planning.mjs';

async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'studigo-agent-')),store=createStore(directory);t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});});return store;}
const now=Date.UTC(2026,10,6,12);
const account={network:'facebook',id:'page-quiz',name:'Ma Page Quiz',features:{schedule:true,customCover:true,playlist:true},maxAdvanceDays:28,minAdvanceMinutes:20,evidence:'Options constatées dans le brouillon de la Page Quiz.'};
function publication(){return {id:'11111111-1111-4111-8111-111111111111',status:'scheduled',createdAt:new Date(now).toISOString(),media:'video.mp4',covers:{common:{file:'common.png',mime:'image/png',size:24},facebook:{file:'fb.png',mime:'image/png',size:24}},destinations:{facebook:{provider:'browser',state:'agent_queued',accountId:account.id,title:'Le quiz',description:'Texte propre',scheduledAt:new Date(now+3600000).toISOString(),facebookPlaylist:'Culture générale'}}};}

test('navigateur : capacités vérifiées, identité liée et réservation unique, sans exposer de chemins',async t=>{
  const store=await fixture(t),p=publication();store.save(p);
  assert.ok(browserBlockers(store,p,'facebook',p.destinations.facebook,now).length>=1);
  saveBrowserAccount(store,{...account,features:{schedule:true}},now);
  assert.match(browserBlockers(store,p,'facebook',p.destinations.facebook,now).join(' '),/couverture.*playlist/i);
  saveBrowserAccount(store,account,now);assert.equal(browserStatus(store,now).online,true);assert.equal(browserStatus(store,now+16*60000).online,false);
  assert.deepEqual(browserBlockers(store,p,'facebook',p.destinations.facebook,now),[]);
  const jobs=browserJobs(store,now);assert.equal(jobs.length,1);assert.ok(!JSON.stringify(jobs).includes('fb.png'));assert.ok(!JSON.stringify(jobs).includes('video.mp4'));assert.ok(jobs[0].coverUrl.endsWith('network=facebook&effective=true'));
  const claim=claimBrowserJob(store,p,'facebook',now);assert.ok(claim.token);assert.equal(browserJobs(store,now).length,0);assert.throws(()=>claimBrowserJob(store,p,'facebook',now),/prise en charge/);
  assert.throws(()=>browserResult(store,p,'facebook',{action:'begin',token:'wrong'},now),/incorrecte/);
  assert.equal(coverFor(p,'facebook').file,'fb.png');assert.equal(coverFor(p,'instagram').file,'common.png');assert.equal(coverFor({cover:{file:'legacy.png'}},'instagram'),null);
});

test('navigateur : aucune suppression à la programmation, publication vérifiée après échéance seulement',async t=>{
  const store=await fixture(t),p=publication();store.save(p);for(const name of ['video.mp4','common.png','fb.png'])await writeFile(join(store.media,name),'test');
  saveBrowserAccount(store,account,now);const claim=claimBrowserJob(store,p,'facebook',now);
  const evidence={action:'finish',token:claim.token,outcome:'scheduled',accountId:account.id,remoteId:'123',url:'https://business.facebook.com/latest/content_calendar',scheduledAt:p.destinations.facebook.scheduledAt,evidence:'Confirmation visible dans le calendrier de la Page.',verified:{schedule:true,customCover:true,playlist:true}};
  assert.throws(()=>browserResult(store,p,'facebook',evidence,now),/validation finale/);
  browserResult(store,p,'facebook',{action:'begin',token:claim.token},now);
  assert.throws(()=>browserResult(store,p,'facebook',{...evidence,accountId:'autre'},now),/identité/);
  assert.throws(()=>browserResult(store,p,'facebook',{...evidence,verified:{schedule:true}},now),/réglages/);
  assert.throws(()=>browserResult(store,p,'facebook',{...evidence,scheduledAt:new Date(now).toISOString()},now),/horaire/);
  browserResult(store,p,'facebook',evidence,now);assert.equal(p.destinations.facebook.state,'remote_scheduled');assert.equal(await purgeDelivered(store,p),false);await access(join(store.media,'video.mp4'));
  assert.equal(browserJobs(store,now).length,0);assert.equal(browserJobs(store,now+3600001).length,1);
  const delivered={...evidence,action:'check',outcome:'delivered',url:'https://www.facebook.com/reel/123'};
  assert.throws(()=>browserResult(store,p,'facebook',delivered,now),/future/);
  assert.throws(()=>browserResult(store,p,'facebook',{...delivered,remoteId:'456'},now+3600001),/origine/);
  assert.throws(()=>browserResult(store,p,'facebook',{...delivered,url:evidence.url},now+3600001),/vidéo publiée/);
  browserResult(store,p,'facebook',delivered,now+3600001);assert.equal(await purgeDelivered(store,p),true);assert.equal(p.status,'complete');assert.equal(store.bytes(),0);
});

test('navigateur : interruption ambiguë sans reprise ni repli API, même après échéance',async t=>{
  const store=await fixture(t),p=publication();store.save(p);await writeFile(join(store.media,'video.mp4'),'test');saveBrowserAccount(store,account,now);
  let calls=0;const worker=createWorker(store,{facebook:async()=>{calls++;}},{now:()=>now+2*3600000});
  await worker();assert.equal(calls,0);
  const claim=claimBrowserJob(store,p,'facebook',now);browserResult(store,p,'facebook',{action:'begin',token:claim.token},now);
  recoverBrowserJobs(store,now+31*60000);const recovered=store.get(p.id);assert.equal(recovered.destinations.facebook.state,'attention');assert.equal(browserJobs(store,now+31*60000).length,0);
  await worker();assert.equal(calls,0);await access(join(store.media,'video.mp4'));
  assert.throws(()=>browserResult(store,recovered,'facebook',{action:'begin',token:claim.token},now+31*60000),/incorrecte/);
});
