/**
 * Vu du ciel — la France au nadir
 *
 * Deux cartes Leaflet cohabitent :
 *   - le visualiseur, en CRS.Simple, qui n'affiche qu'une image en pixels
 *   - la carte de réponse, géographique, où le joueur place son marqueur
 *
 * Le visualiseur ne charge aucune tuile : les URL de tuiles contiennent des
 * coordonnées, et suffiraient à révéler la réponse via l'inspecteur.
 */

// ---------------------------------------------------------------------------
// Données
// ---------------------------------------------------------------------------

// La liste des lieux jouables vient de vuduciel.geojson (voir loadSites) :
// un lieu par Feature, enrichi via QGIS au fil du temps. `rounds` est le
// tirage au sort d'une partie ; `allSites` la totalité disponible pour en
// tirer une nouvelle. Vide tant que loadSites() n'a pas résolu — le
// lancement de la partie attend cette étape (voir Démarrage, en bas).
let allSites = [];
let rounds = [];

const ROUNDS_PER_GAME = 5;

const FRANCE_VIEW = [[46.6, 2.5], 5];

// ---------------------------------------------------------------------------
// Visualiseur d'imagette
// ---------------------------------------------------------------------------

// Espace de travail : les dimensions de l'image, en pixels.
// Aucune signification géographique — c'est tout le principe de CRS.Simple.
const bounds = [[0, 0], [2048, 2048]];

const map = L.map('viewer', {
    crs: L.CRS.Simple,          // plan en pixels, sans projection
    minZoom: -3,                // l'image entière tient à l'écran
    maxZoom: 1,                 // au-delà, on n'agrandit que des pixels
    maxBounds: bounds,          // impossible de sortir de l'image
    maxBoundsViscosity: 1.0,    // blocage net, sans effet élastique
    attributionControl: false
});

// La référence est conservée : setUrl() permet de changer d'image sans
// recréer la couche à chaque manche. Pas d'image tant que rounds est vide
// (chargement du GeoJSON en cours) — le premier loadRound() la posera.
const imageLayer = L.imageOverlay('', bounds).addTo(map);

// ---------------------------------------------------------------------------
// Carte de réponse
// ---------------------------------------------------------------------------

// maxBounds/maxBoundsViscosity évitent un décalage connu entre les
// projections de Leaflet et de MapLibre GL aux latitudes extrêmes (cf. la
// doc du plugin ci-dessous) — sans incidence ici, la partie se joue en
// France, largement à l'intérieur de ces bornes.
const answerMap = L.map('answer', {
    maxBounds: [[-85, -180], [85, 180]],
    maxBoundsViscosity: 1
}).setView(...FRANCE_VIEW);

// Style Positron (OpenFreeMap) : toponymes et routes visibles, rendu proche
// d'un Google Maps. OpenFreeMap sert des tuiles vectorielles gratuites, sans clé,
// greffées sur Leaflet via le plugin maplibre-gl-leaflet.
L.maplibreGL({
    style: 'https://tiles.openfreemap.org/styles/positron'
}).addTo(answerMap);

// ---------------------------------------------------------------------------
// Repères
// ---------------------------------------------------------------------------

// Les épingles par défaut de Leaflet sont des images PNG : impossible à
// styler en CSS. Un divIcon est un simple élément HTML, donc habillable.
// L'apparence est définie dans style.css (.pin--guess, .pin--truth).
//
// iconAnchor place le point d'ancrage au centre du cercle plutôt qu'en bas,
// puisqu'il ne s'agit plus d'une épingle mais d'un repère centré.
const guessIcon = L.divIcon({
    className: 'pin',
    html: '<div class="pin--guess"></div>',
    iconSize: [26, 26],
    iconAnchor: [13, 13]
});

const truthIcon = L.divIcon({
    className: 'pin',
    html: '<div class="pin--truth"></div>',
    iconSize: [26, 26],
    iconAnchor: [13, 13]
});

