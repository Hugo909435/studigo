import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHmac, createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

export function vault(secret) {
  const key = createHash('sha256').update(secret).digest();
  return {
    encrypt(value) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm',key,iv); const body=Buffer.concat([c.update(JSON.stringify(value)),c.final()]); return Buffer.concat([iv,c.getAuthTag(),body]).toString('base64'); },
    decrypt(value) { const b=Buffer.from(value,'base64'); const c=createDecipheriv('aes-256-gcm',key,b.subarray(0,12)); c.setAuthTag(b.subarray(12,28)); return JSON.parse(Buffer.concat([c.update(b.subarray(28)),c.final()]).toString()); }
  };
}
export function mediaSignature(secret,id,expires) { return createHmac('sha256',secret).update(`${id}:${expires}`).digest('hex'); }
export async function jsonFetch(url, options={}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(options.duplex ? 1_800_000 : 120_000) });
  if (!response.ok) throw new Error(`Remote HTTP ${response.status}`);
  return response.json();
}

export function createProviders(store, config) {
  const box = vault(config.secret);
  const graph = `https://graph.facebook.com/${config.metaVersion}`;
  const meta = (path, data, method='POST') => jsonFetch(`${graph}/${path}`, { method, headers: { Authorization:`Bearer ${config.metaToken}`, ...(method === 'GET' ? {} : {'Content-Type':'application/x-www-form-urlencoded'}) }, ...(method === 'GET' ? {} : {body:new URLSearchParams(data)}) });
  async function googleToken() {
    const saved=store.setting('google');
    if (!saved) throw new Error('Google non connecté');
    const tokens=box.decrypt(saved);
    if (tokens.expiresAt > Date.now()+60000) return tokens.access_token;
    const fresh=await jsonFetch('https://oauth2.googleapis.com/token', {method:'POST',body:new URLSearchParams({client_id:config.googleId,client_secret:config.googleSecret,refresh_token:tokens.refresh_token,grant_type:'refresh_token'})});
    store.setting('google',box.encrypt({...tokens,...fresh,expiresAt:Date.now()+fresh.expires_in*1000}));
    return fresh.access_token;
  }
  return {
    async youtube(p,d,save) {
      const token=await googleToken();
      if (d.state === 'pending') {
        const file=join(store.media,p.media); const size=(await stat(file)).size;
        const status={privacyStatus: new Date(p.scheduledAt).getTime()>Date.now() ? 'private':'public',selfDeclaredMadeForKids:p.madeForKids};
        if (status.privacyStatus==='private') status.publishAt=p.scheduledAt;
        const response=await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {method:'POST',signal:AbortSignal.timeout(120000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Upload-Content-Length':String(size),'X-Upload-Content-Type':'video/mp4'},body:JSON.stringify({snippet:{title:p.title,description:p.description,categoryId:'24'},status})});
        if (!response.ok || !response.headers.get('location')) throw new Error('Session upload refusée');
        const session=response.headers.get('location');
        if (new URL(session).hostname !== 'www.googleapis.com' || new URL(session).protocol!=='https:') throw new Error('URL upload incorrecte');
        d.state='uploading'; save(); // un arrêt pendant PUT demande une vérification manuelle
        const result=await jsonFetch(session,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Length':String(size),'Content-Type':'video/mp4'},duplex:'half',body:createReadStream(file)});
        if (!result.id) throw new Error('ID vidéo absent');
        d.remoteId=result.id; d.url=`https://www.youtube.com/watch?v=${result.id}`; d.state='processing'; save();
      } else if (d.state==='processing') {
        const result=await jsonFetch(`https://www.googleapis.com/youtube/v3/videos?part=processingDetails,status&id=${encodeURIComponent(d.remoteId)}`,{headers:{Authorization:`Bearer ${token}`}});
        const video=result.items?.[0];
        if (video?.processingDetails?.processingStatus === 'succeeded') { d.state='delivered'; d.confirmedAt=new Date().toISOString(); save(); }
        else if (['failed','terminated'].includes(video?.processingDetails?.processingStatus) || ['failed','rejected','deleted'].includes(video?.status?.uploadStatus)) throw new Error('Traitement refusé');
      } else throw new Error('Envoi ambigu');
    },
    async instagram(p,d,save) {
      if (d.state==='pending') {
        const expires=Date.now()+24*3600000;
        const video_url=`${config.appUrl}/media/${p.id}?expires=${expires}&signature=${mediaSignature(config.secret,p.id,expires)}`;
        const result=await meta(`${config.instagramId}/media`,{media_type:'REELS',video_url,caption:`${p.title}\n\n${p.description}`,share_to_feed:'true'});
        if (!result.id) throw new Error('Conteneur absent');
        d.remoteId=result.id; d.state='processing'; save();
      } else if (d.state==='processing') {
        const result=await meta(`${d.remoteId}?fields=status_code`,{},'GET');
        if (['ERROR','EXPIRED'].includes(result.status_code)) throw new Error('Traitement refusé');
        if (result.status_code==='FINISHED') {
          d.state='publishing'; save();
          const published=await meta(`${config.instagramId}/media_publish`,{creation_id:d.remoteId});
          if (!published.id) throw new Error('Publication non confirmée');
          d.publishedId=published.id; d.state='delivered'; d.confirmedAt=new Date().toISOString(); save();
          try { const info=await meta(`${published.id}?fields=permalink`,{},'GET'); d.url=info.permalink; save(); } catch { /* ID confirmé conservé */ }
        }
      } else throw new Error('Publication ambiguë');
    },
    async facebook(p,d,save) {
      if (d.state==='pending') {
        const result=await meta(`${config.pageId}/video_reels`,{upload_phase:'start'});
        if (!result.video_id || !result.upload_url) throw new Error('Session absente');
        const target=new URL(result.upload_url);
        if (target.hostname!=='rupload.facebook.com' || target.protocol!=='https:') throw new Error('URL incorrecte');
        d.remoteId=result.video_id; d.state='uploading'; save();
        const file=join(store.media,p.media); const size=(await stat(file)).size;
        const uploaded=await jsonFetch(target,{method:'POST',headers:{Authorization:`OAuth ${config.metaToken}`,offset:'0',file_size:String(size),'Content-Type':'application/octet-stream','Content-Length':String(size)},duplex:'half',body:createReadStream(file)});
        if (!uploaded.success) throw new Error('Upload non confirmé');
        d.state='publishing'; save();
        const finished=await meta(`${config.pageId}/video_reels`,{upload_phase:'finish',video_id:d.remoteId,video_state:'PUBLISHED',title:p.title,description:p.description});
        if (!finished.success) throw new Error('Publication non confirmée');
        d.state='processing'; d.url=`https://www.facebook.com/reel/${d.remoteId}`; save();
      } else if (d.state==='processing') {
        const result=await meta(`${d.remoteId}?fields=status`,{},'GET');
        if (result.status?.publishing_phase?.status==='complete' && result.status?.video_status==='ready') { d.state='delivered'; d.confirmedAt=new Date().toISOString(); save(); }
        else if (result.status?.video_status==='error' || result.status?.publishing_phase?.status==='error') throw new Error('Traitement refusé');
      } else throw new Error('Publication ambiguë');
    }
  };
}
