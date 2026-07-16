---
title: Architecture des refresh dynamiques wishlist, tradables et cache MV3
date: "2026-07-16"
module: popup/deals, popup/tradables, popup/tradables-detailed, background/service-worker
category: architecture
problem_type: implementation_reference
tags:
  - chrome-mv3
  - wishlist
  - ggdeals
  - steam
  - cache
  - rate-limiting
  - popup
  - service-worker
---

# Architecture des refresh dynamiques wishlist, tradables et cache MV3

## Objectif

Cette note documente l'architecture construite pour rendre les flux Wishlist, Tradables et Clear cache robustes dans une extension Chrome MV3.

Les problèmes résolus étaient principalement :

- les réponses async obsolètes qui réécrivaient l'UI ou le stockage après un clear cache ;
- les anciens caches wishlist qui réapparaissaient pendant un refresh incomplet ;
- les chargements wishlist qui perdaient l'état progressif à la fermeture/réouverture du popup ;
- les prix GG.deals qui n'étaient appliqués qu'en fin de chargement ;
- les 429 GG.deals affichés comme de simples prix indisponibles ;
- les mutations Tradables qui pouvaient perdre des quantités ou laisser des vues stale ;
- les recherches Steam concurrentes ou obsolètes qui pouvaient afficher de mauvais résultats.

Le principe général est simple : les données durables restent dans `chrome.storage.local`, mais les opérations vivantes du service worker et du popup sont coordonnées par des epochs, des tokens et des guards de séquence.

## Vue d'ensemble des responsabilités

### Background service worker

Le service worker reste la couche d'autorité pour :

- les messages Chrome runtime ;
- les accès à `chrome.storage.local` ;
- les appels Steam ;
- les appels GG.deals ;
- les écritures de cache ;
- les broadcasts vers popup/content scripts.

Comme MV3 peut hiberner le service worker, son état mémoire n'est utilisé que pour coordonner les opérations actuellement vivantes. Toute donnée durable doit être persistée.

Les mécanismes importants sont :

- une barrière de cycle de vie autour de `CLEAR_CACHE` ;
- un verrou d'écriture stockage unique ;
- des refresh tokens pour les caches wishlist ;
- des messages de progression wishlist ;
- des broadcasts d'événements : `CACHE_CLEARED`, `TRADABLES_UPDATED`, `GGDEALS_RATE_LIMITED`.

### Popup Wishlist

`popup/deals.js` est responsable de l'expérience utilisateur wishlist :

- affichage immédiat du cache complet quand il est autoritaire ;
- affichage progressif pendant un refresh Steam/GG.deals ;
- persistance des cartes partielles non autoritaires ;
- commit final du nouveau cache complet ;
- distinction entre `Refresh prices` et `Reload wishlist`.

La wishlist ne doit jamais repasser à un écran vide si des cartes sont déjà connues pour le refresh courant.

### Popup Tradables

`popup/tradables.js` et `popup/tradables-detailed.js` partagent une logique de cohérence :

- les mutations Tradables sont sauvegardées immédiatement ;
- une seule mutation visible est autorisée à la fois ;
- le service worker broadcast `TRADABLES_UPDATED` après chaque écriture ;
- `Tradables detailed` se précharge et se met à jour sans attendre que l'utilisateur clique sur l'onglet.

## Clear cache et barrière de cycle de vie

`CLEAR_CACHE` est traité comme une opération de cycle de vie globale.

Le service worker :

1. ferme l'admission de nouvelles opérations ;
2. incrémente un epoch ;
3. invalide les profils coalescés ;
4. annule les recherches Steam en cours ;
5. reset le scheduler Steam ;
6. attend le drain des opérations déjà admises ;
7. vide le stockage non préservé ;
8. rouvre l'admission ;
9. broadcast `CACHE_CLEARED`.

Les messages reçus pendant une purge attendent la fin de la purge et deviennent du nouveau travail post-purge.

Les clés utilisateur à préserver incluent notamment :

- settings ;
- clé API ;
- Steam ID ;
- Tradables ;
- snapshots Tradables ;
- acquisitions ;
- options de refresh.

Le cache wishlist complet et les caches de prix/résolution ne sont pas préservés par `CLEAR_CACHE`.

## Cache wishlist transactionnel