const proposeIcon = L.divIcon({
    className: 'pin',
    html: '<div class="pin--propose"></div>',
    iconSize: [26, 26],
    iconAnchor: [13, 13]
});

// ---------------------------------------------------------------------------
// État de la partie
// ---------------------------------------------------------------------------

// phase vaut 'guessing' (on cherche), 'revealed' (on regarde le résultat)
// ou 'finished' (partie terminée).
let phase = 'guessing';

let currentRound = 0;
let totalScore = 0;
let trueLatLng = null;
let marker = null;
let trueMarker = null;
let line = null;

// Mode proposition : le joueur désigne un lieu à ajouter au jeu. Il
// suspend la partie, puisqu'il détourne le clic sur la carte de réponse.
let enProposition = false;
let proposeMarker = null;

// ---------------------------------------------------------------------------
// Éléments de l'interface
// ---------------------------------------------------------------------------

const panel = document.getElementById('panel');
const button = document.getElementById('validate');
const result = document.getElementById('result');
const progress = document.getElementById('progress');
const score = document.getElementById('score');
const reveal = document.getElementById('reveal');

const boutonSignaler = document.getElementById('signaler');
const boutonProposer = document.getElementById('proposer');
const proposition = document.getElementById('proposition');
const propositionConsigne = document.getElementById('proposition-consigne');
const propositionAnnuler = document.getElementById('proposition-annuler');
const propositionOuvrir = document.getElementById('proposition-ouvrir');

// ---------------------------------------------------------------------------
// Fonctions
// ---------------------------------------------------------------------------

/**
 * Charge la liste des lieux depuis le GeoJSON et la convertit au format
 * attendu par le jeu.
 *
 * Attention : Leaflet attend (lat, lng), alors que le GeoJSON stocke ses
 * coordonnées [lon, lat] — l'ordre est inversé ici, une fois pour toutes.
 * Le nom de fichier reconstruit ({id}_{emprise}.jpg) doit rester en phase
 * avec celui que produit fetch_ortho.py.
 */
async function loadSites() {
    const response = await fetch('vuduciel.geojson');

    // Sans ce contrôle, un 404 partirait en erreur d'analyse JSON — un
    // message qui n'aide en rien à comprendre que le fichier est absent.
    if (!response.ok) {
        throw new Error(`vuduciel.geojson : HTTP ${response.status}`);
    }

    const data = await response.json();

    return data.features.map(function (feature) {
        const [lng, lat] = feature.geometry.coordinates;
        const { id, nom, emprise } = feature.properties;

        // id et emprise sont conservés au-delà du nom de fichier : ce sont
        // eux qui permettent de désigner sans ambiguïté un lieu dans un
        // signalement, et de le retrouver dans le GeoJSON.
        return {
            image: `tiles/${id}_${emprise}.jpg`,
            id,
            emprise,
            lat,
            lng,
            nom
        };
    });
}

/** Tire au sort `count` lieux parmi `sites`, sans répétition. */
function pickRounds(sites, count) {
    const shuffled = sites.slice();

    // Fisher-Yates : à chaque étape, on tire au sort parmi ce qui n'a pas
    // encore été placé, et on le range en fin de zone déjà traitée.
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    return shuffled.slice(0, Math.min(count, shuffled.length));
}

// ---------------------------------------------------------------------------
// Contributions
// ---------------------------------------------------------------------------

const DEPOT = 'https://github.com/jmetivier-gis/vuduciel';

/** Ouvre un formulaire d'issue GitHub prérempli, dans un nouvel onglet. */
function ouvrirIssue(titre, lignes) {
    const url = DEPOT + '/issues/new'
        + '?title=' + encodeURIComponent(titre)
        + '&body=' + encodeURIComponent(lignes.join('\n'));

    window.open(url, '_blank', 'noopener');
}

