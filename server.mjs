import { createServer } from 'node:http';
import { createReadStream, createWriteStream, readdirSync, unlinkSync } from 'node:fs';
import { readFile, rename, unlink, stat, open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { createStore } from './lib/store.mjs';
import { destinationPlan, coverFor } from './lib/planning.mjs';
import { browserStatus, browserBlockers, saveBrowserAccount, browserJobs, claimBrowserJob, browserResult, recoverBrowserJobs } from './lib/browser-agent.mjs';
import { createWorker, purgeDelivered } from './lib/worker.mjs';
import { createProviders, createGoogleClient, vault, jsonFetch, mediaSignature } from './lib/providers.mjs';

const base=dirname(fileURLToPath(import.meta.url));
// Les hébergeurs peuvent lancer le fichier directement, sans passer par npm start.
let envFileLoaded=false;
try { loadEnvFile(join(base,'.env')); envFileLoaded=true; } catch(e) { if(e.code!=='ENOENT') throw e; }
const env=process.env;
if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length<16 || !env.MEDIA_SECRET || env.MEDIA_SECRET.length<32) {
  for(const [key,min] of [['ADMIN_PASSWORD',16],['MEDIA_SECRET',32]]) {
    if(!env[key] || env[key].length<min) console.error(`${key} : ${env[key]?'trop court':'absent'} (${env[key]?.length || 0} caractères ; minimum ${min}).`);
  }
  console.error(`Configuration de démarrage invalide. Fichier .env ${envFileLoaded?'chargé':'absent'} à côté de server.mjs.`); process.exit(1);
}
const config={secret:env.MEDIA_SECRET,appUrl:(env.APP_URL || 'http://127.0.0.1:4310').replace(/\/$/,''),googleId:env.GOOGLE_CLIENT_ID,googleSecret:env.GOOGLE_CLIENT_SECRET,metaVersion:env.META_GRAPH_VERSION || 'v24.0',metaToken:env.META_PAGE_TOKEN,pageId:env.META_PAGE_ID,instagramId:env.INSTAGRAM_USER_ID,bufferKey:env.BUFFER_API_KEY,bufferChannel:env.BUFFER_TIKTOK_CHANNEL_ID,bufferFacebook:env.BUFFER_FACEBOOK_CHANNEL_ID,bufferInstagram:env.BUFFER_INSTAGRAM_CHANNEL_ID};
const secure=new URL(config.appUrl).protocol==='https:';
if (!secure && !['127.0.0.1','localhost'].includes(new URL(config.appUrl).hostname)) throw new Error('HTTPS requis hors localhost');
const store=createStore(resolve(base,env.DATA_DIR || 'data'));
// Les imports interrompus ne sont pas des vidéos programmées ; aucune archive .part.
for(const name of readdirSync(store.media)) if(/^[a-f0-9-]{36}\.part$/.test(name)) unlinkSync(join(store.media,name));
const sessions=new Map(); const loginAttempts=new Map(); const oauthStates=new Map();
const locks=new Set();
const box=vault(config.secret); const google=createGoogleClient(store,config); const worker=createWorker(store,createProviders(store,config),{locks,isEnabled:network=>network!=='youtube'||!!store.setting('google')&&!store.setting('youtubePaused')});
const maxUpload=Number(env.MAX_UPLOAD_MB || 1024)*1024*1024;
const maxStorage=Number(env.MAX_STORAGE_MB || 5120)*1024*1024;
if (![maxUpload,maxStorage].every(n=>Number.isFinite(n)&&n>0)) throw new Error('Quotas invalides');
let uploading=false;
function fail(status,message) { throw Object.assign(new Error(message),{status}); }
const equal=(a,b)=>timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
function send(res,status,value) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); }
async function body(req) { let text=''; for await(const b of req) { text+=b; if(Buffer.byteLength(text)>65536) fail(413,'Requête trop grande'); } try { return JSON.parse(text); } catch { fail(400,'Données invalides'); } }
function connected() { return { youtube:!!store.setting('google')&&!store.setting('youtubePaused'), facebook:!!(config.bufferKey&&config.bufferFacebook || config.metaToken&&config.pageId), instagram:!!(config.bufferKey&&config.bufferInstagram || config.metaToken&&config.instagramId), tiktok:!!(config.bufferKey&&config.bufferChannel) }; }
function publicPost(p) { const {media,cover,covers,...rest}=p; const safe=c=>c?{mime:c.mime,size:c.size}:null;return {...rest,hasMedia:!!media,cover:safe(cover),covers:Object.fromEntries(Object.entries(covers || {}).map(([n,c])=>[n,safe(c)]))}; }
function owned(id) { const p=store.get(id); if(!p) fail(404,'Publication introuvable'); return p; }
function preparePlans(p,data) {
  if(!Array.isArray(data.networks)||!data.networks.length||data.networks.some(n=>!['youtube','facebook','instagram','tiktok'].includes(n)))fail(400,'Choisir au moins un réseau');
  if(data.deliveryMode!==undefined&&data.deliveryMode!=='auto')fail(400,'Mode d’envoi invalide');
  const tiktokMode=data.tiktokMode || 'manual';if(!['manual','buffer'].includes(tiktokMode))fail(400,'Mode TikTok invalide');
  const plans={},checks=[],ready=connected();
  for(const network of [...new Set(data.networks)]) {
    const input=data.destinationSettings?.[network] ?? {},plan=destinationPlan(network,input,data),issues=[];
    if(coverFor(p,network)&&plan.thumbnailOffset!==undefined)issues.push('Choisir soit une image importée, soit un instant de la vidéo.');
    if(network==='tiktok'&&data.deliveryMode==='auto'&&typeof(input.tiktokAiGenerated ?? data.tiktokAiGenerated)!=='boolean')issues.push('Indiquer si la vidéo TikTok est générée par IA.');
    const browser=data.deliveryMode==='auto'&&network!=='youtube'&&(!!coverFor(p,network)||!!plan.facebookPlaylist||Object.keys(plan.nativeOptions || {}).length>0);
    const bufferTarget=network==='facebook'?config.bufferFacebook:network==='instagram'?config.bufferInstagram:config.bufferChannel;
    let routing;
    if(browser) {
      issues.push(...browserBlockers(store,p,network,plan));
      routing={state:'agent_queued',provider:'browser',accountId:browserStatus(store).accounts[network]?.id};
    } else if(network==='tiktok'&&data.deliveryMode!=='auto'&&tiktokMode==='manual')routing={state:'manual'};
    else {
      if(!ready[network])issues.push('Compte à connecter avant la programmation.');
      if(network==='tiktok'&&typeof(input.tiktokAiGenerated ?? data.tiktokAiGenerated)!=='boolean')issues.push('Indiquer si la vidéo TikTok est générée par IA.');
      if(network==='instagram'&&plan.thumbnailOffset!==undefined&&!(bufferTarget&&config.bufferKey))issues.push('Le choix d’une image de la vidéo nécessite Buffer.');
      if(network!=='youtube'&&coverFor(p,network))issues.push('L’envoi sélectionné ne prend pas en charge l’image importée. Utiliser le lancement centralisé.');
      if(network==='facebook'&&plan.facebookPlaylist)issues.push('Le classement en playlist Facebook nécessite le navigateur vérifié.');
      if(Object.keys(plan.nativeOptions || {}).length)issues.push('Les options avancées nécessitent le lancement centralisé et le navigateur vérifié.');
      routing=network!=='youtube'&&bufferTarget&&config.bufferKey?{state:'pending',provider:'buffer',channelId:bufferTarget}:{state:'pending'};
    }
    if(network==='youtube'&&plan.playlistIds.length&&!google.canManagePlaylists())issues.push('Reconnecter YouTube pour autoriser les playlists.');
    plans[network]={...plan,...(network==='youtube'&&store.setting('googleChannel')?{youtubeChannelId:store.setting('googleChannel').id}:{}),...routing};
    checks.push({network,route:routing.provider || (routing.state==='manual'?'manual':'api'),issues,waitingForAgent:routing.provider==='browser'&&!browserStatus(store).online});
  }
  return {plans,checks,ready:checks.every(c=>c.issues.length===0)};
}

