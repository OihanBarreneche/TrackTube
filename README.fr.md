# TrackTube

[English](README.md) · **Français**

**Tes abonnements YouTube, dans l'ordre, sans Shorts.**

TrackTube remplace la page Abonnements de YouTube par la liste chronologique
complète de ce qu'ont publié les chaînes que tu suis. Pas de classement, pas de
recommandations, pas de carrousel de Shorts au milieu de la liste. Tout reste
dans ton navigateur.

![Le feed, dans YouTube](screenshots/feed.jpg)

---

## Pourquoi

La page Abonnements de YouTube a cessé d'être une liste. Elle ouvre sur un bloc
« Pour vous », une rangée de directs, et les carrousels de Shorts reviennent
entre les lignes. Ce à quoi tu t'es abonné est là dedans quelque part, dans un
ordre que personne ne sait expliquer, et une vidéo qui n'est jamais arrivée sur
la page ne se distingue pas d'une vidéo qui n'a jamais été publiée.

TrackTube reconstruit cette liste depuis le flux public de chaque chaîne, une
chaîne après l'autre, et l'affiche à la place de celle de YouTube. Rien n'est
filtré sans que tu l'aies demandé.

## Ce que tu obtiens

### Un feed qui se vide

Masque une vidéo et elle s'en va pour de bon. Contrairement au « Ça ne
m'intéresse pas » de YouTube, une vidéo masquée ici n'est jamais chargée, jamais
lue, jamais dessinée : en masquer des milliers ne coûte rien. Mets une étoile
sur celles que tu comptes regarder, elles ont leur propre vue. Lance une vidéo,
reviens le lendemain, elle est toujours dans **En cours** avec la barre de
progression là où tu l'avais laissée.

Survoler une vignette lance la vidéo sur place, muette, avec un bouton de son si
tu en veux. La recherche couvre tous les titres et toutes les chaînes que
l'extension connaît, sans passer par la recherche de YouTube.

### Une analyse de ce que tu regardes vraiment

![L'analyse de l'historique](screenshots/history.png)

Le temps passé, les chaînes que tu ne manques jamais, le délai que tu mets avant
d'ouvrir une vidéo, l'endroit où tu décroches, les sujets qui reviennent dans
les titres, le moment de la journée où tu regardes. L'extension mesure ce que tu
regardes à partir du moment où tu l'actives, et un export Google Takeout comble
les années d'avant.

Chaque chiffre dit sur quoi il repose. Un total calculé sur 590 visionnages datés
sur 876 le dit à l'écran ; un chiffre qui ne serait qu'une supposition affiche un
tiret à la place. Trois petits jeux sont construits sur les mêmes données : une
rétrospective de l'année, un duel et un tournoi à élimination entre tes propres
chaînes.

### Un tri des abonnements, carte par carte

![Le tri des abonnements](screenshots/triage.jpg)

Une liste d'abonnements grossit pendant des années. Celle ci se parcourt une
chaîne à la fois, avec ses dernières vidéos, la fréquence à laquelle elle
publie, la date de sa dernière publication et la part que tu en as réellement
regardée. À droite pour garder, à gauche pour se désabonner. Les chaînes qui ont
cessé de publier passent en premier.

Se désabonner désabonne pour de vrai, alors une décision ne part que cinq cartes
plus tard : assez loin pour changer d'avis, assez près pour que rien n'attende
la fin.

### Une popup qui dit où en sont les choses

<img src="screenshots/popup.png" alt="La popup" width="400">

Ce qui est arrivé dans le dernier jour, la dernière semaine et le dernier mois,
ce qui est en priorité, ce qui est en cours, combien est masqué, et quand la
dernière collecte a tourné.

## Installation

Pas d'étape de compilation, pas de bundler, aucune dépendance à installer. Le
dossier est l'extension.

1. Télécharge ou clone ce dépôt.
2. Ouvre `chrome://extensions` et active le **mode développeur**.
3. Clique sur **Charger l'extension non empaquetée** et choisis le dossier.
4. La page de bienvenue s'ouvre. Importe tes abonnements depuis celle ci, dans un
   onglet où tu es déjà connecté à YouTube.

Chrome 111 ou plus récent, Manifest V3. Fonctionne aussi sur les navigateurs
basés sur Chromium comme Edge, Brave et Opera GX.

**Laisse le dossier où il est.** Pour une extension non empaquetée, Chrome
dérive l'identifiant de l'extension du chemin absolu du dossier, et la base de
données est rangée sous cet identifiant. Renommer ou déplacer le dossier donne un
autre identifiant et une base vide. Exporte une sauvegarde depuis la popup avant
de déplacer quoi que ce soit.

## Tes données

Rien ne quitte ton navigateur. Il n'y a pas de serveur, pas de compte, pas de
télémétrie, et aucune analyse d'usage d'aucune sorte.

