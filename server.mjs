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
import { createWorker, purgeDelivered } from './lib/worker.mjs';
import { createProviders, vault, jsonFetch, mediaSignature } from './lib/providers.mjs';

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
const config={secret:env.MEDIA_SECRET,appUrl:(env.APP_URL || 'http://127.0.0.1:4310').replace(/\/$/,''),googleId:env.GOOGLE_CLIENT_ID,googleSecret:env.GOOGLE_CLIENT_SECRET,metaVersion:env.META_GRAPH_VERSION || 'v24.0',metaToken:env.META_PAGE_TOKEN,pageId:env.META_PAGE_ID,instagramId:env.INSTAGRAM_USER_ID};
const secure=new URL(config.appUrl).protocol==='https:';
if (!secure && !['127.0.0.1','localhost'].includes(new URL(config.appUrl).hostname)) throw new Error('HTTPS requis hors localhost');
const store=createStore(resolve(base,env.DATA_DIR || 'data'));
// Les imports interrompus ne sont pas des vidéos programmées ; aucune archive .part.
for(const name of readdirSync(store.media)) if(/^[a-f0-9-]{36}\.part$/.test(name)) unlinkSync(join(store.media,name));
const sessions=new Map(); const loginAttempts=new Map(); const oauthStates=new Map();
const locks=new Set();
const box=vault(config.secret); const worker=createWorker(store,createProviders(store,config),{locks});
const maxUpload=Number(env.MAX_UPLOAD_MB || 1024)*1024*1024;
const maxStorage=Number(env.MAX_STORAGE_MB || 5120)*1024*1024;
if (![maxUpload,maxStorage].every(n=>Number.isFinite(n)&&n>0)) throw new Error('Quotas invalides');
let uploading=false;
function fail(status,message) { throw Object.assign(new Error(message),{status}); }
const equal=(a,b)=>timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
function send(res,status,value) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); }
async function body(req) { let text=''; for await(const b of req) { text+=b; if(Buffer.byteLength(text)>65536) fail(413,'Requête trop grande'); } try { return JSON.parse(text); } catch { fail(400,'Données invalides'); } }
function connected() { return { youtube:!!store.setting('google'), facebook:!!(config.metaToken&&config.pageId), instagram:!!(config.metaToken&&config.instagramId), tiktok:false }; }
function publicPost(p) { const {media,...rest}=p; return {...rest,hasMedia:!!media}; }
function owned(id) { const p=store.get(id); if(!p) fail(404,'Publication introuvable'); return p; }

// Les états ambigus après un arrêt ne sont jamais relancés automatiquement.
for(const p of store.list()) for(const d of Object.values(p.destinations)) if(['uploading','publishing'].includes(d.state)) { d.state='attention'; d.error='Serveur redémarré pendant un envoi. Vérifie le réseau et confirme la réception manuellement.'; store.save(p); }

