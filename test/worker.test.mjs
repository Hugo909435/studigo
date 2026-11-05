import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.mjs';
import { createWorker, purgeDelivered } from '../lib/worker.mjs';
import { vault, mediaSignature, createProviders, createGoogleClient } from '../lib/providers.mjs';

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

test('Buffer attend le créneau puis une publication TikTok confirmée, et toutes les autres destinations',async t=>{
  let now=Date.now();
  const {store,file}=await fixture(t,{tiktok:{state:'pending',provider:'buffer',channelId:'channel'},facebook:{state:'manual'}},new Date(now+60000).toISOString());
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);let creates=0,reads=0;
  const statuses=['scheduled','sending','sent'];
  globalThis.fetch=async(url,options)=>{
    assert.equal(url,'https://api.buffer.com');assert.equal(options.headers.Authorization,'Bearer test-key');
    const request=JSON.parse(options.body);
    if(request.query.includes('mutation')) {
      creates++;assert.equal(store.get('test').destinations.tiktok.state,'publishing');
      assert.equal(request.variables.input.mode,'shareNow');assert.equal(request.variables.input.schedulingType,'automatic');
      const media=new URL(request.variables.input.assets[0].video.url);assert.equal(media.pathname,'/media/test.mp4');
      assert.equal(media.searchParams.get('signature'),mediaSignature('s'.repeat(32),'test',Number(media.searchParams.get('expires'))));
      return Response.json({data:{createPost:{post:{id:'buffer-post',channelId:'channel'}}}});
    }
    reads++;return Response.json({data:{post:{id:'buffer-post',channelId:'channel',channelService:'tiktok',status:statuses.shift(),schedulingType:'automatic',externalLink:'https://www.tiktok.com/@quiz/video/123'}}});
  };
  const config={secret:'s'.repeat(32),appUrl:'https://studio.example',bufferKey:'test-key'};
  const worker=createWorker(store,createProviders(store,config,{now:()=>now}),{now:()=>now});
  await worker();assert.equal(creates,0);
  now+=60000;await worker();assert.equal(creates,1);assert.equal(store.get('test').destinations.tiktok.state,'processing');await access(file);
  await worker();assert.equal(reads,0);
  for(let i=0;i<3;i++){now=store.get('test').destinations.tiktok.nextPollAt;await worker();await access(file);}
  assert.equal(creates,1);assert.equal(reads,3);assert.equal(store.get('test').destinations.tiktok.state,'delivered');
  const p=store.get('test');p.destinations.facebook.state='delivered';store.save(p);await worker();await assert.rejects(access(file));
});

test('Buffer : mutation ambiguë suspendue sans doublon ni suppression',async t=>{
  const {store,file}=await fixture(t,{tiktok:{state:'pending',provider:'buffer',channelId:'channel'}});
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('timeout après acceptation possible');};
  const worker=createWorker(store,createProviders(store,{secret:'s'.repeat(32),appUrl:'https://studio.example',bufferKey:'key'}));
  await worker();await worker();assert.equal(calls,1);assert.equal(store.get('test').destinations.tiktok.state,'attention');await access(file);
});

test('Buffer : reprise de lecture après erreur temporaire sans recréer le post',async t=>{
  let now=Date.now();const {store,file}=await fixture(t,{tiktok:{state:'processing',provider:'buffer',channelId:'channel',remoteId:'buffer-post',mediaExpiresAt:now+86400000}});
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);let calls=0;
  globalThis.fetch=async(url,options)=>{calls++;assert.ok(!JSON.parse(options.body).query.includes('mutation'));if(calls===1)throw new Error('network');return Response.json({data:{post:{id:'buffer-post',channelId:'channel',channelService:'tiktok',status:'sent',schedulingType:'automatic',externalLink:'https://www.tiktok.com/@quiz/video/123'}}});};
  const worker=createWorker(store,createProviders(store,{bufferKey:'key',secret:'s'.repeat(32)},{now:()=>now}));
  await worker();await access(file);assert.equal(store.get('test').destinations.tiktok.state,'processing');
  await worker();assert.equal(calls,1);now=store.get('test').destinations.tiktok.nextPollAt;await worker();assert.equal(calls,2);await assert.rejects(access(file));
});

test('Buffer : notification, mauvais compte, erreur ou expiration ne confirment jamais la réception',async t=>{
  for(const scenario of ['notification','wrong-channel','error','expired','no-link','graphql']) await t.test(scenario,async t=>{
    const now=Date.now();const {store,file}=await fixture(t,{tiktok:{state:'processing',provider:'buffer',channelId:'channel',remoteId:'buffer-post',mediaExpiresAt:now+(scenario==='expired'?-1:86400000)}});
    const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
    globalThis.fetch=async()=>Response.json(scenario==='graphql'?{errors:[{message:'private secret'}]}:{data:{post:{id:'buffer-post',channelId:scenario==='wrong-channel'?'other':'channel',channelService:'tiktok',status:scenario==='error'?'error':scenario==='expired'?'scheduled':'sent',schedulingType:scenario==='notification'?'notification':'automatic',externalLink:scenario==='no-link'?null:'https://www.tiktok.com/@quiz/video/123'}}});
    await createWorker(store,createProviders(store,{bufferKey:'key',secret:'s'.repeat(32)},{now:()=>now}))();
    await access(file);assert.notEqual(store.get('test').destinations.tiktok.state,'delivered');
    if(!['no-link','graphql'].includes(scenario))assert.equal(store.get('test').destinations.tiktok.state,'attention');
  });
});

