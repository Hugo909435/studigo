import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.mjs';
import { createWorker, purgeDelivered } from '../lib/worker.mjs';
import { vault, mediaSignature, createProviders } from '../lib/providers.mjs';

async function fixture(t,destinations,scheduledAt=new Date(Date.now()-1000).toISOString()) {
  const dir=await mkdtemp(join(tmpdir(),'cq-test-'));const store=createStore(dir);
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const p={id:'test',createdAt:new Date().toISOString(),status:'scheduled',media:'test.mp4',size:12,title:'Un quiz',description:'Description',madeForKids:false,scheduledAt,destinations};
  await writeFile(join(store.media,p.media),'sample video');store.save(p);return {store,p,file:join(store.media,p.media)};
}
test('conserve une seule copie tant que TikTok attend une confirmation',async t=>{
  const {store,p,file}=await fixture(t,{youtube:{state:'delivered'},tiktok:{state:'manual'}});
  assert.equal(await purgeDelivered(store,p),false);await access(file);
  p.destinations.tiktok.state='delivered';store.save(p);
  assert.equal(await purgeDelivered(store,p),true);await assert.rejects(access(file));
  assert.equal(store.get(p.id).media,null);assert.equal(store.get(p.id).status,'complete');assert.equal(store.get(p.id).title,'Un quiz');
});
test('un échec conserve le fichier, suspend les relances et laisse avancer les autres réseaux',async t=>{
  const {store,file}=await fixture(t,{facebook:{state:'pending'},instagram:{state:'pending'}});let calls=0;
  const worker=createWorker(store,{facebook:async()=>{calls++;throw new Error('token secret');},instagram:async(p,d,save)=>{d.state='delivered';save();}});
  await worker();await worker();await access(file);
  const p=store.get('test');assert.equal(calls,1);assert.equal(p.destinations.facebook.state,'attention');assert.equal(p.destinations.instagram.state,'delivered');assert.ok(!p.destinations.facebook.error.includes('secret'));
});
test('YouTube peut partir en avance, Meta attend la date',async t=>{
  const {store}=await fixture(t,{youtube:{state:'pending'},facebook:{state:'pending'}},new Date(Date.now()+86400000).toISOString());const calls=[];
  const worker=createWorker(store,{youtube:async(p,d,save)=>{calls.push('youtube');d.state='delivered';save();},facebook:async()=>calls.push('facebook')});await worker();assert.deepEqual(calls,['youtube']);
});
test('un redémarrage reprend le traitement confirmé sans réenvoyer un réseau livré',async t=>{
  const {store,file}=await fixture(t,{youtube:{state:'delivered'},instagram:{state:'processing',remoteId:'container'}});let calls=0;
  const worker=createWorker(store,{youtube:async()=>assert.fail('Ne pas réenvoyer'),instagram:async(p,d,save)=>{calls++;assert.equal(d.remoteId,'container');d.state='delivered';save();}});
  await worker();await worker();assert.equal(calls,1);await assert.rejects(access(file));
});
test('les cycles concurrents ne provoquent pas de double envoi',async t=>{
  const {store}=await fixture(t,{youtube:{state:'pending'}});let release;const gate=new Promise(r=>release=r);let calls=0;
  const worker=createWorker(store,{youtube:async(p,d,save)=>{calls++;await gate;d.state='delivered';save();}});
  const first=worker();await worker();release();await first;assert.equal(calls,1);
});
test('les jetons sont chiffrés et une clé incorrecte ne les déchiffre pas',()=>{
  const box=vault('a'.repeat(32));const encrypted=box.encrypt({refresh_token:'secret-refresh'});assert.ok(!encrypted.includes('secret-refresh'));assert.deepEqual(box.decrypt(encrypted),{refresh_token:'secret-refresh'});assert.throws(()=>vault('b'.repeat(32)).decrypt(encrypted));
});
test('les liens média sont liés au fichier et à leur expiration',()=>{
  const s=mediaSignature('secret','one',123);assert.notEqual(s,mediaSignature('secret','two',123));assert.notEqual(s,mediaSignature('secret','one',124));
});
test('YouTube envoie la programmation et attend le traitement avant de confirmer',async t=>{
  const {store,p}=await fixture(t,{youtube:{state:'pending'}},new Date(Date.now()+86400000).toISOString());
  const secret='s'.repeat(32);store.setting('google',vault(secret).encrypt({access_token:'test',expiresAt:Date.now()+3600000}));
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);let calls=0;
  globalThis.fetch=async(url,options)=>{
    calls++;
    if(calls===1){const data=JSON.parse(options.body);assert.equal(data.status.privacyStatus,'private');assert.equal(data.status.publishAt,p.scheduledAt);assert.equal(data.status.selfDeclaredMadeForKids,false);return new Response('',{headers:{location:'https://www.googleapis.com/upload/session'}});}
    if(calls===2){for await(const chunk of options.body)assert.ok(chunk.length);return Response.json({id:'yt123'});}
    return Response.json({items:[{processingDetails:{processingStatus:'succeeded'},status:{uploadStatus:'processed'}}]});
  };
  const providers=createProviders(store,{secret});const d=p.destinations.youtube;
  await providers.youtube(p,d,()=>store.save(p));assert.equal(d.state,'processing');
  await providers.youtube(p,d,()=>store.save(p));assert.equal(d.state,'delivered');assert.equal(d.url,'https://www.youtube.com/watch?v=yt123');
});
