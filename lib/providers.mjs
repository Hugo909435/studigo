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

export async function bufferQuery(key, query, variables={}) {
  const result=await jsonFetch('https://api.buffer.com',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({query,variables})});
  if(result.errors?.length || !result.data) throw new Error('Requête Buffer refusée');
  return result.data;
}

export function createGoogleClient(store,config) {
  const box=vault(config.secret);
  const playlistScopes=['https://www.googleapis.com/auth/youtube.force-ssl','https://www.googleapis.com/auth/youtube'];
  return {
    canManagePlaylists() { const saved=store.setting('google'); return !!saved && box.decrypt(saved).scope?.split(' ').some(s=>playlistScopes.includes(s))===true; },
    async token() {
      const saved=store.setting('google');
      if(!saved) throw Object.assign(new Error('Connecter YouTube dans Mes réseaux'),{status:409});
      const tokens=box.decrypt(saved);
      if(tokens.expiresAt>Date.now()+60000) return tokens.access_token;
      const fresh=await jsonFetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:config.googleId,client_secret:config.googleSecret,refresh_token:tokens.refresh_token,grant_type:'refresh_token'})});
      store.setting('google',box.encrypt({...tokens,...fresh,expiresAt:Date.now()+fresh.expires_in*1000}));
      return fresh.access_token;
    },
    async request(path,data) {
      const token=await this.token();
      return jsonFetch(`https://www.googleapis.com/youtube/v3/${path}`,{headers:{Authorization:`Bearer ${token}`,...(data?{'Content-Type':'application/json'}:{})},...(data?{method:'POST',body:JSON.stringify(data)}:{})});
    },
    async playlists() {
      const items=[];let pageToken='';
      do {
        const result=await this.request(`playlists?part=snippet,status&mine=true&maxResults=50${pageToken?`&pageToken=${encodeURIComponent(pageToken)}`:''}`);
        items.push(...(result.items || []).map(p=>({id:p.id,title:p.snippet.title,description:p.snippet.description || '',privacy:p.status.privacyStatus})));
        pageToken=result.nextPageToken || '';
      } while(pageToken);
      return items;
    }
  };
}

