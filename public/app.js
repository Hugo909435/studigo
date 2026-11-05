const $=s=>document.querySelector(s);
const networks={youtube:'YouTube',facebook:'Facebook',instagram:'Instagram',tiktok:'TikTok'};
const symbols={youtube:'▶',facebook:'f',instagram:'◎',tiktok:'♪'};
const labels={pending:'À envoyer',uploading:'Envoi en cours',processing:'Traitement',publishing:'Publication',delivered:'Réception confirmée',attention:'À vérifier',manual:'Envoi manuel'};
let state, draftId, confirmTarget, previewUrl;
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bytes=n=>n>=1024**3?`${(n/1024**3).toFixed(2)} Go`:`${(n/1024**2).toFixed(n?1:0)} Mo`;
const date=v=>new Intl.DateTimeFormat('fr-FR',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Paris'}).format(new Date(v));
async function api(path,options={}){const response=await fetch(path,{...options,headers:{...(options.body instanceof File?{}:{'Content-Type':'application/json'}),...options.headers}});const data=await response.json();if(!response.ok){if(response.status===401){$('#login').hidden=false;$('#app').hidden=true;}throw new Error(data.error);}return data;}
const post=(path,data)=>api(path,{method:'POST',body:JSON.stringify(data)});
function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,6000);}
async function refresh(){try{state=await api('/api/state');$('#login').hidden=true;$('#app').hidden=false;render();}catch(e){if(!$('#login').hidden)return;toast(e.message);}}
function render(){
  const scheduled=state.posts.filter(p=>p.status==='scheduled').length;
  $('#stat-scheduled').textContent=scheduled;$('#nav-count').textContent=scheduled;$('#stat-complete').textContent=state.posts.filter(p=>p.status==='complete').length;$('#stat-storage').textContent=bytes(state.storage.used);
  $('#storage-total').textContent=`${bytes(state.storage.used)} utilisés`;
  $('#storage-progress').value=state.storage.used/state.storage.limit*100;
  $('#storage-caption').textContent=`Sur ${bytes(state.storage.limit)} autorisés. Une seule copie du MP4, partagée entre toutes les destinations.`;
  const posts=state.posts.filter(p=>$('#filter').value==='all'||p.status===$('#filter').value);
  $('#queue-count').textContent=posts.length;
  $('#posts').innerHTML=posts.length?posts.map(p=>`<article class="post"><div class="post-mark" aria-hidden="true">Q</div><div><h3>${escape(p.title||'Import à terminer')}</h3><p>${p.scheduledAt?`${escape(date(p.scheduledAt))} · Paris`:'Brouillon'} · ${p.hasMedia?`${bytes(p.size)} temporaires`:p.deletedAt?'MP4 supprimé du serveur':'Sans fichier'}</p><div class="post-networks">${Object.entries(p.destinations).map(([n,d])=>`<span class="chip ${escape(d.state)}" title="${escape(d.error||labels[d.state])}">${symbols[n]} ${networks[n]}${d.provider==='buffer'?' via Buffer':''} · ${labels[d.state]}</span>`).join('')}</div></div><div class="post-actions"><span class="post-status ${escape(p.status)}">${{draft:'Brouillon',scheduled:'Dans la file',complete:'Terminée'}[p.status]}</span>${p.status==='draft'?`<button class="text-button" data-resume="${p.id}">Reprendre</button><button class="text-button" data-discard="${p.id}">Supprimer le brouillon</button>`:''}${p.hasMedia?`<a class="text-button" href="/api/posts/${p.id}/download">Télécharger le MP4</a>`:''}${Object.entries(p.destinations).map(([n,d])=>['manual','attention'].includes(d.state)?`<button class="text-button" data-confirm="${p.id}" data-network="${n}">Confirmer ${networks[n]}</button>`:d.url?`<a class="text-button" href="${escape(d.url)}" target="_blank" rel="noreferrer">Voir ${networks[n]} ↗</a>`:'').join('')}${p.destinations.tiktok?.state==='manual'?`<button class="text-button" data-copy="${p.id}">Copier le texte TikTok</button>`:''}</div></article>`).join(''):`<div class="empty"><span aria-hidden="true">↗</span><h2>La prochaine vidéo commence ici.</h2><p>Ajoute un quiz, choisis tes destinations et prépare ta prochaine publication.</p><button class="primary" data-new>＋ Préparer une publication</button></div>`;
  $('#accounts').innerHTML=Object.entries(networks).map(([n,label])=>`<article class="account"><h2><span class="network-icon ${n}">${symbols[n]}</span>${label}</h2><p>${n==='tiktok'?(state.connections.tiktok?'Publication automatique via Buffer disponible. Choisis ce mode dans chaque nouvelle publication.':'Publication manuelle disponible. Configure Buffer pour activer l’envoi automatique.'):state.connections[n]?'Configuration présente. Le premier envoi permettra de vérifier les autorisations du compte.':n==='youtube'?'Autorise ta chaîne via ton application Google.':'Renseigne le jeton de Page et les identifiants Meta dans la configuration du serveur.'}</p>${n==='youtube'&&!state.connections[n]&&state.googleConfigured?'<a class="text-button" href="/auth/youtube">Connecter ma chaîne ↗</a>':`<small>${n==='tiktok'?(state.connections.tiktok?'Buffer configuré':'Manuel'):state.connections[n]?'Configuré':'À configurer'}</small>`}</article>`).join('');
}
function openComposer(p){
  $('#compose-form').reset();draftId=p?.id;$('#compose-status').textContent='Le serveur conserve une seule copie temporaire.';$('#schedule-button').disabled=false;
  if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=null;}$('#video-preview').hidden=true;
  $('#dropzone').hidden=!!p?.hasMedia;$('#file').required=!p?.hasMedia;$('#file-name').textContent=p?.hasMedia?`MP4 déjà importé · ${bytes(p.size)}`:'';
  $('#upload-limit').textContent=`MP4 · ${bytes(state.storage.maxUpload)} maximum · sans copie d’archive`;
  const defaultDate=new Date(Date.now()+3600000);defaultDate.setMinutes(0);defaultDate.setSeconds(0);defaultDate.setMilliseconds(0);
  $('#scheduled-at').value=new Date(defaultDate.getTime()-defaultDate.getTimezoneOffset()*60000).toISOString().slice(0,16);
  $('#time-zone').textContent=`Heure de ton navigateur : ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Le calendrier affiche Paris.`;
  $('#network-picker').innerHTML=Object.entries(networks).map(([n,label])=>`<label class="network-choice"><span class="network-icon ${n}">${symbols[n]}</span><span>${label}<small>${n==='tiktok'?(state.connections.tiktok?'Manuel ou automatique via Buffer':'Publication manuelle'):state.connections[n]?'Envoi automatique':'Compte à configurer'}</small></span><input type="checkbox" name="network" value="${n}" ${n!=='tiktok'&&!state.connections[n]?'disabled':''}></label>`).join('');
  $('#tiktok-mode').querySelector('[value=buffer]').disabled=!state.connections.tiktok;
  updateTikTokOptions();
  $('#composer').showModal();
}
function updateTikTokOptions(){
  const selected=!!document.querySelector('[name=network][value=tiktok]:checked');
  const automatic=selected&&$('#tiktok-mode').value==='buffer';
  $('#tiktok-options').hidden=!selected;$('#tiktok-ai-options').hidden=!automatic;$('#tiktok-ai').required=automatic;
}
$('#network-picker').onchange=updateTikTokOptions;$('#tiktok-mode').onchange=updateTikTokOptions;
$('#login-form').addEventListener('submit',async e=>{e.preventDefault();$('#login-error').textContent='';try{await post('/api/login',{password:$('#password').value});$('#password').value='';await refresh();}catch(e){$('#login-error').textContent=e.message;}});
$('#logout').onclick=async()=>{try{await post('/api/logout',{});$('#app').hidden=true;$('#login').hidden=false;}catch(e){toast(e.message);}};
document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{document.querySelectorAll('.view').forEach(v=>v.hidden=v.id!==`view-${button.dataset.view}`);document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b===button));$('#breadcrumb').textContent={queue:'Publications',accounts:'Mes réseaux',storage:'Stockage'}[button.dataset.view];});
$('#filter').onchange=render;$('#new-post').onclick=()=>openComposer();
document.addEventListener('click',async e=>{
  const close=e.target.closest('[data-close]');if(close)$('#'+close.dataset.close).close();
  const fresh=e.target.closest('[data-new]');if(fresh)openComposer();
  const resume=e.target.closest('[data-resume]');if(resume)openComposer(state.posts.find(p=>p.id===resume.dataset.resume));
  const discard=e.target.closest('[data-discard]');if(discard){try{await api(`/api/posts/${discard.dataset.discard}`,{method:'DELETE'});await refresh();toast('Brouillon et fichier temporaire supprimés.');}catch(e){toast(e.message);}}
  const copy=e.target.closest('[data-copy]');if(copy){const p=state.posts.find(p=>p.id===copy.dataset.copy);try{await navigator.clipboard.writeText(`${p.title}\n\n${p.description}`);toast('Texte copié.');}catch{toast('La copie nécessite une connexion HTTPS.');}}
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
    await post(`/api/posts/${draftId}/schedule`,{title:$('#title').value,description:$('#description').value,scheduledAt:new Date($('#scheduled-at').value).toISOString(),madeForKids:$('#kids').value==='true',networks:selected,tiktokMode:$('#tiktok-mode').value,tiktokAiGenerated:$('#tiktok-ai').value==='true'});
    $('#composer').close();await refresh();toast('Publication ajoutée à la file.');
  }catch(e){$('#compose-status').textContent=e.message;}finally{$('#schedule-button').disabled=false;}
};
$('#confirm-form').onsubmit=async e=>{e.preventDefault();try{await post(`/api/posts/${confirmTarget.id}/confirm`,{network:confirmTarget.network,url:$('#remote-url').value,confirmed:$('#confirmed').checked});$('#confirm-dialog').close();await refresh();toast('Réception confirmée.');}catch(e){toast(e.message);}};
await refresh();setInterval(()=>{if(!$('#app').hidden&&!document.querySelector('dialog[open]'))refresh();},20000);
