# Studigo

Application privée de préparation et de programmation des vidéos. Projet et dépôt Git indépendants du site public `cultureQui`. Aucun média du projet existant n'a été copié.

## Démarrer en local

Node.js 24 minimum. Pas de dépendances npm à installer.

Assistant de configuration : `npm run setup` crée `.env` et te laisse choisir le mot de passe, puis `npm start` lance l'application. La saisie du mot de passe dans cet assistant est visible dans le terminal local.

1. Copier `.env.example` vers `.env`.
2. Définir `ADMIN_PASSWORD` (16 caractères minimum) et `MEDIA_SECRET` (32 minimum). Générer chacun avec `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
3. Lancer `npm start`, puis ouvrir http://127.0.0.1:4310.
4. Entrer le mot de passe configuré. Ne jamais le placer dans Git ni le communiquer dans une URL.

`npm run dev` : redémarrage sur modification. `npm run check` et `npm test` : vérifications.

## Fonctionnalités et limites réelles

- Import MP4 en flux, sans charger la vidéo entière en mémoire ; une seule copie par publication.
- Publications, états des réseaux et calendrier persistants en SQLite. Historique conservé sans vidéo.
- Mot de passe, cookie HttpOnly/SameSite, contrôle d'origine, limitation des connexions et liens média signés pour Meta.
- Google OAuth avec jetons chiffrés AES-256-GCM en base. Garder MEDIA_SECRET stable : le changer invalide les jetons enregistrés.
- YouTube : upload anticipé avec `publishAt`, puis vérification du traitement. La politique d'accès et les autorisations du projet Google restent à vérifier sur le compte réel.
- Facebook : Reels sur une **Page**, pas un profil personnel. Envoi au créneau choisi, publication, puis interrogation du statut.
- Instagram : Reels sur un **compte professionnel lié à la Page**. Le serveur transmet une URL signée à Meta à l'heure choisie et attend la préparation du conteneur avant publication.
- TikTok : préparation du texte, téléchargement du fichier et confirmation manuelle avec lien. Aucun faux bouton de connexion ni publication Direct Post privée. Les [règles TikTok](https://developers.tiktok.com/doc/content-sharing-guidelines/) excluent les utilitaires uniquement destinés aux comptes de son propriétaire ou de son équipe. Une éventuelle autre solution devra être évaluée séparément.
- Les adaptateurs utilisent les API réelles ; ils ne sont **pas validés sur tes comptes** tant que les identifiants et autorisations ne sont pas fournis. Les tests simulent les réponses réseau et ne publient rien.
- Première version : un texte commun, un MP4 et une date par publication. Pas encore d'import automatique du dossier CultureQui, de miniatures personnalisées, d'édition par réseau ni de reprise automatique d'upload interrompu.

## Stockage : réception avant suppression

Une date enregistrée dans le studio est une programmation **locale**, pas une confirmation du réseau.

Le MP4 est supprimé uniquement lorsque toutes les destinations sont `delivered`. Pour YouTube, on attend `processingStatus=succeeded`. Pour Instagram, on attend l'ID renvoyé par `media_publish`. Pour Facebook, on attend le statut de publication terminé et la vidéo prête. Pour TikTok, l'utilisateur vérifie la réception puis confirme avec le lien. La suppression concerne uniquement la copie du studio, jamais le fichier d'origine sur l'ordinateur.

Si un réseau échoue, le MP4 reste présent. Le studio ne relance pas automatiquement les résultats ambigus, pour ne pas créer de doublons. Un arrêt pendant un upload ou une publication passe la destination en « À vérifier ». Vérifier alors le réseau. Si la vidéo a été reçue, coller son lien pour confirmer. Si elle n'a pas été reçue, conserver le fichier et traiter l'incident ; cette version ne propose pas de relance risquée.

Instagram ne constitue pas un stockage durable pour une vidéo programmée plusieurs semaines à l'avance. Le serveur garde donc la copie temporaire jusqu'au créneau et à la confirmation. Il faut dimensionner le stockage pour les vidéos en attente ; zéro stockage dès le clic « Programmer » n'est pas possible pour tous les réseaux.

Quotas configurables : `MAX_UPLOAD_MB=1024`, `MAX_STORAGE_MB=5120`. Les brouillons sont supprimables depuis l'interface ; supprimer un brouillon enlève aussi son MP4. Aucune génération de miniature ni copie d'archive. Les textes et liens occupent peu de place mais restent en base. Les journaux Docker sont limités. Les médias temporaires `data/media/` ne doivent pas être inclus dans les sauvegardes de l'hébergeur : sa rétention et ses snapshots sont indépendants de l'application.

## Connecter les comptes

### YouTube

Créer un projet Google Cloud, activer YouTube Data API v3 et configurer l'écran de consentement OAuth ainsi qu'un client Web. Ajouter exactement `APP_URL/auth/youtube/callback` aux URI autorisées. Renseigner GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans `.env`, redémarrer, puis « Mes réseaux → Connecter ma chaîne ». Vérifier les exigences Google de consentement, quotas et durée de vie des jetons en mode test. L'option « Conçu pour les enfants » est demandée à chaque publication.

### Meta

Créer/configurer une application Meta avec les droits de publication nécessaires. Pour le parcours Facebook Login retenu, prévoir notamment `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`, sous réserve des accès accordés à ton application.

Obtenir un jeton de Page approprié et renseigner `META_PAGE_TOKEN`, `META_PAGE_ID`, `INSTAGRAM_USER_ID`. Utiliser une Page Facebook liée au compte professionnel Instagram. Le jeton reste sur le serveur. Choisir la version Graph supportée par l'application via META_GRAPH_VERSION ; le défaut de ce projet est v24.0. La configuration présente ne garantit pas que le jeton est valide : la vérification complète requiert un essai réel sur chaque compte.

Références : [YouTube upload](https://developers.google.com/youtube/data/guides/using_resumable_upload_protocol), [ressource YouTube videos](https://developers.google.com/youtube/data/docs/reference/videos), [collection officielle Meta Instagram](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api), [collection officielle Meta Facebook](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api).

## Héberger sur un sous-domaine

Cette application a besoin d'un processus Node permanent et d'un disque persistant. Un hébergement purement statique ou une fonction éphémère ne convient pas. Aucun hébergement ni DNS n'est créé par ce dépôt.

1. Choisir le sous-domaine (exemple : `studio.quizzgenerale.com`) et diriger son DNS vers le serveur.
2. Configurer APP_URL avec son URL HTTPS exacte, le mot de passe, les secrets et les comptes.
3. Installer Docker et lancer `docker compose up -d --build`. Les données sont dans le volume `studio-data`.
4. Configurer Caddy avec `deploy/Caddyfile`, ou l'équivalent Nginx de l'hébergeur. Exposer uniquement le proxy HTTPS. Le port 4310 est lié à 127.0.0.1 sur l'hôte.
5. Conserver MEDIA_SECRET et la base SQLite dans une sauvegarde privée cohérente. Exclure les MP4 temporaires si l'objectif est de ne pas les archiver. La base SQLite avec WAL doit être sauvegardée par un mécanisme SQLite cohérent ou serveur arrêté.
6. Tester les trois réseaux automatiques avec une vidéo dédiée, vérifier les liens et contrôler la suppression après la dernière confirmation. Aucun test local ne remplace cette validation sur les comptes.

Le worker passe toutes les 20 secondes tant que le serveur tourne. En cas d'arrêt, les envois reprennent au redémarrage, avec un décalage possible sur l'heure prévue. Un seul processus Node et une seule instance doivent utiliser cette base ; ne pas répliquer le service. La base et les médias sont privés et ne doivent jamais être servis comme dossier statique.

## Git

Le dépôt local est initialisé sur `codex/studio`. Aucun dépôt distant n'est créé sans destination choisie. `.env`, `data/`, les vidéos et les journaux sont ignorés.

Police Montserrat : licence SIL Open Font License, voir `public/fonts/OFL.txt`.