export function createProviders(store, config, {now=()=>Date.now()}={}) {
  const google=createGoogleClient(store,config);
  const graph = `https://graph.facebook.com/${config.metaVersion}`;
  const meta = (path, data, method='POST') => jsonFetch(`${graph}/${path}`, { method, headers: { Authorization:`Bearer ${config.metaToken}`, ...(method === 'GET' ? {} : {'Content-Type':'application/x-www-form-urlencoded'}) }, ...(method === 'GET' ? {} : {body:new URLSearchParams(data)}) });
  async function publishBuffer(network,p,d,save) {
      if(d.provider!=='buffer' || !config.bufferKey || !d.channelId) throw new Error('Buffer non configuré');
      if(d.state==='pending') {
        d.mediaExpiresAt=now()+24*3600000;
        const url=`${config.appUrl}/media/${p.id}.mp4?expires=${d.mediaExpiresAt}&signature=${mediaSignature(config.secret,p.id,d.mediaExpiresAt)}`;
        // Sauver avant la mutation : un résultat réseau ambigu ne doit jamais être rejoué.
        d.state='publishing'; save();
        const result=await bufferQuery(config.bufferKey,`mutation CreateBufferPost($input: CreatePostInput!) {
          createPost(input:$input) { ... on PostActionSuccess { post { id channelId } } ... on MutationError { message } }
        }`,{input:{channelId:d.channelId,text:`${p.title}\n\n${p.description}`,assets:[{video:{url}}],schedulingType:'automatic',mode:'shareNow',needsApproval:false,saveToDraft:false,metadata:network==='tiktok'?{tiktok:{isAiGenerated:!!p.tiktokAiGenerated}}:network==='instagram'?{instagram:{type:'reel',shouldShareToFeed:true}}:{facebook:{type:'reel'}}}});
        const remote=result.createPost?.post;
        if(!remote?.id || remote.channelId!==d.channelId) throw new Error('Envoi Buffer non confirmé');
        d.remoteId=remote.id; d.state='processing'; d.pollCount=0; d.nextPollAt=now()+60000; save();
      } else if(d.state==='processing') {
        if(now()<(d.nextPollAt || 0)) return;
        if(!d.remoteId) throw new Error('ID Buffer absent');
        // Les lectures peuvent être retentées, jamais la création du post.
        let remote;
        try {
          const result=await bufferQuery(config.bufferKey,`query BufferPostStatus($input: PostInput!) {
            post(input:$input) { id channelId channelService status schedulingType externalLink }
          }`,{input:{id:d.remoteId}});
          remote=result.post;
        } catch {
          if(now()>=d.mediaExpiresAt) throw new Error('Vérification Buffer expirée');
        }
        if(remote) {
          if(remote.id!==d.remoteId || remote.channelId!==d.channelId || remote.channelService!==network || remote.schedulingType!=='automatic') throw new Error('Publication Buffer à vérifier');
          if(['error','draft','needs_approval'].includes(remote.status)) throw new Error('Publication Buffer non terminée');
          if(remote.status==='sent' && remote.externalLink) {
            const link=new URL(remote.externalLink);
            const hosts={tiktok:['www.tiktok.com','tiktok.com'],instagram:['www.instagram.com','instagram.com'],facebook:['www.facebook.com','facebook.com','fb.watch']};
            const content=network==='tiktok'?/^\/@[^/]+\/video\/\d+\/?$/.test(link.pathname):network==='instagram'?/^\/(reel|reels|p)\/[a-zA-Z0-9_-]+\/?$/.test(link.pathname):link.hostname==='fb.watch'?link.pathname.length>1:/\/(reel|videos|posts)\/[^/]+/.test(link.pathname)||['/watch/','/watch','/permalink.php','/story.php'].includes(link.pathname)&&!!(link.searchParams.get('v')||link.searchParams.get('story_fbid'));
            if(link.protocol!=='https:' || !hosts[network].includes(link.hostname) || link.username || link.password || !content) throw new Error('Lien de publication incorrect');
            d.url=link.href; d.state='delivered'; d.confirmedAt=new Date(now()).toISOString(); delete d.nextPollAt; save(); return;
          }
          if(!['scheduled','sending','sent'].includes(remote.status)) throw new Error('État Buffer inconnu');
        }
        if(now()>=d.mediaExpiresAt) throw new Error('Vérification Buffer expirée');
        const delays=[120000,300000,900000,3600000];
        d.nextPollAt=now()+delays[Math.min(d.pollCount || 0,delays.length-1)]; d.pollCount=(d.pollCount || 0)+1; save();
      } else throw new Error('Publication Buffer ambiguë');
  }
  return {
    async tiktok(p,d,save) { return publishBuffer('tiktok',p,d,save); },
    async youtube(p,d,save) {
      const token=await google.token();
      if (d.state === 'pending') {
        const file=join(store.media,p.media); const size=(await stat(file)).size;
        const privacy=p.privacy || 'public';
        const scheduled=privacy==='public' && new Date(p.scheduledAt).getTime()>Date.now();
        const status={privacyStatus:scheduled?'private':privacy,selfDeclaredMadeForKids:p.madeForKids};
        if(scheduled) status.publishAt=p.scheduledAt;
        const response=await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {method:'POST',signal:AbortSignal.timeout(120000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Upload-Content-Length':String(size),'X-Upload-Content-Type':'video/mp4'},body:JSON.stringify({snippet:{title:p.title,description:p.description,categoryId:'24',...(p.tags?.length?{tags:p.tags}:{})},status})});
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
        if (video?.processingDetails?.processingStatus === 'succeeded') {
          for(const playlistId of p.playlistIds || []) {
            if(d.addedPlaylistIds?.includes(playlistId)) continue;
            d.state='publishing';d.playlistAdding=playlistId;save();
            const added=await google.request('playlistItems?part=snippet',{snippet:{playlistId,resourceId:{kind:'youtube#video',videoId:d.remoteId}}});
            if(!added.id) throw new Error('Classement playlist non confirmé');
            d.addedPlaylistIds=[...(d.addedPlaylistIds || []),playlistId];delete d.playlistAdding;save();
          }
          d.state='delivered'; d.confirmedAt=new Date().toISOString(); save();
        }
        else if (['failed','terminated'].includes(video?.processingDetails?.processingStatus) || ['failed','rejected','deleted'].includes(video?.status?.uploadStatus)) throw new Error('Traitement refusé');
      } else throw new Error('Envoi ambigu');
    },
    async instagram(p,d,save) {
      if(d.provider==='buffer') return publishBuffer('instagram',p,d,save);
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
      if(d.provider==='buffer') return publishBuffer('facebook',p,d,save);
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
