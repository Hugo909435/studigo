import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { planFor } from './planning.mjs';

export async function purgeDelivered(store, post) {
  if (!post.media || !Object.keys(post.destinations).length || !Object.values(post.destinations).every(d => d.state === 'delivered')) return false;
  try { await unlink(join(store.media, post.media)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  post.media = null;
  post.deletedAt = new Date().toISOString();
  post.status = 'complete';
  store.save(post);
  return true;
}

export function createWorker(store, providers, { now = () => Date.now(), locks = new Set() } = {}) {
  let running = false;
  return async function tick() {
    if (running) return;
    running = true;
    try {
      for (const snapshot of store.list()) {
        let post = store.get(snapshot.id);
        if (post.status !== 'scheduled') continue;
        if (locks.has(post.id)) continue;
        locks.add(post.id);
        try {
        for (const network of Object.keys(post.destinations)) {
          post = store.get(post.id);
          const d = post.destinations[network];
          if (!providers[network] || ['delivered','attention','manual'].includes(d.state)) continue;
          const planned=planFor(post,d);
          if ((network !== 'youtube' || (planned.privacy && planned.privacy!=='public')) && new Date(planned.scheduledAt).getTime() > now()) continue;
          try {
            await providers[network](planned, d, () => store.save(post));
          } catch {
            // Ne jamais afficher les réponses brutes : elles peuvent contenir des jetons.
            d.state = 'attention';
            d.error = d.playlistAdding?'Vidéo reçue sur YouTube, classement en playlist à vérifier dans YouTube Studio. Ne republie pas la vidéo.':'Envoi interrompu. Vérifie le réseau avant toute nouvelle tentative pour éviter un doublon.';
            store.save(post);
          }
        }
        post = store.get(post.id);
        if (await purgeDelivered(store, post)) { post.status = 'complete'; store.save(post); }
        } finally { locks.delete(post.id); }
      }
    } finally { running = false; }
  };
}