// Les états ambigus après un arrêt ne sont jamais relancés automatiquement.
for(const p of store.list()) for(const d of Object.values(p.destinations)) if(['uploading','publishing'].includes(d.state)) { d.state='attention'; d.error='Serveur redémarré pendant un envoi. Vérifie le réseau et confirme la réception manuellement.'; store.save(p); }

const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-Frame-Options','DENY'); res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
  try {
    const url=new URL(req.url,config.appUrl); const path=url.pathname;
    if (req.method==='GET' && path==='/health') return send(res,200,{ok:true});
    // Seul le fichier signé est accessible à Meta et Buffer, sans ouvrir le tableau de bord.
    const signedMedia=path.match(/^\/media\/([a-f0-9-]+)(?:\.mp4)?$/);
    if (['GET','HEAD'].includes(req.method) && signedMedia) {
      const id=signedMedia[1], expires=Number(url.searchParams.get('expires'));
      if(!Number.isFinite(expires)||expires<Date.now()||expires>Date.now()+25*3600000||!equal(url.searchParams.get('signature') || '',mediaSignature(config.secret,id,expires))) fail(403,'Lien expiré');
      return await streamMedia(req,res,owned(id));
    }
    const sid=req.headers.cookie?.split('; ').find(v=>v.startsWith('studio='))?.slice(7);
    const session=sessions.get(sid);
    const authenticated=session && session.expires>Date.now();
    if(['POST','PUT','DELETE','PATCH'].includes(req.method) && req.headers.origin!==new URL(config.appUrl).origin) fail(403,'Origine refusée');
    if(req.method==='POST' && path==='/api/login') {
      const ip=req.socket.remoteAddress; const attempt=loginAttempts.get(ip) || {n:0,until:Date.now()+900000};
      if(attempt.until<Date.now()) { attempt.n=0; attempt.until=Date.now()+900000; }
      if(attempt.n>=10) fail(429,'Trop de tentatives. Réessaie dans 15 minutes.');
      const data=await body(req); attempt.n++; loginAttempts.set(ip,attempt);
      if(typeof data.password!=='string'||!equal(data.password,env.ADMIN_PASSWORD)) fail(401,'Mot de passe incorrect');
      loginAttempts.delete(ip); if(sid) sessions.delete(sid);
      const token=randomBytes(32).toString('hex'); sessions.set(token,{expires:Date.now()+12*3600000});
      res.setHeader('Set-Cookie',`studio=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure?'; Secure':''}`);
      return send(res,200,{ok:true});
    }
    if(path.startsWith('/api/') || path.startsWith('/auth/')) {
      if(!authenticated) fail(401,'Connexion requise');
      if(req.method==='POST' && path==='/api/logout') { sessions.delete(sid); res.setHeader('Set-Cookie','studio=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); return send(res,200,{ok:true}); }
      if(req.method==='GET' && path==='/api/state') return send(res,200,{posts:store.list().map(publicPost),connections:connected(),browserAgent:browserStatus(store),bufferNetworks:{tiktok:!!(config.bufferKey&&config.bufferChannel),facebook:!!(config.bufferKey&&config.bufferFacebook),instagram:!!(config.bufferKey&&config.bufferInstagram)},googleConfigured:!!(config.googleId&&config.googleSecret),youtubeChannel:store.setting('googleChannel') || null,youtubePending:store.setting('googlePending')?.expiresAt>Date.now()?store.setting('googlePending').channel:null,youtubePaused:!!store.setting('youtubePaused'),youtubePlaylistsEnabled:google.canManagePlaylists(),youtubePlaylists:store.setting('youtubePlaylists') || [],defaults:store.setting('defaults') || {},storage:{used:store.bytes(),limit:maxStorage,maxUpload},timezone:'Europe/Paris'});
      if(req.method==='POST'&&path==='/api/browser/heartbeat') {const previous=browserStatus(store);store.setting('browserAgent',{accounts:previous.accounts,lastSeenAt:new Date().toISOString()});recoverBrowserJobs(store);return send(res,200,browserStatus(store));}
      if(req.method==='POST'&&path==='/api/browser/account') return send(res,200,saveBrowserAccount(store,await body(req)));
      if(req.method==='GET'&&path==='/api/browser/jobs')return send(res,200,{jobs:browserJobs(store)});
      if(req.method==='POST'&&['/api/browser/claim','/api/browser/result'].includes(path)) {
        const data=await body(req),p=owned(data.postId);if(locks.has(p.id))fail(409,'Publication occupée');
        locks.add(p.id);try{const result=path.endsWith('/claim')?claimBrowserJob(store,p,data.network):browserResult(store,p,data.network,data);if(path.endsWith('/result'))await purgeDelivered(store,p);return send(res,200,result);}finally{locks.delete(p.id);}
      }
      if(req.method==='GET' && path==='/auth/youtube') {
        if(!config.googleId||!config.googleSecret) fail(409,'Configurer les identifiants Google sur le serveur');
        const state=randomBytes(24).toString('hex'); oauthStates.set(state,{sid,expires:Date.now()+600000});
        const params=new URLSearchParams({client_id:config.googleId,redirect_uri:`${config.appUrl}/auth/youtube/callback`,response_type:'code',scope:'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl',access_type:'offline',prompt:'select_account consent',state});
        res.writeHead(302,{Location:`https://accounts.google.com/o/oauth2/v2/auth?${params}`}); return res.end();
      }
      if(req.method==='GET' && path==='/auth/youtube/callback') {
        const state=url.searchParams.get('state'); const saved=oauthStates.get(state); oauthStates.delete(state);
        if(!saved||saved.sid!==sid||saved.expires<Date.now()||!url.searchParams.get('code')) fail(400,'Autorisation expirée ou refusée');
        const tokens=await jsonFetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:config.googleId,client_secret:config.googleSecret,code:url.searchParams.get('code'),grant_type:'authorization_code',redirect_uri:`${config.appUrl}/auth/youtube/callback`})});
        if(!tokens.refresh_token) fail(400,'Autorisation hors ligne absente');
        const identity=await jsonFetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',{headers:{Authorization:`Bearer ${tokens.access_token}`}});
        if(identity.items?.length!==1 || !identity.items[0].id) fail(409,'Sélectionner une seule chaîne YouTube puis reconnecter');
        const channel={id:identity.items[0].id,title:identity.items[0].snippet.title};
        store.setting('googlePending',{tokens:box.encrypt({...tokens,expiresAt:Date.now()+tokens.expires_in*1000}),channel,expiresAt:Date.now()+600000});
        store.setting('youtubePaused',true);store.setting('youtubePlaylists',[]);
        res.writeHead(302,{Location:'/?youtube=confirm'}); return res.end();
      }
      if(req.method==='POST' && path==='/api/youtube/disconnect') {
        store.setting('youtubePaused',true);store.setting('google',null);store.setting('googlePending',null);store.setting('googleChannel',null);store.setting('youtubePlaylists',[]);
        const defaults=store.setting('defaults') || {};if(defaults.youtube){defaults.youtube.playlistIds=[];store.setting('defaults',defaults);}
        return send(res,200,{ok:true});
      }
      if(req.method==='POST' && path==='/api/youtube/confirm') {
        const data=await body(req),pending=store.setting('googlePending');
        if(!pending || pending.expiresAt<Date.now() || data.channelId!==pending.channel.id) fail(409,'Confirmation de chaîne expirée ou incorrecte. Reconnecter YouTube.');
        const previous=store.setting('googleChannel');
        if(previous?.id!==pending.channel.id) {
          for(const post of store.list()) {
            const d=post.destinations.youtube;
            if(d && d.state!=='delivered') {d.state='attention';d.error='Chaîne YouTube modifiée. Vérifier cette destination avant toute nouvelle publication.';store.save(post);}
          }
          const defaults=store.setting('defaults') || {};if(defaults.youtube){defaults.youtube.playlistIds=[];store.setting('defaults',defaults);}
        }
        store.setting('google',pending.tokens);store.setting('googleChannel',pending.channel);store.setting('googlePending',null);store.setting('youtubePlaylists',[]);store.setting('youtubePaused',false);
        return send(res,200,{ok:true,channel:pending.channel});
      }
      if(req.method==='PUT' && path==='/api/preferences') {
        const data=await body(req);const defaults={};
        for(const network of ['youtube','facebook','instagram','tiktok']) {
          const input=data[network] || {};
          if(input.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) fail(400,'Heure par défaut invalide');
          const validated=destinationPlan(network,{...input,title:input.title || 'Titre',scheduledAt:new Date(Date.now()+3600000).toISOString(),madeForKids:input.madeForKids ?? false});
          delete validated.scheduledAt;
          if(network==='youtube' && input.madeForKids===undefined) delete validated.madeForKids;
          defaults[network]={...validated,title:input.title || '',time:input.time || ''};
        }
        store.setting('defaults',defaults);return send(res,200,{ok:true,defaults});
      }
      if(req.method==='GET' && path==='/api/youtube/playlists') {
        try { const playlists=await google.playlists();store.setting('youtubePlaylists',playlists);return send(res,200,{playlists,canManage:google.canManagePlaylists()}); }
        catch(e) { fail(e.status || 502,'Lecture YouTube impossible. Vérifie la connexion et les autorisations dans Mes réseaux.'); }
      }
      if(req.method==='POST' && path==='/api/youtube/playlists') {
        if(!google.canManagePlaylists()) fail(409,'Reconnecter YouTube dans Mes réseaux pour autoriser les playlists');
        const data=await body(req);
        if(typeof data.requestId!=='string'||!/^[a-f0-9-]{36}$/.test(data.requestId)) fail(400,'Identifiant de création requis');
        if(typeof data.title!=='string'||!data.title.trim()||data.title.length>150||/[<>]/.test(data.title)) fail(400,'Titre de playlist requis, 150 caractères maximum');
        if(typeof data.description!=='string'||data.description.length>5000||!['private','unlisted','public'].includes(data.privacy)) fail(400,'Description ou visibilité de playlist invalide');
        const key=`playlist-create:${data.requestId}`,previous=store.setting(key);
        if(previous?.result) return send(res,200,previous.result);
        if(previous) fail(409,'Création précédente à vérifier dans YouTube Studio. Ne relance pas sans vérifier si la playlist existe.');
        store.setting(key,{state:'creating',title:data.title.trim(),createdAt:new Date().toISOString()});
        try {
          const result=await google.request('playlists?part=snippet,status',{snippet:{title:data.title.trim(),description:data.description},status:{privacyStatus:data.privacy}});
          if(!result.id) throw new Error('Playlist non confirmée');
          const playlist={id:result.id,title:data.title.trim(),description:data.description,privacy:data.privacy};
          store.setting(key,{state:'created',result:playlist});store.setting('youtubePlaylists',[...(store.setting('youtubePlaylists') || []),playlist]);
          return send(res,201,playlist);
        } catch { fail(502,'Résultat de création à vérifier dans YouTube Studio avant toute nouvelle tentative.'); }
      }
      if(req.method==='POST' && path==='/api/posts') {
        const p={id:randomUUID(),createdAt:new Date().toISOString(),status:'draft',title:'',description:'',media:null,size:0,destinations:{}};
        store.save(p); return send(res,201,publicPost(p));
      }
      const draftDelete=path.match(/^\/api\/posts\/([a-f0-9-]+)$/);
      if(req.method==='DELETE' && draftDelete) {
        const p=owned(draftDelete[1]);
        if(p.status!=='draft'||locks.has(p.id)||uploading) fail(409,'Seuls les brouillons sans import en cours peuvent être supprimés');
        if(p.cover) await unlink(join(store.media,p.cover.file)).catch(e=>{if(e.code!=='ENOENT')throw e;});
        for(const cover of Object.values(p.covers || {}))await unlink(join(store.media,cover.file)).catch(e=>{if(e.code!=='ENOENT')throw e;});
        if(p.media) await unlink(join(store.media,p.media)).catch(e=>{if(e.code!=='ENOENT')throw e;});
        store.remove(p.id); return send(res,200,{ok:true});
      }
      const match=path.match(/^\/api\/posts\/([a-f0-9-]+)\/(media|cover|preview|schedule|preflight|draft|confirm|download|retry)$/);
      if(match) {
        let p=owned(match[1]); const action=match[2];
        if(req.method==='GET' && ['download','preview'].includes(action)) return await streamMedia(req,res,p,action==='download');
        if(action==='cover') {
          const coverNetwork=url.searchParams.get('network');
          if(coverNetwork&&!['common','youtube','facebook','instagram','tiktok'].includes(coverNetwork))fail(400,'Destination de couverture invalide');
          const current=coverNetwork?(url.searchParams.get('effective')==='true'?coverFor(p,coverNetwork):p.covers?.[coverNetwork]):p.cover;
          if(req.method==='GET') {
            if(!current) fail(404,'Aucune couverture');
            res.writeHead(200,{'Content-Type':current.mime,'Content-Length':String(current.size),'Content-Disposition':`attachment; filename="studigo-cover.${current.mime==='image/png'?'png':'jpg'}"`});await pipeline(createReadStream(join(store.media,current.file)),res);return;
          }
          if(!['PUT','DELETE'].includes(req.method)) fail(405,'Méthode refusée');
          if(!['draft','scheduled'].includes(p.status) || uploading || locks.has(p.id) || Object.values(p.destinations).some(d=>!['pending','manual','agent_queued'].includes(d.state))) fail(409,'La couverture ne peut plus être modifiée après le début des envois');
          if(p.status==='scheduled')fail(409,'Enregistrer d’abord les réglages en brouillon avant de modifier les couvertures.');
          locks.add(p.id);
          let temporary;
          try {
            if(req.method==='DELETE') {if(current)await unlink(join(store.media,current.file)).catch(e=>{if(e.code!=='ENOENT')throw e;});if(coverNetwork){p.covers ||= {};delete p.covers[coverNetwork];}else p.cover=null;store.save(p);return send(res,200,publicPost(p));}
            const mime=req.headers['content-type'],size=Number(req.headers['content-length']);
            if(!['image/jpeg','image/png'].includes(mime) || !Number.isSafeInteger(size) || size<24 || size>50*1024*1024) fail(400,'Importer une image JPEG ou PNG de 50 Mo maximum');
            if(store.bytes()+size>maxStorage) fail(413,'Quota de stockage atteint');
            temporary=join(store.media,`${randomUUID()}.part`);let count=0;
            await pipeline(req,new Transform({transform(chunk,encoding,callback){count+=chunk.length;callback(count>size?new Error('Taille incorrecte'):null,chunk);}}),createWriteStream(temporary,{flags:'wx',mode:0o600}));
            if(count!==size) fail(400,'Image incomplète');
            const f=await open(temporary);const header=Buffer.alloc(24);try{await f.read(header,0,24,0);}finally{await f.close();}
            const valid=mime==='image/png'?header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&header.toString('ascii',12,16)==='IHDR'&&header.readUInt32BE(16)>0&&header.readUInt32BE(20)>0:header[0]===255&&header[1]===216&&header[2]===255;
            if(!valid) fail(400,'Le fichier ne correspond pas à une image JPEG ou PNG');
            const filename=`${p.id}-cover${coverNetwork?'-'+coverNetwork:''}.${mime==='image/png'?'png':'jpg'}`,previous=current;
            await rename(temporary,join(store.media,filename));if(coverNetwork){p.covers ||= {};p.covers[coverNetwork]={file:filename,mime,size};}else p.cover={file:filename,mime,size};store.save(p);
            if(previous&&previous.file!==filename)await unlink(join(store.media,previous.file)).catch(e=>{if(e.code!=='ENOENT')throw e;});
            return send(res,200,publicPost(p));
          } finally {locks.delete(p.id);if(temporary)await unlink(temporary).catch(()=>{});}
        }
        if(req.method==='PUT' && action==='media') {
          if(p.status!=='draft'||p.media) fail(409,'Cette publication contient déjà un fichier');
          if(uploading) fail(409,'Un import est déjà en cours');
          const size=Number(req.headers['content-length']);
          if(!Number.isSafeInteger(size)||size<12||size>maxUpload) fail(413,'Vidéo vide ou trop volumineuse');
          if(store.bytes()+size>maxStorage) fail(413,'Quota de stockage atteint');
          uploading=true; const temporary=join(store.media,`${p.id}.part`);
          try {
            let count=0;
            await pipeline(req,new Transform({transform(chunk,encoding,callback){count+=chunk.length; callback(count>size?new Error('Taille incorrecte'):null,chunk);}}),createWriteStream(temporary,{flags:'wx',mode:0o600}));
            if(count!==size) fail(400,'Import incomplet');
            const f=await open(temporary); let header; try { header=Buffer.alloc(12); await f.read(header,0,12,0); } finally {await f.close();}
            if(header.toString('ascii',4,8)!=='ftyp') fail(400,'Un fichier MP4 est requis');
            p.media=`${p.id}.mp4`; await rename(temporary,join(store.media,p.media)); p.size=size; store.save(p);
          } finally { uploading=false; await unlink(temporary).catch(()=>{}); }
          return send(res,200,publicPost(p));
        }
        if(req.method==='POST' && ['schedule','preflight','draft'].includes(action)) {
          const data=await body(req);p=owned(match[1]);
          if(!p.media || !['draft','scheduled'].includes(p.status) || locks.has(p.id) || Object.values(p.destinations).some(d=>!['pending','manual','agent_queued'].includes(d.state))) fail(409,'Seules les publications dont aucun envoi n’a commencé peuvent être modifiées');
          const prepared=preparePlans(p,data),{plans}=prepared;
          if(action==='preflight')return send(res,200,{ready:prepared.ready,checks:prepared.checks});
          if(action==='schedule'&&!prepared.ready)fail(409,prepared.checks.filter(c=>c.issues.length).map(c=>c.network+' : '+c.issues.join(' ')).join(' '));
          const earliest=Object.values(plans).map(d=>d.scheduledAt).sort()[0];
          p.title=typeof data.title==='string'&&data.title.trim()?data.title.trim().slice(0,100):Object.values(plans)[0].title;p.description=typeof data.description==='string'?data.description:'';p.scheduledAt=earliest;p.commonScheduledAt=Number.isFinite(new Date(data.scheduledAt).getTime())?new Date(data.scheduledAt).toISOString():earliest;p.madeForKids=plans.youtube?.madeForKids ?? data.madeForKids ?? false;p.tiktokAiGenerated=plans.tiktok?.tiktokAiGenerated ?? false;p.status=action==='draft'?'draft':'scheduled';p.destinations=plans;p.deliveryMode=data.deliveryMode || null;store.save(p);
          return send(res,200,publicPost(p));
        }
        if(req.method==='POST' && action==='confirm') {
          if(locks.has(p.id)) fail(409,'Un envoi est en cours. Réessaie dans quelques instants.');
          locks.add(p.id);
          try {
          const data=await body(req); const d=p.destinations[data.network];
          if(!d||!['manual','attention'].includes(d.state)||data.confirmed!==true) fail(409,'Confirmation non applicable');
          let remote; try {remote=new URL(data.url);} catch {fail(400,'Lien de publication requis');}
          const domains={youtube:['youtube.com','www.youtube.com','youtu.be'],facebook:['facebook.com','www.facebook.com'],instagram:['instagram.com','www.instagram.com'],tiktok:['tiktok.com','www.tiktok.com','vm.tiktok.com']};
          if(remote.protocol!=='https:'||!domains[data.network].includes(remote.hostname)||remote.username||remote.password) fail(400,'Lien du réseau sélectionné requis');
          d.state='delivered'; d.url=remote.href; d.confirmedAt=new Date().toISOString(); d.confirmedBy='owner'; delete d.error; store.save(p); await purgeDelivered(store,p); if(!p.media){p.status='complete';store.save(p);}
          return send(res,200,publicPost(p));
          } finally { locks.delete(p.id); }
        }
      }
      fail(404,'Action introuvable');
    }
    if(req.method!=='GET') fail(405,'Méthode refusée');
    const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/fonts/montserrat.woff2':'fonts/montserrat.woff2'};
    if(!files[path]) fail(404,'Page introuvable');
    const ext=files[path].split('.').pop(); const types={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',woff2:'font/woff2'};
    const file=await readFile(join(base,'public',files[path])); res.writeHead(200,{'Content-Type':types[ext]}); res.end(file);
  } catch(e) { if(!res.headersSent) send(res,e.status || 500,{error:e.status?e.message:'Opération interrompue. Vérifie la configuration du serveur.'}); else res.destroy(); }
});
async function streamMedia(req,res,p,download=false) {
  if(!p.media) fail(404,'Fichier déjà supprimé');
  const file=join(store.media,p.media), size=(await stat(file)).size;
  let start=0,end=size-1,status=200;
  if(req.headers.range) { const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range); if(!m) fail(416,'Plage invalide'); start=Number(m[1]); end=m[2]?Number(m[2]):end; if(start>end||end>=size) fail(416,'Plage invalide'); status=206; }
  res.writeHead(status,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1,...(status===206?{'Content-Range':`bytes ${start}-${end}/${size}`} : {}),...(download?{'Content-Disposition':`attachment; filename="studigo-${p.id}.mp4"`}:{})});
  if(req.method==='HEAD') { res.end(); return; }
  await pipeline(createReadStream(file,{start,end}),res);
}
server.requestTimeout=30*60*1000;
server.listen(Number(env.PORT || 4310),env.HOST || '127.0.0.1',()=>console.log(`Studigo : ${config.appUrl}`));
const timer=setInterval(()=>worker().catch(()=>console.error('File suspendue : vérifier les données et le stockage.')),20000);
timer.unref();
const cleanup=setInterval(()=>{const now=Date.now(); for(const [key,v] of sessions)if(v.expires<now)sessions.delete(key); for(const [key,v]of oauthStates)if(v.expires<now)oauthStates.delete(key);for(const[key,v]of loginAttempts)if(v.until<now)loginAttempts.delete(key);},60000); cleanup.unref();