/**
 * Prépare un signalement sur la manche affichée.
 *
 * Tant que la réponse n'est pas révélée, le rapport ne mentionne ni le nom
 * ni les coordonnées : sans cette précaution, le bouton deviendrait un
 * moyen de connaître la réponse avant de jouer. L'identifiant
 * suffit à retrouver le lieu, et il est de toute façon déjà lisible dans
 * l'URL de l'imagette.
 */
function signalerManche() {
    const round = rounds[currentRound];

    if (!round) {
        return;
    }

    const revele = phase !== 'guessing';
    const lignes = [
        '## Lieu concerné',
        '',
        `- Identifiant : ${round.id}`,
        `- Emprise : ${round.emprise} m`,
        `- Imagette : \`${round.image}\``,
    ];

    if (revele) {
        lignes.push(
            `- Nom : ${round.nom}`,
            `- Coordonnées (lon, lat) : ${round.lng}, ${round.lat}`
        );
    } else {
        lignes.push('- Nom et coordonnées : masqués, manche en cours');
    }

    lignes.push(
        '',
        '## Nature du problème',
        '',
        "- [ ] Le lieu n'est pas centré dans l'imagette",
        '- [ ] Emprise mal choisie (trop large ou trop serrée)',
        '- [ ] Coordonnées fausses',
        '- [ ] Imagette vide, floue ou illisible',
        '- [ ] Nom erroné',
        '- [ ] Autre',
        '',
        '## Détails',
        '',
        ''
    );

    ouvrirIssue(`Problème sur le lieu ${round.id}`, lignes);
}

/** Entre ou sort du mode proposition. */
function basculerProposition(actif) {
    enProposition = actif;
    proposition.hidden = !actif;

    if (actif) {
        propositionConsigne.textContent =
            'Cliquez sur la carte de réponse, en bas à droite, '
            + "l'emplacement du lieu à proposer.";
        propositionOuvrir.disabled = true;
        return;
    }

    // Le repère ambre n'a de sens que pendant le mode : le laisser
    // brouillerait la lecture de la manche en cours.
    if (proposeMarker) {
        answerMap.removeLayer(proposeMarker);
        proposeMarker = null;
    }
}

/** Prépare la proposition d'un nouveau lieu à partir du point désigné. */
function proposerLieu() {
    if (!proposeMarker) {
        return;
    }

    const { lat, lng } = proposeMarker.getLatLng();

    // Les coordonnées sont données dans l'ordre du GeoJSON ([lon, lat]) et
    // sous forme d'une entrée prête à coller : c'est ce qui transforme une
    // proposition en quelque chose d'exploitable sans ressaisie.
    const entree = '{ "type": "Feature", "properties": '
        + '{ "id": 0, "nom": "", "emprise": 400 }, "geometry": '
        + `{ "type": "Point", "coordinates": [ ${lng}, ${lat} ] } }`;

    const lignes = [
        '## Lieu proposé',
        '',
        '- Nom : ',
        `- Coordonnées (lon, lat) : ${lng}, ${lat}`,
        "- Emprise suggérée : 400 m (côté de l'imagette au sol)",
        '',
        '## Entrée GeoJSON',
        '',
        '```json',
        entree,
        '```',
        '',
        '## Pourquoi ce lieu',
        '',
        ''
    ];

    ouvrirIssue('Proposition de lieu', lignes);
    basculerProposition(false);
}

/** Met en place la manche courante : image, réponse attendue, remise à zéro. */
function loadRound() {
    const round = rounds[currentRound];

    imageLayer.setUrl(round.image);
    trueLatLng = L.latLng(round.lat, round.lng);

    // Sans ce nettoyage, le marqueur de la manche précédente resterait
    // affiché — et permettrait de valider sans avoir cliqué.
    if (marker) {
        answerMap.removeLayer(marker);
        marker = null;
    }

    map.fitBounds(bounds);
    answerMap.setView(...FRANCE_VIEW);
    reveal.textContent = '';
    updateHud();
}

