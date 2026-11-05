const $=s=>document.querySelector(s);
const networks={youtube:'YouTube',facebook:'Facebook',instagram:'Instagram',tiktok:'TikTok'};
const symbols={youtube:'▶',facebook:'f',instagram:'◎',tiktok:'♪'};
const labels={pending:'À envoyer',uploading:'Envoi en cours',processing:'Traitement',publishing:'Publication',delivered:'Réception confirmée',attention:'À vérifier',manual:'Envoi manuel'};
let state, draftId, confirmTarget, previewUrl, playlistRequestId;
const localDate=v=>{const d=new Date(v);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
const editable=p=>p.hasMedia&&p.status==='scheduled'&&Object.values(p.destinations).every(d=>['pending','manual'].includes(d.state));
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bytes=n=>n>=1024**3?`${(n/1024**3).toFixed(2)} Go`:`${(n/1024**2).toFixed(n?1:0)} Mo`;
const date=v=>new Intl.DateTimeFormat('fr-FR',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Paris'}).format(new Date(v));
async function api(path,options={}){const response=await fetch(path,{...options,headers:{...(options.body instanceof File?{}:{'Content-Type':'application/json'}),...options.headers}});const data=await response.json();if(!response.ok){if(response.status===401){$('#login').hidden=false;$('#app').hidden=true;}throw new Error(data.error);}return data;}
const post=(path,data)=>api(path,{method:'POST',body:JSON.stringify(data)});
function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,6000);}
async function refresh(){try{state=await api('/api/state');$('#login').hidden=true;$('#app').hidden=false;render();if(state.youtubePending){document.querySelectorAll('.view').forEach(v=>v.hidden=v.id!=='view-accounts');document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view==='accounts'));$('#breadcrumb').textContent='Mes réseaux';}}catch(e){if(!$('#login').hidden)return;toast(e.message);}}
function render(){
  const scheduled=state.posts.filter(p=>p.status==='scheduled').length;
  $('#stat-scheduled').textContent=scheduled;$('#nav-count').textContent=scheduled;$('#stat-complete').textContent=state.posts.filter(p=>p.status==='complete').length;$('#stat-storage').textContent=bytes(state.storage.used);
  $('#storage-total').textContent=`${bytes(state.storage.used)} utilisés`;
  $('#storage-progress').value=state.storage.used/state.storage.limit*100;
  $('#storage-caption').textContent=`Sur ${bytes(state.storage.limit)} autorisés. Une seule copie du MP4, partagée entre toutes les destinations.`;
  const posts=state.posts.filter(p=>$('#filter').value==='all'||p.status===$('#filter').value);
  $('#queue-count').textContent=posts.length;
  $('#posts').innerHTML=posts.length?posts.map(p=>`<article class="post"><div class="post-mark" aria-hidden="true">Q</div><div><h3>${escape(p.title||'Import à terminer')}</h3><p>${p.scheduledAt?`${escape(date(p.scheduledAt))} · Paris`:'Brouillon'} · ${p.hasMedia?`${bytes(p.size)} temporaires`:p.deletedAt?'MP4 supprimé du serveur':'Sans fichier'}</p><div class="post-networks">${Object.entries(p.destinations).map(([n,d])=>`<span class="chip ${escape(d.state)}" title="${escape(d.error||labels[d.state])}">${symbols[n]} ${networks[n]}${d.provider==='buffer'?' via Buffer':''} · ${labels[d.state]}${d.scheduledAt?' · '+escape(date(d.scheduledAt)):''}</span>`).join('')}</div><details class="publication-details"><summary>Voir les réglages par réseau</summary>${Object.entries(p.destinations).map(([n,d])=>`<div><strong>${networks[n]} · ${escape(d.title??p.title)}</strong><p>${escape(d.description??p.description).replace(/\n/g,'<br>')}</p></div>`).join('')}</details></div><div class="post-actions"><span class="post-status ${escape(p.status)}">${{draft:'Brouillon',scheduled:'Dans la file',complete:'Terminée'}[p.status]}</span>${editable(p)?`<button class="text-button" data-resume="${p.id}">Modifier les réglages</button>`:''}${p.status==='draft'?`<button class="text-button" data-resume="${p.id}">Reprendre</button><button class="text-button" data-discard="${p.id}">Supprimer le brouillon</button>`:''}${p.hasMedia?`<a class="text-button" href="/api/posts/${p.id}/download">Télécharger le MP4</a>`:''}${Object.entries(p.destinations).map(([n,d])=>['manual','attention'].includes(d.state)?`<button class="text-button" data-confirm="${p.id}" data-network="${n}">Confirmer ${networks[n]}</button>`:d.url?`<a class="text-button" href="${escape(d.url)}" target="_blank" rel="noreferrer">Voir ${networks[n]} ↗</a>`:'').join('')}${p.destinations.tiktok?.state==='manual'?`<button class="text-button" data-copy="${p.id}">Copier le texte TikTok</button>`:''}</div></article>`).join(''):`<div class="empty"><span aria-hidden="true">↗</span><h2>La prochaine vidéo commence ici.</h2><p>Ajoute un quiz, choisis tes destinations et prépare ta prochaine publication.</p><button class="primary" data-new>＋ Préparer une publication</button></div>`;
  renderDefaults();
  $('#playlist-list').innerHTML=(state.youtubePlaylists||[]).map(p=>`<div class="playlist-row"><span>${escape(p.title)}</span></div>`).join('');
  if(state.youtubePaused)$('#playlist-status').textContent='Reconnecte YouTube et confirme la bonne chaîne pour retrouver ses playlists.';
  $('#accounts').innerHTML=Object.entries(networks).map(([n,label])=>n==='youtube'?youtubeAccount():`<article class="account"><h2><span class="network-icon ${n}">${symbols[n]}</span>${label}</h2><p>${n==='tiktok'?(state.connections.tiktok?'Publication automatique via Buffer disponible. Choisis ce mode dans chaque nouvelle publication.':'Publication manuelle disponible. Configure Buffer pour activer l’envoi automatique.'):state.bufferNetworks?.[n]?'Publication automatique de Reels via Buffer. Les textes et horaires sont propres à chaque réseau.':state.connections[n]?'Configuration présente. Le premier envoi permettra de vérifier les autorisations du compte.':n==='youtube'?'Autorise ta chaîne via ton application Google.':'Connecte ce compte dans Buffer pour publier des Reels sans créer d’application Meta.'}</p>${n==='youtube'&&!state.connections[n]&&state.googleConfigured?'<a class="text-button" href="/auth/youtube">Connecter ma chaîne ↗</a>':`<small>${n==='tiktok'?(state.connections.tiktok?'Buffer configuré':'Manuel'):state.bufferNetworks?.[n]?'Buffer configuré':state.connections[n]?'Configuré':'À configurer'}</small>${['facebook','instagram'].includes(n)&&!state.connections[n]?'<a class="text-button" href="https://publish.buffer.com/settings/channels" target="_blank" rel="noreferrer">Connecter dans Buffer ↗</a>':''}`}</article>`).join('');
}
function youtubeAccount(){
  const pending=state.youtubePending,channel=state.youtubeChannel;
  const description=pending?`Google propose la chaîne « ${escape(pending.title)} ». Vérifie qu’il s’agit bien de ta chaîne de quiz avant de confirmer.`:state.connections.youtube?(channel?`Chaîne connectée : ${escape(channel.title)}`:'Chaîne non vérifiée : reconnecte YouTube pour afficher et vérifier son nom.'):'Aucun envoi YouTube ne peut partir. Choisis le compte Google et la chaîne de tes quiz, puis confirme son nom ici.';
  return `<article class="account"><h2><span class="network-icon youtube">▶</span>YouTube</h2><p>${description}</p>${pending?`<button class="text-button" type="button" data-confirm-youtube="${escape(pending.id)}">Confirmer la chaîne ${escape(pending.title)}</button>`:''}${channel&&state.connections.youtube?`<a class="text-button" href="https://www.youtube.com/channel/${encodeURIComponent(channel.id)}" target="_blank" rel="noreferrer">Voir la chaîne ↗</a>`:''}<a class="text-button" href="/auth/youtube">${pending?'Choisir une autre chaîne':state.connections.youtube?'Changer de chaîne / autoriser les playlists':'Reconnecter YouTube'}</a>${state.connections.youtube||pending?'<button type="button" class="text-button" data-disconnect-youtube>Déconnecter YouTube</button>':''}</article>`;
}
function playlistOptions(selected=[]){
  const playlists=state.youtubePlaylists || [];
  const missing=selected.filter(id=>!playlists.some(p=>p.id===id)).map(id=>({id,title:id}));
  return [...playlists,...missing].map(p=>`<option value="${escape(p.id)}" ${selected.includes(p.id)?'selected':''}>${escape(p.title)}</option>`).join('');
}
function youtubeFields(prefix,values={},defaults=false){
  return `<label for="${prefix}-kids">Audience</label><select id="${prefix}-kids" ${defaults?'':'required'}><option value="">Choisir</option><option value="false" ${values.madeForKids===false?'selected':''}>Pas spécifiquement conçu pour les enfants</option><option value="true" ${values.madeForKids===true?'selected':''}>Conçu pour les enfants</option></select><label for="${prefix}-privacy">Visibilité YouTube</label><select id="${prefix}-privacy"><option value="public" ${!values.privacy||values.privacy==='public'?'selected':''}>Publique au créneau choisi</option><option value="unlisted" ${values.privacy==='unlisted'?'selected':''}>Non répertoriée</option><option value="private" ${values.privacy==='private'?'selected':''}>Privée</option></select><label for="${prefix}-tags">Tags, séparés par des virgules</label><input id="${prefix}-tags" value="${escape((values.tags||[]).join(', '))}" maxlength="450"><label for="${prefix}-playlists">Playlists (plusieurs choix possibles)</label><select id="${prefix}-playlists" multiple size="4" ${state.youtubePlaylistsEnabled?'':'disabled'}>${playlistOptions(values.playlistIds)}</select><small class="muted">Ctrl ou ⌘ pour sélectionner plusieurs playlists. ${state.youtubePlaylistsEnabled?'':'<a href="/auth/youtube">Autoriser les playlists YouTube</a>'}</small><div class="inline-actions"><button type="button" class="text-button" data-load-playlists>Actualiser</button><button type="button" class="text-button" data-create-playlist>Créer une playlist</button></div>`;
}
function renderDestinationSettings(p){
  $('#destination-settings').innerHTML=Object.entries(networks).map(([n,label])=>{
    const values=p?.destinations[n] || state.defaults?.[n] || {};
    let planned=values.scheduledAt?localDate(values.scheduledAt):$('#scheduled-at').value;
    if(!p && values.time){planned=planned.slice(0,10)+'T'+values.time;if(new Date(planned)<new Date()){const next=new Date(planned);next.setDate(next.getDate()+1);planned=localDate(next);}}
    const prefix='dest-'+n;
    return `<fieldset class="destination-card" data-network-card="${n}" hidden disabled><legend><span class="network-icon">${symbols[n]}</span>${label}</legend><button type="button" class="text-button" data-common="${n}">Reprendre les valeurs communes</button><label for="${prefix}-title">${['instagram','tiktok'].includes(n)||state.bufferNetworks?.[n]?'Première ligne de légende':'Titre'}</label><input id="${prefix}-title" maxlength="100" required data-sync="title" data-custom="${!!values.title}" value="${escape(values.title || $('#title').value)}"><label for="${prefix}-description">${['instagram','tiktok'].includes(n)||state.bufferNetworks?.[n]?'Suite de la légende':'Description'}</label><textarea id="${prefix}-description" rows="4" maxlength="${n==='youtube'||n==='facebook'?5000:n==='instagram'?2200:4000}" data-sync="description" data-custom="${values.description!==undefined}">${escape(values.description ?? $('#description').value)}</textarea><label for="${prefix}-date">Date et heure ${label}</label><input id="${prefix}-date" type="datetime-local" required data-sync="date" data-custom="${!!(values.scheduledAt||values.time)}" value="${escape(planned)}">${n==='youtube'?youtubeFields(prefix,values):''}</fieldset>`;
  }).join('');
}
function youtubeValues(prefix,playlistId=prefix+'-playlists'){
  return {madeForKids:$('#'+prefix+'-kids').value===''?undefined:$('#'+prefix+'-kids').value==='true',privacy:$('#'+prefix+'-privacy').value,tags:$('#'+prefix+'-tags').value.split(',').map(s=>s.trim()).filter(Boolean),playlistIds:[...$('#'+playlistId).selectedOptions].map(o=>o.value)};
}
function collectDestinationSettings(selected){
  return Object.fromEntries(selected.map(n=>[n,{title:$('#dest-'+n+'-title').value,description:$('#dest-'+n+'-description').value,scheduledAt:new Date($('#dest-'+n+'-date').value).toISOString(),...(n==='youtube'?youtubeValues('dest-youtube'):{}),...(n==='tiktok'?{tiktokAiGenerated:$('#tiktok-ai').value==='true'}:{})}]));
}
function renderDefaults(){
  if($('#default-settings').children.length)return;
  $('#default-settings').innerHTML=Object.entries(networks).map(([n,label])=>{const v=state.defaults?.[n] || {};return `<article class="default-card"><h2><span class="network-icon">${symbols[n]}</span>${label}</h2><label for="pref-${n}-title">Titre par défaut (facultatif)</label><input id="pref-${n}-title" maxlength="100" value="${escape(v.title)}"><label for="pref-${n}-description">Description par défaut</label><textarea id="pref-${n}-description" rows="4" maxlength="${n==='youtube'||n==='facebook'?5000:n==='instagram'?2100:3900}">${escape(v.description)}</textarea><label for="pref-${n}-time">Heure habituelle</label><input id="pref-${n}-time" type="time" value="${escape(v.time)}">${n==='youtube'?youtubeFields('pref-youtube',v,true):''}</article>`;}).join('');
}
async function loadPlaylists(){
  $('#playlist-status').textContent='Chargement des playlists…';
  try{const result=await api('/api/youtube/playlists');state.youtubePlaylists=result.playlists;state.youtubePlaylistsEnabled=result.canManage;
    for(const id of ['dest-youtube-playlists','pref-youtube-playlists']){const select=$('#'+id);if(select){const selected=[...select.selectedOptions].map(o=>o.value);select.innerHTML=playlistOptions(selected);select.disabled=!result.canManage;}}
    $('#playlist-list').innerHTML=result.playlists.map(p=>`<div class="playlist-row"><span>${escape(p.title)}</span><small>${escape(({public:'Publique',private:'Privée',unlisted:'Non répertoriée'})[p.privacy])}</small></div>`).join('');
    $('#playlist-status').textContent=`${result.playlists.length} playlist(s).${result.canManage?'':' Autorise la gestion des playlists pour y ajouter des vidéos.'}`;
  }catch(e){$('#playlist-status').textContent=e.message;toast(e.message);}
}
for(const key of ['title','description','date']){
  const common=$(key==='date'?'#scheduled-at':'#'+key);
  common.addEventListener('input',()=>document.querySelectorAll(`[data-sync=${key}][data-custom=false]`).forEach(field=>field.value=common.value));
}
$('#destination-settings').addEventListener('input',e=>{if(e.target.dataset.sync)e.target.dataset.custom='true';});
$('#destination-settings').addEventListener('click',e=>{const button=e.target.closest('[data-common]');if(!button)return;for(const key of ['title','description','date']){const field=$('#dest-'+button.dataset.common+'-'+key);field.value=$(key==='date'?'#scheduled-at':'#'+key).value;field.dataset.custom='false';}});
document.addEventListener('click',async e=>{
  const confirm=e.target.closest('[data-confirm-youtube]');if(confirm){try{await post('/api/youtube/confirm',{channelId:confirm.dataset.confirmYoutube});$('#default-settings').innerHTML='';await refresh();await loadPlaylists();toast('Chaîne YouTube confirmée.');}catch(error){toast(error.message);}return;}
  if(e.target.closest('[data-disconnect-youtube]')){try{await post('/api/youtube/disconnect',{});$('#default-settings').innerHTML='';await refresh();toast('YouTube déconnecté. Aucun nouvel envoi YouTube ne peut partir.');}catch(error){toast(error.message);}return;}
  if(e.target.closest('[data-load-playlists]'))loadPlaylists();
  if(e.target.closest('[data-create-playlist]')){
    if(!state.youtubePlaylistsEnabled)return toast('Autorise la gestion des playlists depuis Mes réseaux.');
    if(!playlistRequestId){$('#playlist-form').reset();$('#playlist-create-status').textContent='';}
    $('#playlist-dialog').showModal();
  }
});
$('#playlist-form').onsubmit=async e=>{
  e.preventDefault();playlistRequestId ||= crypto.randomUUID();$('#playlist-create-button').disabled=true;
  try{const created=await post('/api/youtube/playlists',{requestId:playlistRequestId,title:$('#playlist-title').value,description:$('#playlist-description').value,privacy:$('#playlist-privacy').value});playlistRequestId=null;$('#playlist-dialog').close();await loadPlaylists();toast('Playlist créée : '+created.title);}
  catch(e){$('#playlist-create-status').textContent=e.message;}finally{$('#playlist-create-button').disabled=false;}
};
$('#defaults-form').onsubmit=async e=>{
  e.preventDefault();const defaults=Object.fromEntries(Object.keys(networks).map(n=>[n,{title:$('#pref-'+n+'-title').value,description:$('#pref-'+n+'-description').value,time:$('#pref-'+n+'-time').value,...(n==='youtube'?youtubeValues('pref-youtube'):{} )}]));
  try{const result=await api('/api/preferences',{method:'PUT',body:JSON.stringify(defaults)});state.defaults=result.defaults;$('#defaults-status').textContent='Réglages enregistrés pour les prochaines publications.';}catch(e){$('#defaults-status').textContent=e.message;}
};
function openComposer(p){
  $('#compose-form').reset();draftId=p?.id;$('#composer-heading').textContent=p?.status==='scheduled'?'Modifier la publication':'Une nouvelle publication';$('#title').value=p?.title || '';$('#description').value=p?.description || '';$('#compose-status').textContent='Le serveur conserve une seule copie temporaire.';$('#schedule-button').disabled=false;
  if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=null;}$('#video-preview').hidden=true;
  $('#dropzone').hidden=!!p?.hasMedia;$('#file').required=!p?.hasMedia;$('#file-name').textContent=p?.hasMedia?`MP4 déjà importé · ${bytes(p.size)}`:'';
  $('#upload-limit').textContent=`MP4 · ${bytes(state.storage.maxUpload)} maximum · sans copie d’archive`;
  const defaultDate=new Date(Date.now()+3600000);defaultDate.setMinutes(0);defaultDate.setSeconds(0);defaultDate.setMilliseconds(0);
  $('#scheduled-at').value=localDate(p?.scheduledAt || defaultDate);
  $('#time-zone').textContent=`Heure de ton navigateur : ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Le calendrier affiche Paris.`;
  $('#network-picker').innerHTML=Object.entries(networks).map(([n,label])=>`<label class="network-choice"><span class="network-icon ${n}">${symbols[n]}</span><span>${label}<small>${n==='tiktok'?(state.connections.tiktok?'Manuel ou automatique via Buffer':'Publication manuelle'):state.bufferNetworks?.[n]?'Reel automatique via Buffer':state.connections[n]?'Envoi automatique':'Compte à configurer'}</small></span><input type="checkbox" name="network" value="${n}" ${p?.destinations[n]?'checked':''} ${n!=='tiktok'&&!state.connections[n]?'disabled':''}></label>`).join('');
  $('#tiktok-mode').querySelector('[value=buffer]').disabled=!state.connections.tiktok;
  $('#tiktok-mode').value=p?.destinations.tiktok?.provider==='buffer'?'buffer':'manual';
  $('#tiktok-ai').value=p?.destinations.tiktok?.tiktokAiGenerated===undefined?'':String(p.destinations.tiktok.tiktokAiGenerated);
  renderDestinationSettings(p);
  updateTikTokOptions();
  $('#composer').showModal();
}
function updateTikTokOptions(){
  const selected=!!document.querySelector('[name=network][value=tiktok]:checked');
  const automatic=selected&&$('#tiktok-mode').value==='buffer';
  document.querySelectorAll('[data-network-card]').forEach(card=>{const enabled=!!document.querySelector(`[name=network][value=${card.dataset.networkCard}]:checked`);card.hidden=!enabled;card.disabled=!enabled;});
  const playlists=$('#dest-youtube-playlists');if(playlists)playlists.disabled=!state.youtubePlaylistsEnabled;
  $('#tiktok-options').hidden=!selected;$('#tiktok-ai-options').hidden=!automatic;$('#tiktok-ai').required=automatic;
}
$('#network-picker').onchange=updateTikTokOptions;$('#tiktok-mode').onchange=updateTikTokOptions;
$('#login-form').addEventListener('submit',async e=>{e.preventDefault();$('#login-error').textContent='';try{await post('/api/login',{password:$('#password').value});$('#password').value='';await refresh();}catch(e){$('#login-error').textContent=e.message;}});
$('#logout').onclick=async()=>{try{await post('/api/logout',{});$('#app').hidden=true;$('#login').hidden=false;}catch(e){toast(e.message);}};
document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{document.querySelectorAll('.view').forEach(v=>v.hidden=v.id!==`view-${button.dataset.view}`);document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b===button));$('#breadcrumb').textContent={queue:'Publications',accounts:'Mes réseaux',storage:'Stockage',settings:'Réglages'}[button.dataset.view];});
$('#filter').onchange=render;$('#new-post').onclick=()=>openComposer();
document.addEventListener('click',async e=>{
  const close=e.target.closest('[data-close]');if(close)$('#'+close.dataset.close).close();
  const fresh=e.target.closest('[data-new]');if(fresh)openComposer();
  const resume=e.target.closest('[data-resume]');if(resume)openComposer(state.posts.find(p=>p.id===resume.dataset.resume));
  const discard=e.target.closest('[data-discard]');if(discard){try{await api(`/api/posts/${discard.dataset.discard}`,{method:'DELETE'});await refresh();toast('Brouillon et fichier temporaire supprimés.');}catch(e){toast(e.message);}}
  const copy=e.target.closest('[data-copy]');if(copy){const p=state.posts.find(p=>p.id===copy.dataset.copy);try{await navigator.clipboard.writeText(`${p.destinations.tiktok.title??p.title}\n\n${p.destinations.tiktok.description??p.description}`);toast('Texte copié.');}catch{toast('La copie nécessite une connexion HTTPS.');}}
  const confirm=e.target.closest('[data-confirm]');if(confirm){confirmTarget={id:confirm.dataset.confirm,network:confirm.dataset.network};$('#confirm-form').reset();$('#remote-url').placeholder=`Lien de la vidéo ${networks[confirmTarget.network]}`;$('#confirm-dialog').showModal();}
});
function preview(file){if(!file)return;if(file.size>state.storage.maxUpload){toast('Vidéo trop volumineuse.');$('#file').value='';return;}if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=URL.createObjectURL(file);$('#video-preview').src=previewUrl;$('#video-preview').hidden=false;$('#file-name').textContent=`${file.name} · ${bytes(file.size)}`;}
$('#file').onchange=()=>preview($('#file').files[0]);
['dragenter','dragover'].forEach(n=>$('#dropzone').addEventListener(n,e=>{e.preventDefault();$('#dropzone').classList.add('dragging');}));
$('#dropzone').addEventListener('dragleave',()=>$('#dropzone').classList.remove('dragging'));
$('#dropzone').addEventListener('drop',e=>{e.preventDefault();$('#dropzone').classList.remove('dragging');if(e.dataTransfer.files.length===1){$('#file').files=e.dataTransfer.files;preview($('#file').files[0]);}});
$('#compose-form').onsubmit=async e=>{
  e.preventDefault();const selected=[...document.querySelectorAll('[name=network]:checked')].map(n=>n.value);if(!selected.length)return toast('Choisis au moins un réseau.');
  $('#schedule-button').disabled=true;
  try{
    if(!draftId){const draft=await post('/api/posts',{});draftId=draft.id;}
    const existing=state.posts.find(p=>p.id===draftId);
    if(!existing?.hasMedia){const file=$('#file').files[0];if(!file)throw new Error('Choisis une vidéo MP4.');$('#compose-status').textContent='Import du MP4 en cours…';await api(`/api/posts/${draftId}/media`,{method:'PUT',headers:{'Content-Type':'video/mp4'},body:file});await refresh();$('#file').required=false;$('#dropzone').hidden=true;}
    $('#compose-status').textContent='Enregistrement du calendrier…';
    await post(`/api/posts/${draftId}/schedule`,{title:$('#title').value,description:$('#description').value,scheduledAt:new Date($('#scheduled-at').value).toISOString(),madeForKids:$('#dest-youtube-kids').value==='true',networks:selected,destinationSettings:collectDestinationSettings(selected),tiktokMode:$('#tiktok-mode').value,tiktokAiGenerated:$('#tiktok-ai').value==='true'});
    $('#composer').close();await refresh();toast('Publication ajoutée à la file.');
  }catch(e){$('#compose-status').textContent=e.message;}finally{$('#schedule-button').disabled=false;}
};
$('#confirm-form').onsubmit=async e=>{e.preventDefault();try{await post(`/api/posts/${confirmTarget.id}/confirm`,{network:confirmTarget.network,url:$('#remote-url').value,confirmed:$('#confirmed').checked});$('#confirm-dialog').close();await refresh();toast('Réception confirmée.');}catch(e){toast(e.message);}};
await refresh();setInterval(()=>{if(!$('#app').hidden&&!document.querySelector('dialog[open]'))refresh();},20000);
