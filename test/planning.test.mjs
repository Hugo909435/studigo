import test from 'node:test';
import assert from 'node:assert/strict';
import { destinationPlan, planFor } from '../lib/planning.mjs';

const common={title:'Titre commun',description:'Texte commun',scheduledAt:new Date(Date.now()+86400000).toISOString(),madeForKids:false};
test('réglages indépendants : description vide, heure propre, playlists et compatibilité des anciennes publications',()=>{
  const youtube=destinationPlan('youtube',{title:'Quiz YouTube',description:'',tags:['quiz','quiz'],playlistIds:['PLfirst','PLsecond']},common);
  assert.equal(youtube.description,'');assert.deepEqual(youtube.tags,['quiz']);
  const later=new Date(Date.now()+172800000).toISOString();
  const tiktok=destinationPlan('tiktok',{title:'Quiz TikTok',scheduledAt:later},common);
  assert.equal(tiktok.scheduledAt,later);assert.equal(tiktok.description,common.description);
  assert.equal(planFor(common,{state:'pending'}).scheduledAt,common.scheduledAt);
  assert.equal(planFor(common,tiktok).title,'Quiz TikTok');assert.equal(common.title,'Titre commun');
});
test('validation des limites par réseau, dates, audience et listes de playlists',()=>{
  assert.throws(()=>destinationPlan('instagram',{description:'x'.repeat(2200)},common),/2200/);
  assert.throws(()=>destinationPlan('youtube',{madeForKids:'false'},common),/enfants/);
  assert.throws(()=>destinationPlan('youtube',{playlistIds:['<script>']},common),/Playlists/);
  assert.throws(()=>destinationPlan('tiktok',{scheduledAt:'not-a-date'},common),/date/);
  assert.equal(destinationPlan('youtube',{description:'x'.repeat(5000)},common).description.length,5000);
});

test('couvertures : instants en millisecondes uniquement pour Instagram et TikTok',()=>{
  assert.equal(destinationPlan('instagram',{thumbnailOffset:0},common).thumbnailOffset,0);
  assert.equal(destinationPlan('tiktok',{thumbnailOffset:1250},common).thumbnailOffset,1250);
  for(const value of [-1,1.5,'1000',2147483648])assert.throws(()=>destinationPlan('instagram',{thumbnailOffset:value},common),/Couverture/);
  assert.throws(()=>destinationPlan('facebook',{thumbnailOffset:0},common),/Couverture/);
  assert.equal(planFor(common,{thumbnailOffset:2400}).thumbnailOffset,2400);
});