test('horaires et textes propres à chaque réseau, conservation du MP4 jusqu’au dernier créneau',async t=>{
  let now=Date.now();const {store,file}=await fixture(t,{facebook:{state:'pending',title:'Facebook à midi',description:'Texte Facebook',scheduledAt:new Date(now+60000).toISOString()},tiktok:{state:'pending',title:'TikTok le soir',description:'Texte TikTok',scheduledAt:new Date(now+120000).toISOString()}});
  const calls=[];const record=async(p,d,save)=>{calls.push({title:p.title,description:p.description});d.state='delivered';save();};
  const worker=createWorker(store,{facebook:record,tiktok:record},{now:()=>now});
  await worker();assert.equal(calls.length,0);now+=60000;await worker();await access(file);assert.deepEqual(calls,[{title:'Facebook à midi',description:'Texte Facebook'}]);
  now+=60000;await worker();assert.equal(calls[1].title,'TikTok le soir');assert.equal(calls[1].description,'Texte TikTok');await assert.rejects(access(file));
});

test('YouTube : une vidéo traitée est classée dans les playlists choisies avant confirmation',async t=>{
  const {store,p,file}=await fixture(t,{youtube:{state:'processing',remoteId:'video',playlistIds:['PLfirst','PLsecond'],title:'YouTube uniquement'}});
  const secret='s'.repeat(32);store.setting('google',vault(secret).encrypt({access_token:'test',expiresAt:Date.now()+3600000}));
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);const additions=[];
  globalThis.fetch=async(url,options)=>{
    if(String(url).includes('videos?'))return Response.json({items:[{processingDetails:{processingStatus:'succeeded'}}]});
    assert.ok(String(url).endsWith('playlistItems?part=snippet'));const body=JSON.parse(options.body);assert.equal(body.snippet.resourceId.videoId,'video');
    assert.equal(store.get(p.id).destinations.youtube.state,'publishing');additions.push(body.snippet.playlistId);return Response.json({id:'playlist-item-'+additions.length});
  };
  await createWorker(store,createProviders(store,{secret}))();assert.deepEqual(additions,['PLfirst','PLsecond']);assert.deepEqual(store.get(p.id).destinations.youtube.addedPlaylistIds,additions);await assert.rejects(access(file));
});

test('YouTube : résultat ambigu de classement ne réimporte ni vidéo ni playlist',async t=>{
  const {store,file}=await fixture(t,{youtube:{state:'processing',remoteId:'video',playlistIds:['PLfirst']}});
  const secret='s'.repeat(32);store.setting('google',vault(secret).encrypt({access_token:'test',expiresAt:Date.now()+3600000}));
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);let additions=0;
  globalThis.fetch=async url=>{if(String(url).includes('videos?'))return Response.json({items:[{processingDetails:{processingStatus:'succeeded'}}]});additions++;throw new Error('réponse perdue');};
  const worker=createWorker(store,createProviders(store,{secret}));await worker();await worker();assert.equal(additions,1);assert.equal(store.get('test').destinations.youtube.state,'attention');assert.match(store.get('test').destinations.youtube.error,/classement/);await access(file);
});

test('YouTube : visibilité non répertoriée attend son créneau et ne programme pas de publication publique',async t=>{
  let now=Date.now();const {store,p}=await fixture(t,{youtube:{state:'pending',privacy:'unlisted',scheduledAt:new Date(now+60000).toISOString()}});
  const secret='s'.repeat(32);store.setting('google',vault(secret).encrypt({access_token:'test',expiresAt:Date.now()+3600000}));
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);let calls=0;
  globalThis.fetch=async(url,options)=>{calls++;if(calls===1){const body=JSON.parse(options.body);assert.equal(body.status.privacyStatus,'unlisted');assert.equal(body.status.publishAt,undefined);return new Response('',{headers:{location:'https://www.googleapis.com/upload/session'}});}for await(const chunk of options.body)assert.ok(chunk.length);return Response.json({id:'video'});};
  const worker=createWorker(store,createProviders(store,{secret}),{now:()=>now});await worker();assert.equal(calls,0);now+=60000;await worker();assert.equal(calls,2);assert.equal(store.get(p.id).destinations.youtube.state,'processing');
});