/** Rafraîchit la barre d'information. */
function updateHud() {
    progress.textContent = `Manche ${currentRound + 1} / ${rounds.length}`;
    score.textContent = `${totalScore} points`;
}

/** Retire les éléments de révélation de la carte de réponse. */
function clearReveal() {
    answerMap.removeLayer(trueMarker);
    answerMap.removeLayer(line);
    trueMarker = null;
    line = null;
}

/**
 * Recalibre le motif de tirets pour qu'il commence et finisse pile par un
 * trait plein aux deux extrémités.
 *
 * stroke-dasharray répète son cycle (trait + blanc) depuis le début du
 * tracé sans se soucier de sa longueur totale : sur la plupart des tirages,
 * le dernier segment avant l'arrivée tombe en plein milieu d'un blanc, et
 * le trait semble s'arrêter avant d'atteindre le repère. Comme la longueur
 * du tracé à l'écran dépend du zoom, l'effet varie d'une manche — ou d'un
 * niveau de zoom — à l'autre.
 *
 * On ajuste donc le cycle pour qu'un nombre entier de répétitions tienne
 * exactement dans la longueur réelle du tracé, rendue. À appeler une fois
 * la vue stabilisée (après fitBounds), pas avant.
 */
function fitDashArray(polyline, dashLength, gapLength) {
    const path = polyline.getElement();
    if (!path) {
        return;
    }

    const total = path.getTotalLength();
    const period = dashLength + gapLength;
    const cycles = Math.max(1, Math.round(total / period));
    const scale = total / (cycles * period);

    path.style.strokeDasharray = `${dashLength * scale} ${gapLength * scale}`;
}

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

// Les gestionnaires sont déclarés une seule fois, hors de loadRound().
// Les placer dans la fonction en empilerait un par manche, et un seul clic
// finirait par déclencher plusieurs réactions.

answerMap.on('click', function (e) {
    // Le mode proposition détourne le clic : il passe donc avant la
    // logique de jeu, et pose son propre repère sans toucher à la partie.
    if (enProposition) {
        if (proposeMarker) {
            answerMap.removeLayer(proposeMarker);
        }
        proposeMarker = L.marker(e.latlng, { icon: proposeIcon }).addTo(answerMap);
        propositionOuvrir.disabled = false;
        propositionConsigne.textContent =
            'Point retenu. Vous pourrez compléter le nom et le commentaire '
            + 'dans le formulaire GitHub.';
        return;
    }

    // Pas de repositionnement une fois la réponse révélée.
    if (phase !== 'guessing') {
        return;
    }

    if (marker) {
        answerMap.removeLayer(marker);
    }
    marker = L.marker(e.latlng, { icon: guessIcon }).addTo(answerMap);
});

// La longueur à l'écran du trait change à chaque zoom ou déplacement de la
// carte de réponse (recadrage automatique après validation, ou zoom manuel
// du joueur) — le motif de tirets recalé pour un niveau de vue donné se
// désynchronise dès qu'on en change.
answerMap.on('moveend', function () {
    if (line) {
        fitDashArray(line, 4, 7);
    }
});

