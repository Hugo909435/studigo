// Private Studigo transport only. Social websites must be operated with the
// browser tools of the agent, never through undocumented endpoints.
import { loadEnvFile } from 'node:process';
import { mkdir, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
const base=resolve(dirname(fileURLToPath(import.meta.url)),'..');
try{loadEnvFile(join(base,'.env'));}catch(e){if(e.code!=='ENOENT')throw e;}
const origin=new URL(process.env.APP_URL || 'http://127.0.0.1:4310').origin;
const root=resolve(base,process.env.DATA_DIR || 'data');
if(!process.env.ADMIN_PASSWORD)throw new Error('Configuration privée Studigo absente.');
const login=await fetch(origin+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password:process.env.ADMIN_PASSWORD}),signal:AbortSignal.timeout(30000)});
if(!login.ok)throw new Error('Connexion privée Studigo refusée.');
const cookie=login.headers.get('set-cookie')?.split(';')[0];
async function request(path,data){
  const response=await fetch(origin+path,{method:data?'POST':'GET',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(120000)});
  if(!response.ok){const result=await response.json();throw new Error(result.error || 'Requête Studigo refusée.');}return response;
}
async function cleanCache(posts){
  if(process.platform==='win32'&&/^\//.test(process.env.DATA_DIR || ''))return;
  for(const p of posts)if(p.status==='complete'&&/^[a-f0-9-]{36}$/.test(p.id)&&Object.values(p.destinations).length&&Object.values(p.destinations).every(d=>d.state==='delivered')){
    const directory=join(root,'browser-cache',p.id);
    for(const name of ['video.mp4',...['facebook','instagram','tiktok'].flatMap(n=>[n+'.json','cover-'+n+'.png','cover-'+n+'.jpg'])])await unlink(join(directory,name)).catch(e=>{if(e.code!=='ENOENT')throw e;});
    await rmdir(directory).catch(e=>{if(!['ENOENT','ENOTEMPTY'].includes(e.code))throw e;});
  }
}
const [command='status',input]=process.argv.slice(2);
async function inputJson(){if(input)return JSON.parse(await readFile(input,'utf8'));let text='';for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>65536)throw new Error('Requête trop grande.');}return JSON.parse(text);}
try {
  if(command==='status'){const s=await (await request('/api/state')).json();console.log(JSON.stringify({agent:s.browserAgent,posts:s.posts.map(p=>({id:p.id,status:p.status,destinations:p.destinations}))}));}
  else if(command==='jobs'){await request('/api/browser/heartbeat',{});const {posts}=await (await request('/api/state')).json();await cleanCache(posts).catch(()=>{});console.log(JSON.stringify(await (await request('/api/browser/jobs')).json()));}
  else if(['account','claim','result'].includes(command)){
    // Read JSON from a file or stdin; never interpolate publication text in shell code.
    const data=await inputJson();
    const result=await (await request('/api/browser/'+command,data)).json();
    if(command==='result'&&data.outcome==='delivered'){const {posts}=await (await request('/api/state')).json();await cleanCache(posts).catch(()=>{});}
    console.log(JSON.stringify(result));
  } else if(command==='download') {
    if(process.platform==='win32'&&/^\//.test(process.env.DATA_DIR || ''))throw new Error('Définir DATA_DIR vers le dossier local privé avant de télécharger les médias. Le chemin Linux de l’hébergement ne convient pas sous Windows.');
    const data=await inputJson();
    if(!/^[a-f0-9-]{36}$/.test(data.postId)||!['facebook','instagram','tiktok'].includes(data.network))throw new Error('Destination invalide.');
    const {posts}=await (await request('/api/state')).json(),p=posts.find(p=>p.id===data.postId),d=p?.destinations[data.network];
    if(d?.provider!=='browser'||d.state!=='agent_preparing'||d.claim?.token!==data.token)throw new Error('Prendre en charge le travail avant le téléchargement.');
    const directory=join(root,'browser-cache',p.id);await mkdir(directory,{recursive:true});
    const video=join(directory,'video.mp4');const response=await request('/api/posts/'+p.id+'/download');await pipeline(Readable.fromWeb(response.body),createWriteStream(video,{mode:0o600}));
    let cover=null;if(p.covers?.[data.network] || p.covers?.common){const image=await request('/api/posts/'+p.id+'/cover?network='+data.network+'&effective=true');cover=join(directory,'cover-'+data.network+'.'+(image.headers.get('content-type')==='image/png'?'png':'jpg'));await pipeline(Readable.fromWeb(image.body),createWriteStream(cover,{mode:0o600}));}
    const manifest={postId:p.id,network:data.network,video,cover,plan:{title:d.title,description:d.description,scheduledAt:d.scheduledAt,thumbnailOffset:d.thumbnailOffset,facebookPlaylist:d.facebookPlaylist,tiktokAiGenerated:d.tiktokAiGenerated,nativeOptions:d.nativeOptions},accountId:d.accountId};
    await writeFile(join(directory,data.network+'.json'),JSON.stringify(manifest),{mode:0o600});console.log(JSON.stringify(manifest));
  }else throw new Error('Commande inconnue.');
} finally {await request('/api/logout',{}).catch(()=>{});}
