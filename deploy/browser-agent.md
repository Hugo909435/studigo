# Traitement navigateur Studigo

Cette procédure est destinée à l’agent disposant des outils navigateur de l’application. Le script est uniquement le transport privé vers Studigo : il ne lance pas un navigateur, ne publie pas seul et ne constitue pas un service permanent.

Sous Windows, définir la variable de processus DATA_DIR sur `C:\Users\hbeignon\Desktop\studigo\data\browser-agent` avant les commandes de transport. Ne pas changer le DATA_DIR Linux enregistré dans .env pour l’hébergement. APP_URL reste le site HTTPS. Tous les médias, manifestes, captures et fichiers de travail locaux doivent rester dans ce DATA_DIR privé, ignoré par Git.

## Préparation des comptes

Ouvrir TikTok Studio et Meta Business Suite avec les outils navigateur approuvés. Faire connecter le propriétaire dans ces sessions, distinctes de Buffer. Ne jamais copier les cookies ni demander les mots de passe dans le chat. Vérifier l’identité exacte de la Page/profil de destination avant chaque traitement.

Vérifier dans l’interface, avec un brouillon identifié comme essai, les options réellement proposées : programmation, limites de dates, import d’image de couverture, image de la vidéo, playlists Facebook et mention IA TikTok. Ne pas publier l’essai. Une documentation générique ou une option mobile ne suffit pas à déclarer une option disponible sur ce compte web.

Enregistrer seulement les options constatées via `node scripts/browser-agent.mjs account <fichier-json>` avec `network`, `id`, `name`, `features` (schedule, customCover, videoFrame, playlist, aiLabel), `maxAdvanceDays`, `minAdvanceMinutes` et `evidence` décrivant la vérification. Les JSON et captures sont dans DATA_DIR uniquement. Une capacité non vérifiée reste fausse.

## Une passe de la file

1. Exécuter `node scripts/browser-agent.mjs jobs`. Cela renouvelle le signal de présence et retourne les seuls travaux approuvés, dans l’horizon natif de programmation, ainsi que les publications distantes à vérifier après leur échéance. Rien ne signifie que le réseau a déjà reçu le fichier.
2. Pour un travail `agent_queued`, appeler `claim` avec un fichier JSON contenant `postId` et `network`. Garder le jeton retourné privé. Le travail est réservé pendant 30 minutes ; aucune autre passe ne peut le reprendre.
3. Appeler `download` avec `postId`, `network`, `token`. Les fichiers locaux vont dans DATA_DIR/browser-cache. Utiliser les outils navigateur officiels et leur procédure de téléversement pour ces fichiers ; ne pas utiliser de client de protocole navigateur alternatif ni d’API sociale privée.
4. Vérifier le bon compte, importer le MP4, appliquer le texte (titre puis deux retours à la ligne puis description pour une légende), la couverture exacte, la playlist et les options demandées, y compris les valeurs false. Vérifier le fuseau horaire et l’heure exacte. Ne jamais ignorer une option ou lui substituer une autre. Si elle manque, appeler `result` avec `action: attention`, le jeton et un message compréhensible. Ne pas publier. Dans Meta, ne sélectionner qu’un réseau par travail : les deux destinations ont des textes, couvertures et créneaux indépendants. Si le travail Facebook ne demande pas une story, désactiver le partage automatique en story afin de ne pas ajouter une diffusion imprévue.
5. Avant le clic final, appeler `result` avec `action: begin`, `postId`, `network`, `token`. Ne cliquer qu’une seule fois. En cas de timeout, de perte de connexion ou de doute sur la réception : `attention`, aucune nouvelle tentative automatique.
6. Après confirmation visible, appeler `result` avec `action: finish`, `outcome: scheduled`, `postId`, `network`, `token`, `accountId`, `remoteId`, `url`, `scheduledAt` identique au plan, `evidence` et `verified` contenant chaque capacité demandée à true. Conserver une capture dans DATA_DIR. Un simple écran de préparation ne constitue pas une confirmation.
7. Pour un travail `remote_scheduled`, faire une lecture du réseau : ne pas téléverser ni programmer à nouveau. Vérifier la publication d’origine à l’heure attendue. Appeler `result` avec `action: check`, `outcome: delivered` et les mêmes preuves/identifiants seulement après constat de la publication. Une publication programmée n’est jamais delivered.

Le moteur du serveur ignore les travaux navigateur. Aucun repli automatique vers Buffer n’est autorisé pour une couverture ou une playlist manquante. Les MP4 et couvertures du serveur restent jusqu’à confirmation de toutes les destinations. Pour le cache local, supprimer uniquement les fichiers du travail dont toutes les destinations sont delivered, à l’intérieur du DATA_DIR vérifié ; ne pas supprimer un média encore nécessaire. Ne jamais lancer deux agents sur la même file sans réservation.

## Exécution récurrente

À configurer avec l’outil de tâches programmées de l’application après vérification des comptes et du téléversement. La machine et l’application doivent rester disponibles pendant le traitement. La procédure seule n’active aucune tâche récurrente. Ne pas annoncer de publication autonome avant un essai complet et vérifié.