button.addEventListener('click', function () {

    // -----------------------------------------------------------------------
    // On cherche → on révèle la réponse
    // -----------------------------------------------------------------------
    if (phase === 'guessing') {
        // Rien à valider tant qu'aucun point n'a été posé.
        if (!marker) {
            return;
        }

        // Le survol du panneau agrandit la carte de réponse via une
        // transition CSS de 0.45s. Si on valide pendant cette transition,
        // Leaflet garde en cache la taille de conteneur d'avant le survol
        // et fitBounds() cale la vue dessus : le réticule apparaît décentré
        // une fois la transition terminée. On resynchronise avant de calculer.
        answerMap.invalidateSize();

        const distanceKm = trueLatLng.distanceTo(marker.getLatLng()) / 1000;
        const points = Math.round(5000 * Math.exp(-distanceKm / 250));

        totalScore += points;
        updateHud();
        result.textContent = `À ${distanceKm.toFixed(1)} km — ${points} points`;
        reveal.textContent = rounds[currentRound].nom;

        // La vraie position, puis le trait qui matérialise l'erreur.
        // Les références sont conservées pour pouvoir les retirer ensuite.
        // L'apparence du trait est définie en CSS, pas ici.
        trueMarker = L.marker(trueLatLng, { icon: truthIcon }).addTo(answerMap);
        line = L.polyline([trueLatLng, marker.getLatLng()]).addTo(answerMap);

        // Recadrage sur les deux points, pour que l'écart reste lisible
        // même quand il est grand.
        answerMap.fitBounds(line.getBounds(), { padding: [50, 50] });

        phase = 'revealed';

        const isLastRound = currentRound === rounds.length - 1;
        button.textContent = isLastRound ? 'Voir le résultat' : 'Suivant';
        return;
    }

    // -----------------------------------------------------------------------
    // On a vu le résultat → manche suivante, ou fin de partie
    // -----------------------------------------------------------------------
    if (phase === 'revealed') {
        clearReveal();
        currentRound++;

        if (currentRound < rounds.length) {
            phase = 'guessing';
            result.textContent = '';
            button.textContent = 'Valider';
            loadRound();
        } else {
            phase = 'finished';
            result.textContent =
                `Score final : ${totalScore} / ${rounds.length * 5000}`;
            button.textContent = 'Rejouer';
        }
        return;
    }

    // -----------------------------------------------------------------------
    // Partie terminée → on remet tout à zéro, avec un nouveau tirage
    // -----------------------------------------------------------------------
    phase = 'guessing';
    currentRound = 0;
    totalScore = 0;
    rounds = pickRounds(allSites, ROUNDS_PER_GAME);
    result.textContent = '';
    button.textContent = 'Valider';
    loadRound();
});

boutonSignaler.addEventListener('click', signalerManche);

boutonProposer.addEventListener('click', function () {
    basculerProposition(!enProposition);
});

propositionAnnuler.addEventListener('click', function () {
    basculerProposition(false);
});

propositionOuvrir.addEventListener('click', proposerLieu);

// Échappe du mode proposition sans avoir à viser le bouton Annuler.
document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && enProposition) {
        basculerProposition(false);
    }
});

// La carte de réponse s'agrandit au survol, mais Leaflet ne recalcule pas
// ses dimensions tout seul : sans cet appel, les tuiles se déforment et les
// clics tombent à côté.
panel.addEventListener('transitionend', function (e) {
    // La largeur transitionne sur .panel, la hauteur sur #answer (qui
    // bubble jusqu'ici) : les deux doivent resynchroniser Leaflet, sinon
    // la fin de l'une des deux transitions laisse la taille en cache
    // désynchronisée de la taille réelle.
    if (e.propertyName === 'width' || e.propertyName === 'height') {
        answerMap.invalidateSize();
    }
});

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

loadSites().then(function (sites) {
    if (sites.length === 0) {
        throw new Error('vuduciel.geojson ne contient aucun lieu');
    }

    allSites = sites;
    rounds = pickRounds(allSites, ROUNDS_PER_GAME);
    loadRound();
}).catch(function (erreur) {
    // Sans ce rattrapage, l'échec partirait en rejet de promesse non
    // traité : la page resterait figée, sans image ni message, et la seule
    // trace serait dans la console. Le cas de loin le plus fréquent est
    // l'ouverture du fichier en file://, où le navigateur refuse fetch().
    console.error(erreur);

    const enLocal = window.location.protocol === 'file:';

    reveal.textContent = enLocal
        ? 'Ouvrez le jeu via un serveur local'
        : 'Liste des lieux illisible';

    result.textContent = enLocal
        ? 'file:// bloque la lecture du GeoJSON — lancez « python -m http.server »'
        : erreur.message;

    button.disabled = true;
});