import { randomUUID } from 'node:crypto';
import { planFor, coverFor } from './planning.mjs';

export const browserNetworks=['facebook','instagram','tiktok'];
const error=message=>{throw Object.assign(new Error(message),{status:409});};
export function browserStatus(store,now=Date.now()) {
  const saved=store.setting('browserAgent') || {};
  return {lastSeenAt:saved.lastSeenAt || null,online:now-new Date(saved.lastSeenAt || 0).getTime()<15*60000,accounts:saved.accounts || {}};
}
export function browserRequirements(p,network,plan) {
  return ['schedule',...(coverFor(p,network)?['customCover']:[]),...(plan.thumbnailOffset!==undefined?['videoFrame']:[]),...(plan.facebookPlaylist?['playlist']:[]),...(network==='tiktok'?['aiLabel']:[]),...(Object.keys(plan.nativeOptions || {}).length?['advancedOptions']:[])];
}
export function browserBlockers(store,p,network,plan,now=Date.now()) {
  const status=browserStatus(store,now),account=status.accounts[network],issues=[];
  if(!account?.id) issues.push('Compte à connecter et à vérifier dans le navigateur de l’agent.');
  else {
    for(const key of browserRequirements(p,network,plan)) if(account.features?.[key]!==true) issues.push(({schedule:'Programmation native',customCover:'Import de couverture',videoFrame:'Choix d’une image de la vidéo',playlist:'Classement en playlist',aiLabel:'Mention de contenu IA',advancedOptions:'Réglages avancés'})[key]+' non vérifié sur ce compte.');
    const delay=new Date(plan.scheduledAt).getTime()-now;
    if(!Number.isFinite(account.maxAdvanceDays)||account.maxAdvanceDays<=0) issues.push('Horizon de programmation du compte non vérifié.');
    if(delay<(account.minAdvanceMinutes || 0)*60000) issues.push('Horaire trop proche pour programmer sur ce réseau.');
    if(network==='facebook'&&plan.facebookPlaylist&&account.playlists&&!account.playlists.includes(plan.facebookPlaylist))issues.push('Playlist absente des playlists vérifiées sur cette Page.');
  }
  return issues;
}
export function saveBrowserAccount(store,data,now=Date.now()) {
  if(!browserNetworks.includes(data.network)||typeof data.id!=='string'||!data.id.trim()||data.id.length>200||typeof data.name!=='string'||!data.name.trim()||data.name.length>200) error('Identité du compte navigateur requise.');
  if(!Number.isFinite(data.maxAdvanceDays)||data.maxAdvanceDays<=0||data.maxAdvanceDays>365||!Number.isFinite(data.minAdvanceMinutes)||data.minAdvanceMinutes<0||data.minAdvanceMinutes>1440) error('Limites de programmation à vérifier.');
  if(typeof data.evidence!=='string'||data.evidence.trim().length<10||data.evidence.length>2000) error('Preuve de vérification de l’interface requise.');
  const previous=browserStatus(store,now),features={};
  for(const key of ['schedule','customCover','videoFrame','playlist','aiLabel','advancedOptions']) features[key]=data.features?.[key]===true;
  const account={id:data.id.trim(),name:data.name.trim(),features,maxAdvanceDays:data.maxAdvanceDays,minAdvanceMinutes:data.minAdvanceMinutes,evidence:data.evidence,verifiedAt:new Date(now).toISOString()};
  if(data.network==='facebook'&&data.playlists!==undefined){if(!Array.isArray(data.playlists)||data.playlists.length>200||data.playlists.some(v=>typeof v!=='string'||!v.trim()||v.length>150))error('Liste des playlists Facebook invalide.');account.playlists=[...new Set(data.playlists)];}
  store.setting('browserAgent',{lastSeenAt:new Date(now).toISOString(),accounts:{...previous.accounts,[data.network]:account}});
  return account;
}
export function recoverBrowserJobs(store,now=Date.now()) {
  for(const p of store.list()) for(const d of Object.values(p.destinations)) if(d.provider==='browser'&&['agent_preparing','agent_submitting'].includes(d.state)&&d.claim?.expiresAt<=now) {
    d.state='attention';d.error='Session de l’agent interrompue. Vérifier le réseau avant toute nouvelle tentative.';delete d.claim;store.save(p);
  }
}
export function browserJobs(store,now=Date.now()) {
  recoverBrowserJobs(store,now);
  const jobs=[];
  for(const p of store.list()) if(p.status==='scheduled'&&p.media) for(const [network,d] of Object.entries(p.destinations)) {
    if(d.provider!=='browser'||!['agent_queued','remote_scheduled'].includes(d.state))continue;
    const account=browserStatus(store,now).accounts[network];
    if(d.state==='agent_queued'&&new Date(d.scheduledAt).getTime()-now>(account?.maxAdvanceDays || 0)*86400000)continue;
    if(d.state==='remote_scheduled'&&new Date(d.scheduledAt).getTime()>now)continue;
    jobs.push({postId:p.id,network,state:d.state,accountId:d.accountId,plan:planFor(p,d),requirements:browserRequirements(p,network,d)});
  }
  // Never expose filesystem paths to the client.
  return jobs.sort((a,b)=>a.plan.scheduledAt.localeCompare(b.plan.scheduledAt)).map(job=>({...job,plan:{...job.plan,media:undefined,cover:undefined,covers:undefined,destinations:undefined},mediaUrl:`/api/posts/${job.postId}/download`,coverUrl:coverFor(store.get(job.postId),job.network)?`/api/posts/${job.postId}/cover?network=${job.network}&effective=true`:null}));
}
export function claimBrowserJob(store,p,network,now=Date.now()) {
  const d=p.destinations[network];
  if(d?.provider!=='browser'||d.state!=='agent_queued')error('Cette destination ne peut pas être prise en charge.');
  const issues=browserBlockers(store,p,network,d,now);if(issues.length)error(issues.join(' '));
  const account=browserStatus(store,now).accounts[network];
  if(account.id!==d.accountId)error('Le compte navigateur a changé. Vérifier la destination.');
  if(new Date(d.scheduledAt).getTime()-now>account.maxAdvanceDays*86400000)error('Publication encore hors de l’horizon de programmation.');
  d.claim={token:randomUUID(),expiresAt:now+30*60000};d.state='agent_preparing';store.save(p);return d.claim;
}
export function browserResult(store,p,network,data,now=Date.now()) {
  if(!['begin','finish','check','attention'].includes(data.action))error('Action de traitement inconnue.');
  const d=p.destinations[network];
  if(d?.provider!=='browser')error('Destination navigateur absente.');
  if(data.action==='check') {
    if(d.state!=='remote_scheduled')error('Programmation distante absente.');
  } else if(!d.claim||d.claim.token!==data.token||d.claim.expiresAt<=now||!['agent_preparing','agent_submitting'].includes(d.state)) error('Session de traitement expirée ou incorrecte.');
  if(data.action==='begin') {if(d.state!=='agent_preparing')error('Validation finale déjà commencée.');d.state='agent_submitting';store.save(p);return d;}
  if(data.action==='attention') {d.state='attention';d.error=typeof data.message==='string'?data.message.slice(0,1000):'Vérification du réseau nécessaire.';delete d.claim;store.save(p);return d;}
  if(!['scheduled','delivered'].includes(data.outcome)||data.accountId!==d.accountId||typeof data.remoteId!=='string'||!data.remoteId||data.remoteId.length>200||typeof data.evidence!=='string'||data.evidence.trim().length<10||data.evidence.length>2000)error('Preuve de réception et identité du compte requises.');
  if(data.action!=='check'&&d.state!=='agent_submitting')error('La validation finale n’a pas été enregistrée.');
  if(data.action==='check'&&(data.remoteId!==d.remoteId||data.outcome!=='delivered'))error('Vérifier la publication programmée d’origine.');
  if(data.outcome==='scheduled'&&data.scheduledAt!==d.scheduledAt)error('Le réseau n’a pas confirmé le bon horaire.');
  if(data.outcome==='delivered'&&new Date(d.scheduledAt).getTime()>now)error('Une programmation future n’est pas une publication livrée.');
  let link;try{link=new URL(data.url);}catch{error('Lien de preuve requis.');}
  const domains={facebook:['facebook.com','www.facebook.com','business.facebook.com'],instagram:['instagram.com','www.instagram.com','business.facebook.com'],tiktok:['tiktok.com','www.tiktok.com']};
  if(link.protocol!=='https:'||!domains[network].includes(link.hostname)||link.username||link.password||link.pathname==='/')error('Lien de preuve du bon réseau requis.');
  if(data.outcome==='delivered'){
    const content=network==='tiktok'?/^\/@[^/]+\/video\/\d+\/?$/.test(link.pathname):network==='instagram'?/^\/(reel|reels|p)\/[a-zA-Z0-9_-]+\/?$/.test(link.pathname):/\/(reel|videos|posts)\/[^/]+/.test(link.pathname)||['/watch/','/watch','/permalink.php','/story.php'].includes(link.pathname)&&!!(link.searchParams.get('v')||link.searchParams.get('story_fbid'));
    if(!content||link.hostname==='business.facebook.com')error('Lien public de la vidéo publiée requis, pas le calendrier.');
    if(network==='tiktok'&&d.accountId.startsWith('@')&&decodeURIComponent(link.pathname.split('/')[1])!==d.accountId)error('La vidéo appartient à un autre compte TikTok.');
  }
  const expected=browserRequirements(p,network,d);
  if(expected.some(key=>data.verified?.[key]!==true))error('Tous les réglages demandés doivent être vérifiés sur le réseau.');
  Object.assign(d,{state:data.outcome==='scheduled'?'remote_scheduled':'delivered',remoteId:data.remoteId,url:link.href,evidence:data.evidence,verified:data.verified,acceptedAt:d.acceptedAt || new Date(now).toISOString()});
  if(data.outcome==='delivered')d.confirmedAt=new Date(now).toISOString();
  delete d.claim;delete d.error;store.save(p);return d;
}
