# WLED

Pilotez vos rubans LED [WLED](https://kno.wled.ge) depuis Gladys, sur votre
réseau local : couleur, luminosité, effets, palettes, presets et segments, mis
à jour en temps réel.

> **Développée sans le matériel : retours bienvenus.** Cette intégration a été
> construite et testée sur de vraies réponses de contrôleurs WLED, pas sur des
> rubans physiques. Si quelque chose ne fonctionne pas comme décrit, dites-le
> sur le [forum Gladys](https://community.gladysassistant.com) ou dans les
> [issues](https://github.com/guim31/gladys-wled/issues).

## Ce qu'il vous faut

- Gladys Assistant 5.1.0 ou plus récent.
- Un contrôleur WLED (ESP8266 ou ESP32) connecté au **même réseau** que
  Gladys. WLED 0.14 ou plus récent est conseillé ; 0.13 devrait fonctionner.

## Ajouter vos contrôleurs

1. Installez l'intégration depuis le catalogue Gladys. L'écran d'installation
   demande à laisser Gladys chercher les contrôleurs WLED sur le réseau (mDNS,
   `_wled._tcp`) : acceptez.
2. Ouvrez l'onglet **Découverte** : chaque contrôleur trouvé y figure, avec le
   nom réglé dans WLED. Cliquez sur **Ajouter**, choisissez une pièce,
   enregistrez.
3. Il manque un contrôleur ? Trouvez son adresse IP dans l'application WLED
   (_Config_ → _WiFi Setup_) ou dans votre box, saisissez-la dans
   **Configuration** → _Adresses IP des contrôleurs_ (plusieurs adresses
   séparées par des virgules), enregistrez, puis rouvrez **Découverte**.

Conseil : donnez à chaque contrôleur une adresse IP fixe dans votre box
(réservation DHCP). L'intégration reconnaît un contrôleur à son adresse MAC et
le suit quand son adresse change, mais une adresse fixe se retrouve plus vite.

## Ce que propose chaque appareil

Chaque contrôleur est un appareil :

| Fonctionnalité         | Ce qu'elle fait                                                              |
| ---------------------- | ---------------------------------------------------------------------------- |
| Éclairage              | Marche / arrêt                                                               |
| Luminosité             | De 0 à 100 % (0 éteint le ruban)                                             |
| Couleur                | La couleur du ruban (rubans RGB)                                             |
| Température de couleur | Du blanc chaud (2000 K) au blanc froid (6535 K), sur les rubans à blancs CCT |
| Canal blanc            | Les LED blanches des rubans RGBW, de 0 à 100                                 |
| Effet                  | La liste des effets de votre contrôleur (Solid, Rainbow, Fire 2012…)         |
| Palette                | La palette de couleurs utilisée par l'effet                                  |
| Vitesse de l'effet     | De 0 à 100                                                                   |
| Intensité de l'effet   | De 0 à 100                                                                   |
| Preset                 | Vos presets et playlists WLED ; « Aucun » dès que l'état a changé            |
| Veilleuse              | Lance la veilleuse WLED (durée et mode réglés dans WLED)                     |
| Synchro UDP            | Envoie les changements aux autres contrôleurs WLED synchronisés              |

Seul ce que votre ruban sait faire est proposé : pas de température de couleur
sur un simple ruban RGB, pas de canal blanc sans LED blanches.

Les listes d'effets, de palettes et de presets sont lues sur le contrôleur. Un
preset enregistré dans WLED apparaît tout seul dans la liste, en quelques
secondes.

### Segments

WLED peut découper un ruban en **segments**. Par défaut, l'appareil du
contrôleur pilote les segments **sélectionnés** dans WLED, exactement comme
l'interface de WLED ; sur un ruban à un seul segment, c'est tout le ruban.

Pour piloter chaque segment séparément, choisissez **Aussi un appareil par
segment** dans **Configuration** → _Segments_, enregistrez, puis ajoutez les
nouveaux appareils depuis **Découverte**. Ils sont proposés pour les
contrôleurs qui ont au moins deux segments, et portent les noms des segments
réglés dans WLED. Un appareil de segment a son propre éclairage, sa luminosité,
sa couleur, son effet, sa palette, sa vitesse et son intensité ; allumer un
segment allume aussi le contrôleur. Les presets, la veilleuse et la synchro
restent sur l'appareil du contrôleur.

Les noms des fonctionnalités sont donnés à l'ajout d'un appareil, dans la
langue choisie dans **Configuration** → _Langue des noms de fonctionnalités_.

## Temps réel

Chaque contrôleur signale à Gladys chaque changement dès qu'il a lieu, quelle
qu'en soit l'origine : l'application WLED, un bouton physique, une
planification, une télécommande infrarouge, ou un autre contrôleur synchronisé.
Si la connexion tombe, l'intégration demande son état au contrôleur toutes les
30 secondes pendant qu'elle se reconnecte.

Le badge de chaque appareil indique **local** quand le contrôleur répond, et
**injoignable** quand il ne répond pas (débranché, Wi-Fi perdu). Une commande
envoyée à un contrôleur injoignable échoue avec un message.

## Scènes

L'intégration ajoute ses propres cartes à l'éditeur de scènes, dans la
catégorie **Intégrations** :

- **Appliquer un preset WLED** (action) : applique un preset ou lance une
  playlist, désigné par son **nom** (tel qu'écrit dans WLED, majuscules
  indifférentes) ou son **numéro**. Les actions suivantes peuvent lire le
  numéro et le nom du preset.
- **Lancer un effet WLED** (action) : allume la lumière et lance un effet,
  désigné par son nom (par exemple `Rainbow`) ou son numéro, avec une palette
  (par exemple `Party`), une vitesse et une intensité (de 0 à 100)
  facultatives. Choisissez un appareil de segment pour lancer l'effet sur ce
  seul segment.
- **Preset WLED activé** (déclencheur) : lance la scène quand un preset ou une
  playlist est lancé **hors de Gladys** (application WLED, bouton,
  planification, télécommande). Choisissez éventuellement le contrôleur et
  saisissez le nom du preset ; laissés vides, n'importe quel preset convient.
  Les actions suivantes peuvent lire `preset` (son nom) et `preset_id` (son
  numéro). Les presets appliqués par Gladys elle-même ne le déclenchent pas :
  une scène ne peut pas boucler sur elle-même.

Allumer, la luminosité et la couleur sont les actions d'éclairage habituelles
de Gladys.

## Tableau de bord

Ajoutez le widget **WLED** à un tableau de bord et choisissez un contrôleur (ou
un appareil de segment) dans ses réglages. Il affiche :

- la luminosité, en direct ;
- si la lumière est allumée, l'effet, la palette et le preset en cours ;
- jusqu'à trois **boutons de presets** : les presets marqués comme favoris dans
  WLED (donnez-leur un _Quick load label_ dans les réglages du preset), ou vos
  trois premiers presets si aucun n'est marqué ; celui qui est actif porte une
  coche ;
- un bouton **Effet** qui ouvre la liste des effets pour en lancer un.

## En cas de problème

- **Aucun contrôleur dans Découverte** : Gladys et le contrôleur doivent être
  sur le même réseau (le mDNS ne traverse ni les routeurs ni les VLAN).
  Saisissez l'adresse IP dans **Configuration**, puis utilisez **Rechercher
  les contrôleurs** : le message sous le bouton liste les contrôleurs trouvés
  et la façon dont ils sont joints.
- **Un contrôleur reste injoignable** : vérifiez que sa page web s'ouvre à
  `http://<son adresse>` depuis un ordinateur du même réseau. Les noms en
  `.local` ne fonctionnent pas dans l'intégration : utilisez l'adresse IP.
- **Les états arrivent en retard** : sur un contrôleur compilé sans WebSocket,
  les changements faits hors de Gladys mettent jusqu'à 30 secondes à
  apparaître. WLED accepte aussi un nombre limité de clients WebSocket
  simultanés : fermez les onglets de l'application WLED inutilisés.
- L'intégration journalise tout ce qu'elle fait : ouvrez les journaux de
  l'intégration depuis l'interface de Gladys, avec `LOG_LEVEL=debug` pour le
  détail complet.

Cette intégration n'est pas affiliée au projet WLED.