Le cache historique s'appelle encore `deals_cards_cache`. Il représente désormais le cache wishlist complet ou un marker de refresh incomplet.

Deux messages structurent la transaction :

- `BEGIN_DEALS_REFRESH`
- `COMMIT_DEALS_REFRESH`

Un marker incomplet contient :

- `profileComplete: false`
- `cacheIdentity`
- `refreshToken`
- `startedAt`
- éventuellement `previousComplete`
- éventuellement `partialCards`
- éventuellement `partialSavedAt`

Un cache complet contient :

- `profileComplete: true`
- `cacheIdentity`
- `cards`
- `savedAt`
- `failedAppIds`

Règles :

- seul `COMMIT_DEALS_REFRESH` écrit un cache complet autoritaire ;
- `UPDATE_DEALS_REFRESH_PROGRESS` ne stocke que des cartes partielles non autoritaires ;
- un commit vérifie `cacheIdentity` et `refreshToken` ;
- un ancien refresh ne peut pas remplacer un refresh plus récent ;
- un profil incomplet ne doit jamais produire un cache complet.

À terme, `deals_cards_cache` devra être renommé vers `wishlist_cards_cache`, mais ce renommage est volontairement séparé pour éviter de mélanger migration de nom et correction de concurrence.

## Rendu progressif Wishlist

La wishlist suit un run actif côté popup.

Ce run contient notamment :

- `sequence`
- `requestId`
- `generation`
- `cacheIdentity`
- `refreshToken`
- `phase`
- `cancelled`
- `settings`
- `sortMode`
- `progressCardsByTitle`
- `progressCardsByAppId`
- `progressPriceKeys`

Les phases principales sont :

- `steam-loading`
- `resolving`
- `pricing`
- `complete`

Le run reste vivant pendant toute la chaîne Steam -> résolution -> prix -> commit. Il n'est pas détruit juste après `GET_PROFILE`.

Cela garantit que :

- changer d'onglet ne fait pas perdre les cartes déjà reçues ;
- fermer/réouvrir le popup pendant un chargement peut réhydrater les cartes partielles ;
- la phase `resolving` ne revient pas à `Loading wishlist...` ;
- les liens Steam et GG.deals apparaissent dès que les données nécessaires existent ;
- les prix GG.deals sont appliqués chunk par chunk.

## Différence entre Refresh prices et Reload wishlist

Les deux boutons ont des responsabilités différentes.

### Refresh prices

`Refresh prices` est un refresh léger :

- ne recharge pas Steam ;
- ne reconstruit pas la wishlist ;
- utilise la liste actuellement affichée ;
- appelle GG.deals pour les prix selon la logique de cache/stale ;
- ne démarre pas de nouveau cache wishlist transactionnel.

### Reload wishlist

`Reload wishlist` est un force rebuild complet :

- ignore le cache wishlist Steam ;
- ignore les partial cards existantes ;
- appelle `GET_PROFILE` avec `forceRefresh: true` ;
- ignore `GET_CACHED_RESOLUTIONS` ;
- appelle `RESOLVE_TITLES` pour toute la wishlist ;
- ignore `GET_CACHED_PRICES` ;
- appelle `REFRESH_PRICES` pour tous les App IDs résolus ;
- persiste les cartes partielles pendant le chargement ;
- commit le nouveau cache complet à la fin.

Le résultat complet de `Reload wishlist` devient la nouvelle et dernière liste autoritaire sauvegardée.

## GG.deals, rate limiting et progression des prix

Steam wishlist et GG.deals sont deux APIs distinctes avec deux limites distinctes.

Le flux correct est :

1. Steam renvoie un lot de jeux ;
2. le popup affiche les cartes immédiatement ;
3. les titres sont résolus en App IDs ;
4. GG.deals est appelé pour les jeux résolus ;
5. les prix sont appliqués dès réception ;
6. les cartes partielles sont persistées ;
7. le commit final remplace le cache complet.

Les appels GG.deals restent soumis au rate limiter. En cas de 429 ou d'attente locale connue, le service worker broadcast :

- `GGDEALS_RATE_LIMITED`

Le popup marque alors les cartes concernées avec :

- `priceStatus: { type: "rate-limited", resetAt }`

Le rendu affiche :

