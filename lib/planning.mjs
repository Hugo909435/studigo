const names={youtube:'YouTube',facebook:'Facebook',instagram:'Instagram',tiktok:'TikTok'};
const bad=message=>{throw Object.assign(new Error(message),{status:400});};
export function planFor(post,destination) {
  return {...post,...Object.fromEntries(['title','description','scheduledAt','madeForKids','privacy','tags','playlistIds','tiktokAiGenerated','thumbnailOffset'].filter(key=>destination[key]!==undefined).map(key=>[key,destination[key]]))};
}
export function destinationPlan(network,input,common={}, {future=true}={}) {
  if(!names[network] || !input || typeof input!=='object' || Array.isArray(input)) bad('Réglages du réseau invalides');
  const title=input.title ?? common.title ?? '',description=input.description ?? common.description ?? '';
  if(typeof title!=='string'||!title.trim()||title.length>100||/[<>]/.test(title)) bad(`${names[network]} : titre requis, 100 caractères maximum, sans chevrons`);
  const limit=network==='youtube'?5000:network==='facebook'?5000:network==='instagram'?2200:4000;
  if(typeof description!=='string'||description.length>limit) bad(`${names[network]} : description trop longue (${limit} caractères maximum)`);
  if(['instagram','tiktok'].includes(network) && `${title.trim()}\n\n${description}`.length>limit) bad(`${names[network]} : titre et description dépassent ${limit} caractères`);
  const date=new Date(input.scheduledAt ?? common.scheduledAt);
  if(!Number.isFinite(date.getTime()) || (future && date.getTime()<Date.now()-60000)) bad(`${names[network]} : choisir une date à venir`);
  const result={title:title.trim(),description,scheduledAt:date.toISOString()};
  if(input.thumbnailOffset!==undefined && input.thumbnailOffset!==null) {
    if(!['instagram','tiktok'].includes(network) || !Number.isSafeInteger(input.thumbnailOffset) || input.thumbnailOffset<0 || input.thumbnailOffset>2147483647) bad('Couverture : choisir une image valide de la vidéo pour Instagram ou TikTok');
    result.thumbnailOffset=input.thumbnailOffset;
  }
  if(network==='youtube') {
    const madeForKids=input.madeForKids ?? common.madeForKids;
    if(typeof madeForKids!=='boolean') bad('YouTube : indiquer si la vidéo est conçue pour les enfants');
    const privacy=input.privacy ?? 'public';
    if(!['public','unlisted','private'].includes(privacy)) bad('Visibilité YouTube invalide');
    const tags=input.tags ?? [];
    if(!Array.isArray(tags)||tags.length>50||tags.some(v=>typeof v!=='string'||!v.trim()||v.length>100)||tags.join(',').length>450||tags.reduce((sum,v)=>sum+v.length+(v.includes(' ')?2:0),Math.max(0,tags.length-1))>500) bad('Tags YouTube invalides (450 caractères maximum)');
    const playlistIds=input.playlistIds ?? [];
    if(!Array.isArray(playlistIds)||playlistIds.length>20||playlistIds.some(v=>typeof v!=='string'||!/^[a-zA-Z0-9_-]{5,100}$/.test(v))) bad('Playlists YouTube invalides');
    Object.assign(result,{madeForKids,privacy,tags:[...new Set(tags.map(v=>v.trim()))],playlistIds:[...new Set(playlistIds)]});
  }
  if(network==='tiktok') {
    result.tiktokAiGenerated=input.tiktokAiGenerated ?? common.tiktokAiGenerated ?? false;
    if(typeof result.tiktokAiGenerated!=='boolean') bad('TikTok : indiquer si la vidéo est générée par IA');
  }
  return result;
}