const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-Frame-Options','DENY'); res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
  try {
    const url=new URL(req.url,config.appUrl); const path=url.pathname;
    if (req.method==='GET' && path==='/health') return send(res,200,{ok:true});
    // Seul le fichier signé est accessible aux robots Meta, sans ouvrir le tableau de bord.
    if (req.method==='GET' && /^\/media\/[a-f0-9-]+$/.test(path)) {
      const id=path.split('/')[2], expires=Number(url.searchParams.get('expires'));
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
      if(req.method==='GET' && path==='/api/state') return send(res,200,{posts:store.list().map(publicPost),connections:connected(),googleConfigured:!!(config.googleId&&config.googleSecret),storage:{used:store.bytes(),limit:maxStorage,maxUpload},timezone:'Europe/Paris'});
      if(req.method==='GET' && path==='/auth/youtube') {
        if(!config.googleId||!config.googleSecret) fail(409,'Configurer les identifiants Google sur le serveur');
        const state=randomBytes(24).toString('hex'); oauthStates.set(state,{sid,expires:Date.now()+600000});
        const params=new URLSearchParams({client_id:config.googleId,redirect_uri:`${config.appUrl}/auth/youtube/callback`,response_type:'code',scope:'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',access_type:'offline',prompt:'consent',state});
        res.writeHead(302,{Location:`https://accounts.google.com/o/oauth2/v2/auth?${params}`}); return res.end();
      }
      if(req.method==='GET' && path==='/auth/youtube/callback') {
        const state=url.searchParams.get('state'); const saved=oauthStates.get(state); oauthStates.delete(state);
        if(!saved||saved.sid!==sid||saved.expires<Date.now()||!url.searchParams.get('code')) fail(400,'Autorisation expirée ou refusée');
        const tokens=await jsonFetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:config.googleId,client_secret:config.googleSecret,code:url.searchParams.get('code'),grant_type:'authorization_code',redirect_uri:`${config.appUrl}/auth/youtube/callback`})});
        if(!tokens.refresh_token) fail(400,'Autorisation hors ligne absente');
        store.setting('google',box.encrypt({...tokens,expiresAt:Date.now()+tokens.expires_in*1000})); res.writeHead(302,{Location:'/'}); return res.end();
      }
      if(req.method==='POST' && path==='/api/posts') {
        const p={id:randomUUID(),createdAt:new Date().toISOString(),status:'draft',title:'',description:'',media:null,size:0,destinations:{}};
        store.save(p); return send(res,201,publicPost(p));
      }
      const draftDelete=path.match(/^\/api\/posts\/([a-f0-9-]+)$/);
      if(req.method==='DELETE' && draftDelete) {
        const p=owned(draftDelete[1]);
        if(p.status!=='draft'||locks.has(p.id)||uploading) fail(409,'Seuls les brouillons sans import en cours peuvent être supprimés');
        if(p.media) await unlink(join(store.media,p.media)).catch(e=>{if(e.code!=='ENOENT')throw e;});
        store.remove(p.id); return send(res,200,{ok:true});
      }
      const match=path.match(/^\/api\/posts\/([a-f0-9-]+)\/(media|schedule|confirm|download|retry)$/);
      if(match) {
        const p=owned(match[1]), action=match[2];
        if(req.method==='GET' && action==='download') return await streamMedia(req,res,p,true);
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
        if(req.method==='POST' && action==='schedule') {
          if(p.status!=='draft'||!p.media) fail(409,'Importer une vidéo avant de programmer');
          const data=await body(req); const date=new Date(data.scheduledAt);
          if(typeof data.title!=='string'||!data.title.trim()||data.title.length>100||/[<>]/.test(data.title)) fail(400,'Titre requis, 100 caractères maximum, sans chevrons');
          if(typeof data.description!=='string'||data.description.length>2000) fail(400,'Description : 2 000 caractères maximum');
          if(!Number.isFinite(date.getTime())||date.getTime()<Date.now()-60000) fail(400,'Choisir une date à venir');
          if(typeof data.madeForKids!=='boolean') fail(400,'Indiquer si la vidéo est conçue pour les enfants');
          if(!Array.isArray(data.networks)||!data.networks.length||data.networks.some(n=>!['youtube','facebook','instagram','tiktok'].includes(n))) fail(400,'Choisir au moins un réseau');
          const ready=connected(); if(data.networks.some(n=>n!=='tiktok'&&!ready[n])) fail(409,'Configurer les comptes sélectionnés avant la programmation');
          p.title=data.title.trim(); p.description=data.description; p.scheduledAt=date.toISOString(); p.madeForKids=data.madeForKids; p.status='scheduled'; p.destinations=Object.fromEntries([...new Set(data.networks)].map(n=>[n,{state:n==='tiktok'?'manual':'pending'}])); store.save(p);
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
  await pipeline(createReadStream(file,{start,end}),res);
}
server.requestTimeout=30*60*1000;
server.listen(Number(env.PORT || 4310),env.HOST || '127.0.0.1',()=>console.log(`Studigo : ${config.appUrl}`));
const timer=setInterval(()=>worker().catch(()=>console.error('File suspendue : vérifier les données et le stockage.')),20000);
timer.unref();
const cleanup=setInterval(()=>{const now=Date.now(); for(const [key,v] of sessions)if(v.expires<now)sessions.delete(key); for(const [key,v]of oauthStates)if(v.expires<now)oauthStates.delete(key);for(const[key,v]of loginAttempts)if(v.until<now)loginAttempts.delete(key);},60000); cleanup.unref();