- `GG.deals API limit reached — resets at HH:MM`

ou, si l'heure est inconnue :

- `GG.deals API limit reached — retrying shortly`

Ce message remplace `Price unavailable` uniquement quand la cause est réellement une limite API. Quand un prix arrive plus tard, `priceStatus` est supprimé.

## Tradables et Tradables detailed

Les Tradables sont désormais traités comme une donnée durable sensible.

Principes :

- `SAVE_TRADABLES` écrit immédiatement via le service worker ;
- les quantités ne sont plus sauvegardées via debounce fragile ;
- une mutation visible désactive les contrôles jusqu'à confirmation ;
- en cas d'échec, l'UI restaure la dernière liste confirmée ;
- après sauvegarde, le service worker broadcast `TRADABLES_UPDATED`.

`Tradables detailed` :

- ne doit pas recharger inutilement à chaque clic d'onglet ;
- précharge en arrière-plan quand les Tradables changent ;
- affiche dynamiquement les résultats si l'utilisateur ouvre l'onglet pendant un chargement ;
- affiche un état vide direct quand la liste Tradables est vide ;
- utilise un lien vers l'onglet Tradables pour guider l'utilisateur.

## Recherches Steam annulables

Les recherches Steam utilisent un contrat avec `requestId`.

Messages :

- `SEARCH_STEAM { query, requestId }`
- `CANCEL_STEAM_SEARCH { requestId }`

Le service worker coalesce les recherches identiques tout en gardant des abonnés séparés.

Règles :

- une frappe invalide immédiatement la recherche précédente ;
- une annulation ne coupe le réseau que si le dernier abonné disparaît ;
- une réponse annulée ou obsolète est ignorée ;
- `CLEAR_CACHE` annule toutes les recherches en cours ;
- les interfaces vérifient toujours que le champ, le compteur local et le conteneur DOM sont encore valides après chaque `await`.

## Lecture stricte des Tradables pour les profils

La lecture Tradables utilisée par `GET_PROFILE` distingue :

- clé absente ;
- liste valide ;
- donnée malformée ;
- erreur de stockage.

En cas d'erreur de lecture storage :

- `GET_PROFILE` retourne `storageError: true` ;
- aucun profil vide valide n'est produit ;
- le content script n'enrichit pas la page avec une classification trompeuse ;
- les vues popup affichent l'erreur réelle.

Cela évite de reclasser des jeux comme non-tradables à cause d'une erreur storage temporaire.

## Invariants importants

- Un ancien refresh ne peut jamais écraser un refresh plus récent.
- Un cache incomplet n'est jamais autoritaire.
- Un clear cache annule les écritures et rendus tardifs.
- Un profil incomplet ne produit pas de cache wishlist complet.
- `Refresh prices` ne recharge jamais Steam.
- `Reload wishlist` force Steam + résolution + GG.deals sans utiliser les caches secondaires.
- Les prix déjà reçus restent visibles pendant les attentes GG.deals.
- Les messages 429 sont affichés explicitement à l'utilisateur.
- Toute donnée durable doit survivre à l'hibernation MV3 via `chrome.storage.local`.

## Tests de référence

Les tests couvrent notamment :

- purge cache concurrente ;
- stale refresh tokens ;
- cache incomplet non autoritaire ;
- rendu progressif wishlist ;
- tab switch pendant chargement ;
- fermeture/réouverture pendant refresh ;
- persistance des partial cards ;
- 429 GG.deals visible dans l'UI ;
- force reload wishlist sans caches résolutions/prix ;
- mutations Tradables immédiates ;
- broadcasts `TRADABLES_UPDATED` ;
- recherches Steam annulables ;
- builds Chrome/Firefox ;
- scénario Playwright de régression quand Chromium peut démarrer.

## Points à surveiller

- Le nom `deals_cards_cache` est historique et devra être migré vers `wishlist_cards_cache`.
- Le mot `deals` reste présent dans plusieurs fonctions popup ; un futur refactor devra renommer ces symboles vers `wishlist`.
- Les caches de résolution et de prix sont utiles pour les refresh normaux, mais ne doivent pas être utilisés par `Reload wishlist`.
- Le rate limiter GG.deals ne doit jamais être contourné ; l'UI doit expliquer les attentes au lieu de masquer l'état.