test('YouTube : playlists paginées et autorisation supplémentaire détectée sans invalider la connexion existante',async t=>{
  const {store}=await fixture(t,{});const secret='s'.repeat(32),box=vault(secret);
  const tokens={access_token:'test',expiresAt:Date.now()+3600000,scope:'https://www.googleapis.com/auth/youtube.readonly'};
  store.setting('google',box.encrypt(tokens));const google=createGoogleClient(store,{secret});assert.equal(google.canManagePlaylists(),false);
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);let calls=0;
  globalThis.fetch=async url=>{calls++;if(calls===2)assert.match(String(url),/pageToken=next/);return Response.json({items:[{id:'PL'+calls,snippet:{title:'Quiz '+calls},status:{privacyStatus:'private'}}],...(calls===1?{nextPageToken:'next'}:{})});};
  const playlists=await google.playlists();assert.equal(playlists.length,2);assert.equal(calls,2);
  store.setting('google',box.encrypt({...tokens,scope:tokens.scope+' https://www.googleapis.com/auth/youtube.force-ssl'}));assert.equal(google.canManagePlaylists(),true);
});

test('Facebook et Instagram via Buffer : Reels et réception confirmée par le bon réseau avant suppression',async t=>{
  for(const network of ['facebook','instagram']) await t.test(network,async t=>{
    let now=Date.now();const {store,file}=await fixture(t,{[network]:{state:'pending',provider:'buffer',channelId:network+'-channel',title:'Titre propre',description:'Description propre'}});
    const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);let creates=0;
    globalThis.fetch=async(url,options)=>{
      assert.equal(url,'https://api.buffer.com');const request=JSON.parse(options.body);
      if(request.query.includes('mutation')){
        creates++;const input=request.variables.input;assert.equal(input.text,'Titre propre\n\nDescription propre');assert.equal(input.mode,'shareNow');assert.equal(input.metadata[network].type,'reel');
        if(network==='instagram')assert.equal(input.metadata.instagram.shouldShareToFeed,true);
        assert.equal(store.get('test').destinations[network].state,'publishing');
        return Response.json({data:{createPost:{post:{id:'remote-'+network,channelId:network+'-channel'}}}});
      }
      return Response.json({data:{post:{id:'remote-'+network,channelId:network+'-channel',channelService:network,status:'sent',schedulingType:'automatic',externalLink:network==='instagram'?'https://www.instagram.com/reel/Abc123/':'https://www.facebook.com/reel/123456'}}});
    };
    const worker=createWorker(store,createProviders(store,{secret:'s'.repeat(32),bufferKey:'test-key',appUrl:'https://studio.example'},{now:()=>now}),{now:()=>now});
    await worker();await access(file);assert.equal(store.get('test').destinations[network].state,'processing');
    await worker();assert.equal(creates,1);now=store.get('test').destinations[network].nextPollAt;await worker();assert.equal(creates,1);await assert.rejects(access(file));
  });
});

test('Buffer Meta : pas de réception sur notification, mauvais réseau ou mauvais lien, ni de repli Direct Post',async t=>{
  for(const network of ['facebook','instagram']) for(const scenario of ['notification','wrong-service','wrong-url','timeout']) await t.test(network+' '+scenario,async t=>{
    const now=Date.now();const {store,file}=await fixture(t,{[network]:{state:scenario==='timeout'?'pending':'processing',provider:'buffer',channelId:'channel',remoteId:'remote',mediaExpiresAt:now+86400000}});
    const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);let mutations=0;
    globalThis.fetch=async(url,options)=>{assert.equal(url,'https://api.buffer.com');if(JSON.parse(options.body).query.includes('mutation')){mutations++;throw new Error('timeout');}return Response.json({data:{post:{id:'remote',channelId:'channel',channelService:scenario==='wrong-service'?'tiktok':network,status:'sent',schedulingType:scenario==='notification'?'notification':'automatic',externalLink:scenario==='wrong-url'?'https://evil.example/reel/123':network==='instagram'?'https://www.instagram.com/reel/Abc123/':'https://www.facebook.com/reel/123'}}});};
    const worker=createWorker(store,createProviders(store,{secret:'s'.repeat(32),bufferKey:'key',appUrl:'https://studio.example'},{now:()=>now}));
    await worker();await worker();assert.equal(store.get('test').destinations[network].state,'attention');assert.equal(mutations,scenario==='timeout'?1:0);await access(file);
  });
});

test('les anciennes destinations Meta ne sont jamais basculées automatiquement vers Buffer',async t=>{
  const {store,file}=await fixture(t,{facebook:{state:'pending'},instagram:{state:'pending'}});
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);let calls=0;
  globalThis.fetch=async url=>{calls++;assert.ok(String(url).startsWith('https://graph.facebook.com/'));return new Response('',{status:403});};
  await createWorker(store,createProviders(store,{secret:'s'.repeat(32),bufferKey:'key',metaVersion:'v24.0',metaToken:'test',pageId:'page',instagramId:'ig'}))();
  assert.equal(calls,2);await access(file);
});