- Tes abonnements, les vidéos collectées, ce que tu as masqué, ce que tu as mis
  en priorité et ce que tu as regardé vivent dans l'IndexedDB de ce navigateur.
- L'extension demande à YouTube les flux publics dont elle a besoin, et se sert
  de la session YouTube déjà ouverte dans ton onglet pour ce qui l'exige : lire
  ta liste d'abonnements, et se désabonner quand tu le demandes.
- Elle ne demande jamais de mot de passe ni de clé d'API, et ne détient aucun
  identifiant.
- La sauvegarde est un fichier que tu gardes.

Permissions demandées : `storage`, `unlimitedStorage`, `alarms`, et l'accès à
`https://www.youtube.com/*`. Rien d'autre. Voir la
[notice de confidentialité](privacy.html), accessible aussi depuis le panneau
d'aide de la popup.

Le relevé de ce que tu regardes est **désactivé jusqu'à ce que tu l'actives**. Le
désactiver ensuite n'efface pas ce qui a déjà été enregistré ; la page
d'analyse a un bouton pour cela.

Un seul compte YouTube par profil de navigateur. La base se rattache au premier
compte qu'elle voit et refuse les écritures venues d'un autre, pour que deux
comptes ne se retrouvent pas mêlés dans les mêmes index. Utilise un profil de
navigateur distinct pour un second compte.

## Ce qui n'est pas promis

- **Un Short peut apparaître brièvement.** Les Shorts sont exclus à l'aide des
  listes de YouTube elles mêmes et des métadonnées du lecteur, et une exclusion
  confirmée est définitive. Mais une vidéo publiée il y a quelques minutes peut
  n'être pas encore classée, et une requête qui échoue n'exclut rien plutôt que
  de deviner. Rien n'est jamais classé d'après sa durée.
- **La collecte automatique est superficielle.** Elle lit le flux récent de
  chaque chaîne, à intervalle régulier. Le bouton **Rafraîchir** va plus loin :
  il parcourt les onglets Vidéos et En direct de chaque chaîne active sur les
  sept derniers jours, et signale une couverture partielle quand quelque chose
  l'a arrêté.
- **Le diagnostic inverse est une comparaison, pas un certificat.** Il dit ce
  que la page de YouTube a montré et que la base ne contient pas. Il ne peut pas
  prouver que l'un des deux côtés est complet.
- **Les aperçus au survol s'arrêtent vers une minute.** C'est la limite de
  YouTube, pas la nôtre, et c'est une durée et non un poids : aucun format plus
  léger ne la contourne. Le rail ombre dès la première image la part qu'il ne
  peut pas atteindre.

Les [limites connues](docs/LIMITES.md) entrent dans le détail.

## Développement

Des modules ES ordinaires, chargés par le navigateur. Pas de compilation, pas de
bundler, pas de TypeScript, pas de `node_modules`. Lis d'abord
[CONTRIBUTING.md](CONTRIBUTING.md), puis [CLAUDE.md](CLAUDE.md) pour savoir
pourquoi le code a cette forme : il consigne les décisions prises après un bug,
c'est à dire la part que la lecture des fichiers ne donne pas.

Lis et écris toujours les fichiers source en UTF-8 explicite.

### Lancer les vérifications

Les suites sont des pages HTML que tu ouvres dans un navigateur. Sers le
dossier :

```bash
python tools/serve-ranges.py 8731
```

Ouvre ensuite `test/index.html` pour la suite de régression,
`test/modules.html` pour vérifier que chaque module s'importe encore, et
`test/coverage.html` pour les chemins de collecte. **Un port différent par
page** : les bancs partagent une IndexedDB avec tout ce qui est servi depuis la
même origine, et `?cb=N` ne vide pas le cache des modules ES.

Avec Node et Playwright, les mêmes bancs tournent sans fenêtre :

```bash
node tools/test.mjs
```

Renseigne `TRACKTUBE_PLAYWRIGHT_PATH` et `TRACKTUBE_BROWSER_PATH` s'ils viennent
d'en dehors du projet. `node tools/diagnose-videos.mjs ID_VIDEO` inspecte les
métadonnées publiques d'une vidéo sans cookies.

`python tools/shoot.py` reconstruit les captures de ce README en pilotant un
Chrome sans fenêtre sur les bancs. Il a besoin du réseau la première fois : les
captures du feed et du tri utilisent de vraies vidéos lues dans les flux publics
de YouTube, et il met les avatars des chaînes en cache localement pour qu'une
capture ne leur course pas après.

Construis un candidat de distribution avec `python tools/package.py`. L'archive
ne contient que les fichiers d'exécution.

## Licence

[MIT](LICENSE) © Oihan Barreneche
