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
- TikTok : préparation du texte, téléchargement du fichier et confirmation manuelle avec lien. Aucun faux bouton de connexion ni publication Direct Post privée. Les [règles TikTok](https://developers.tiktok.com/doc/content-sharing-guidelines/) excluent les utilitaires uniquement destinés aux comptes de son propriétaire ou de son équipe. Une intégration optionnelle via Buffer est disponible, sans utiliser de client Direct Post privé.
- Les adaptateurs utilisent les API réelles ; ils ne sont **pas validés sur tes comptes** tant que les identifiants et autorisations ne sont pas fournis. Les tests simulent les réponses réseau et ne publient rien.
- Un MP4 commun, des titres, descriptions et horaires propres à chaque réseau. Réglages réutilisables, visibilité, audience, tags et playlists YouTube. Pas encore d'import automatique du dossier CultureQui, de reprise automatique d'upload interrompu.

## Stockage : réception avant suppression

Une date enregistrée dans le studio est une programmation **locale**, pas une confirmation du réseau.

Le MP4 est supprimé uniquement lorsque toutes les destinations sont `delivered`. Pour YouTube, on attend `processingStatus=succeeded`. Pour Instagram, on attend l'ID renvoyé par `media_publish`. Pour Facebook, on attend le statut de publication terminé et la vidéo prête. Pour TikTok manuel, l'utilisateur vérifie la réception puis confirme avec le lien ; via Buffer, le serveur attend la publication confirmée et son lien TikTok. La suppression concerne uniquement la copie du studio, jamais le fichier d'origine sur l'ordinateur.

Si un réseau échoue, le MP4 reste présent. Le studio ne relance pas automatiquement les résultats ambigus, pour ne pas créer de doublons. Un arrêt pendant un upload ou une publication passe la destination en « À vérifier ». Vérifier alors le réseau. Si la vidéo a été reçue, coller son lien pour confirmer. Si elle n'a pas été reçue, conserver le fichier et traiter l'incident ; cette version ne propose pas de relance risquée.

Instagram ne constitue pas un stockage durable pour une vidéo programmée plusieurs semaines à l'avance. Le serveur garde donc la copie temporaire jusqu'au créneau et à la confirmation. Il faut dimensionner le stockage pour les vidéos en attente ; zéro stockage dès le clic « Programmer » n'est pas possible pour tous les réseaux.

Quotas configurables : `MAX_UPLOAD_MB=1024`, `MAX_STORAGE_MB=5120`. Les brouillons sont supprimables depuis l'interface ; supprimer un brouillon enlève aussi son MP4. Aucune génération de miniature ni copie d'archive. Les textes et liens occupent peu de place mais restent en base. Les journaux Docker sont limités. Les médias temporaires `data/media/` ne doivent pas être inclus dans les sauvegardes de l'hébergeur : sa rétention et ses snapshots sont indépendants de l'application.

## Couvertures de vidéo

Dans chaque destination du formulaire :
- YouTube : importer une image JPEG/PNG (limite Studigo : 50 Mo). L’image est privée dans DATA_DIR, comptée dans le quota et envoyée par `thumbnails.set` seulement après `processingStatus=succeeded`, y compris pour les Shorts. La chaîne doit avoir le droit d’utiliser des miniatures personnalisées. Un refus ou une réponse ambiguë conserve les fichiers et demande une vérification dans YouTube Studio, sans réimporter la vidéo.
- Instagram et TikTok via Buffer : choisir un instant dans le MP4, en secondes avec aperçu, ou reprendre l’image affichée dans le lecteur. L’instant est transmis en millisecondes (`assets.video.metadata.thumbnailOffset`), y compris zéro. Pas d’import d’image séparée pour ces destinations. En mode TikTok manuel, le choix doit être reproduit dans TikTok.
- Facebook via Buffer : pas de choix de couverture dans cette intégration. Le formulaire indique cette limite et ne propose pas de réglage fictif.

L’image YouTube est supprimée avec le MP4 uniquement après réception par toutes les destinations, ou à la suppression explicite d’un brouillon. Modifier la couverture n’est permis qu’avant le début des envois. Les aperçus d’images extraites sont créés dans le navigateur, sans copie permanente du MP4 et sans dépendance de production supplémentaire.

Références : [miniatures YouTube](https://developers.google.com/youtube/data/reference/rest/v3/thumbnails/set), [couvertures Buffer](https://developers.buffer.com/types/VideoAssetInput.html).

## Réglages par destination et playlists

Le formulaire conserve des valeurs communes comme point de départ et propose un bloc pour chaque réseau sélectionné : titre/première ligne, description/légende et date/heure. Les horaires sont saisis dans le fuseau du navigateur, indiqué dans le formulaire ; la file affiche Paris. Chaque adaptateur reçoit les réglages de sa destination. Le MP4 reste partagé et conservé jusqu’à confirmation de toutes les destinations. Le bouton « Modifier les réglages » est disponible tant qu’aucun envoi de cette publication n’a commencé. Les anciennes publications restent compatibles et utilisent leurs valeurs communes.

L’onglet Réglages mémorise les valeurs habituelles (textes, heure, et options YouTube). Elles préremplissent uniquement les nouvelles publications ; elles ne modifient pas les publications déjà programmées. Instagram et TikTok utilisent une légende combinant première ligne et description, sans titre de vidéo séparé.

YouTube : choisir l’audience, la visibilité (publique, non répertoriée ou privée), les tags et une ou plusieurs playlists. Les vidéos publiques peuvent être envoyées en avance avec `publishAt`. Les vidéos privées et non répertoriées sont envoyées au créneau choisi, avec un délai de traitement possible. La gestion des playlists nécessite une nouvelle autorisation Google (`youtube.force-ssl`) depuis Mes réseaux. On peut charger les playlists de la chaîne et en créer (privées par défaut). Une clé de création enregistrée avant l’appel empêche de relancer automatiquement une création ambiguë. Aucun test ne crée de playlist sur la chaîne réelle.

Après traitement YouTube, le classement dans les playlists est confirmé avant de terminer cette destination. Un résultat de classement ambigu garde le fichier et passe en « À vérifier » sans réimporter la vidéo. Vérifier le classement dans YouTube Studio puis confirmer la réception avec le lien. Références : [création de playlists](https://developers.google.com/youtube/v3/docs/playlists/insert), [classement des vidéos](https://developers.google.com/youtube/v3/docs/playlistItems/insert).

## Connecter les comptes

### YouTube

La reconnexion affiche le sélecteur de compte Google puis demande une confirmation du nom et de l’identifiant de chaîne dans Mes réseaux. Les jetons restent en attente pendant 10 minutes, sans envoi YouTube, jusqu’à cette confirmation. Le bouton Déconnecter YouTube supprime la connexion locale et les playlists en cache. Les autres réseaux continuent de fonctionner. Les nouvelles destinations YouTube sont liées à l’identifiant de chaîne confirmé ; changer de chaîne ne réaffecte pas silencieusement les publications existantes.

Créer un projet Google Cloud, activer YouTube Data API v3 et configurer l'écran de consentement OAuth ainsi qu'un client Web. Ajouter exactement `APP_URL/auth/youtube/callback` aux URI autorisées. Renseigner GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans `.env`, redémarrer, puis « Mes réseaux → Connecter ma chaîne ». Vérifier les exigences Google de consentement, quotas et durée de vie des jetons en mode test. L'option « Conçu pour les enfants » est demandée à chaque publication.

### TikTok via Buffer (optionnel)

Connecter TikTok dans Buffer, puis créer une clé dans Settings → API. Configurer `BUFFER_API_KEY` et `BUFFER_TIKTOK_CHANNEL_ID` sur le serveur. La clé reste privée. Le lancement centralisé choisit Buffer pour un envoi compatible, ou le navigateur vérifié pour une couverture importée ou des options avancées. Indiquer si le contenu est généré par IA. Les publications manuelles déjà enregistrées conservent leur état jusqu’à une modification explicite.

Au créneau choisi, Studigo transmet une URL MP4 signée valable 24 heures à Buffer. Une acceptation par Buffer ne confirme pas la réception sur TikTok : le fichier reste présent jusqu'au statut `sent`, au mode `automatic` et à un lien vidéo TikTok confirmé pour le bon compte. Les vérifications sont espacées pour limiter la consommation du quota API. Une erreur, un résultat ambigu ou une attente de plus de 24 heures conserve le fichier et demande une vérification manuelle ; aucune nouvelle création n'est tentée automatiquement. Une lecture de statut temporairement indisponible peut être retentée, sans réenvoyer la vidéo. Après réception par toutes les destinations, seule la copie du studio est supprimée ; Buffer applique sa propre rétention. Les musiques natives TikTok nécessitent le mode manuel.

Références : [API Buffer](https://developers.buffer.com/), [statuts de publication](https://developers.buffer.com/guides/posts-and-scheduling.html).

### Facebook et Instagram via Buffer (option recommandée)

Connecter une Page Facebook et un compte Instagram professionnel dans Buffer. Les variables `BUFFER_FACEBOOK_CHANNEL_ID` et `BUFFER_INSTAGRAM_CHANNEL_ID`, avec la clé `BUFFER_API_KEY` existante, activent les envois de Reels via Buffer sans application Meta propre à Studigo. Un compte Instagram personnel ne permet pas la publication automatique. La connexion Instagram directe dans Buffer ne nécessite pas de Page Facebook liée pour les Reels simples.

Les nouvelles destinations Facebook/Instagram enregistrent le prestataire et le compte Buffer choisis. Les destinations anciennes conservent leur parcours Meta et ne sont pas réenvoyées ni migrées automatiquement. Comme pour TikTok, Studigo attend le créneau de chaque destination puis demande une publication immédiate de Reel. Il attend un statut `sent`, le bon compte/réseau, le mode `automatic` et un lien de publication cohérent avant de confirmer la réception. Une notification manuelle Buffer ne vaut jamais réception. Les résultats ambigus conservent le MP4 et ne sont pas relancés ; aucun repli automatique vers Meta.

L’offre gratuite Buffer permet 3 comptes : TikTok, Facebook et Instagram. YouTube peut rester connecté directement à Studigo. Les médias sont conservés localement jusqu’aux créneaux respectifs, sans remplir à l’avance les files Buffer. Les quotas API et réseau restent applicables et Buffer conserve sa propre copie suivant ses conditions.

### Meta

Créer/configurer une application Meta avec les droits de publication nécessaires. Pour le parcours Facebook Login retenu, prévoir notamment `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`, sous réserve des accès accordés à ton application.

Obtenir un jeton de Page approprié et renseigner `META_PAGE_TOKEN`, `META_PAGE_ID`, `INSTAGRAM_USER_ID`. Utiliser une Page Facebook liée au compte professionnel Instagram. Le jeton reste sur le serveur. Choisir la version Graph supportée par l'application via META_GRAPH_VERSION ; le défaut de ce projet est v24.0. La configuration présente ne garantit pas que le jeton est valide : la vérification complète requiert un essai réel sur chaque compte.

Références : [YouTube upload](https://developers.google.com/youtube/data/guides/using_resumable_upload_protocol), [ressource YouTube videos](https://developers.google.com/youtube/data/docs/reference/videos), [collection officielle Meta Instagram](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api), [collection officielle Meta Facebook](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api).

## Héberger sur un sous-domaine

### Préparation commune et agent navigateur

Le formulaire propose une seule vidéo, un titre, une description, une date et une couverture JPEG/PNG communs. Les onglets par réseau permettent de personnaliser ces valeurs, les playlists YouTube/Facebook et les options TikTok disponibles. Les couvertures propres à un réseau remplacent la couverture commune. L’ancien champ de couverture reste compatible pour YouTube uniquement.

« Enregistrer le brouillon » n’envoie rien. « Programmer partout » enregistre la préparation, contrôle chaque destination, puis programme uniquement si toutes les options sélectionnées sont prises en charge. Un blocage garde le brouillon et ne démarre aucun réseau. L’API serveur refait le même contrôle au lancement. Une image importée n’est jamais ignorée ou remplacée par un instant vidéo ; les deux choix simultanés sont refusés.

Le serveur traite les API. Les travaux navigateur sont réservés par l’agent local de l’application, qui utilise les interfaces officielles. Les comptes, leurs capacités et l’horizon d’envoi doivent d’abord être vérifiés dans ces interfaces. Les dates plus lointaines restent dans Studigo jusqu’à l’ouverture de cet horizon. Voir [la procédure de l’agent](deploy/browser-agent.md) pour le transport privé, les réservations, la vérification des preuves et la configuration récurrente. Le dépôt n’active pas lui-même une tâche programmée.

Les états navigateur distinguent attente, préparation, validation finale, programmation distante et livraison. Une réservation expirée devient « à vérifier » ; elle n’est pas rejouée et ne bascule jamais vers Buffer. Les fichiers restent jusqu’à livraison confirmée de toutes les destinations. La préparation et la programmation des comptes natifs ont besoin d’une machine connectée avec l’application disponible. Les limites d’usage de l’agent et les contrôles de connexion des réseaux restent applicables.

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
