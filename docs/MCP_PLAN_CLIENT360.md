# Plan : Tool MCP `get_client_360`

## État d'implémentation

| Version | Statut | Date |
|---------|--------|------|
| v1 — 5 blocs, vue globale client | ✅ Livré | 2026-06-24 |
| v2 — filtre `adrnum` par agence | ✅ Livré | 2026-06-24 |
| v3 — bloc `transport` (conditions, répartition départements, frais de port) et `commandes_en_cours` | ✅ Livré | 2026-06-25 |
| v4 — filtre `cdrep` par commercial | 🔄 Reporté | Règles de sécurité à définir |

---

## Vue d'ensemble

Tool MCP `get_client_360` dans `/Users/vrn/Antigravity/mcp-server-db2i`.
Retourne une fiche complète à 360° d'un client identifié par `(cdsoc, cdcli)`.

L'IA consomme ce tool pour préparer une visite, répondre à une question de gestion,
ou produire un récapitulatif client sans avoir besoin d'enchaîner plusieurs requêtes SQL manuelles.

**Fichier source** : `src/tools/client360.ts` — enregistré dans `src/server.ts`.

### Décisions de conception actées

- **ADRNUM** : permet de découper un grand client en plusieurs agences/sites de livraison.
  - v1 : agrégation globale toutes adresses (`SUM` sur CA/MB)
  - v2 ✅ : paramètre `adrnum` optionnel — filtre conditionnel sur `LIVADRNUM` dans `CFACLIV` ou `CLIVENT` ou `CCMDENT` selon le bloc.
- **$CODPDA** : code agence PDA dans CRMCONSO — ignoré (agrégation par CDART sans filtre PDA).
- **CDREP** : filtrage par commercial reporté en v4. Règle à définir : filtrage par agence ou par individu.
  La sécurité par profil commercial sera ajoutée via un paramètre `cdrep` optionnel.
- **Paramètre `annee`** : calculé côté TypeScript via `new Date().getFullYear()` si absent.
  Jamais via `CURRENT_DATE` SQL.

---

## Blocs de données

| # | Bloc | Source DB | Description |
|---|------|-----------|-------------|
| 1 | `identite` | `CLIENTS` | Raison sociale, adresse, SIREN, rep, catégorie, groupe, statut, blocage, TVACEE |
| 2 | `ca_n_n1` | `CFACENT + CFACLGN + PARAM` | CA HT + Marge brute, année courante vs année précédente |
| 3 | `tendance_mensuelle` | `CFACENT + CFACLGN + PARAM` | 24 mois de CA HT + MB HT calculés en temps réel, triés du plus récent au plus ancien |
| 4 | `top_articles` | `CFACENT + CFACLGN + PARAM + ARTICLE` | Top 10 articles consommés sur 3 ans, avec métriques de ventes par période (N, N-1, N-1 YTD, N-2, N-2 YTD) |
| 5 | `alertes` | `CLIENTS + CLIRFA` | Encours HT/comptable, code surveillance, blocage BIL, taux RFA année courante |
| 6 | `transport` | `CLIENTS + CLILIV + TOURNEL + CLIVENT` | Conditions de livraison principales, nombre de sites par département, et métriques de frais de port (invoqués vs dépensés sur N, N-1, N-1 YTD) |
| 7 | `commandes_en_cours` | `CCMDENT + CCMDLGN + PARAM` | Liste des commandes en cours non soldées (`CMDETAT <> 'S'`), triées par date décroissante |

---

## Règles SQL transverses

- `CDSOC` obligatoire dans tout `WHERE` et tout `JOIN ON`
- Dates : format `8S 0` entier AAAAMMJJ — jamais `CURRENT_DATE` en SQL
- `DOUBLE()` sur tout calcul impliquant `PVUNIHT × PVREM × FACQTE` pour éviter SQL0802
- Formule CA validée : `SUM(DOUBLE(PVUNIHT)*(1-DOUBLE(PVREM)/100)*DOUBLE(FACQTE)/DOUBLE(NBR))`
- Formule partagée avec `caMargin.ts` — ne pas réinventer (copie avec commentaire `@see caMargin.ts`)
- Filtre lignes factures : `AND L.FACQTE <> 0` uniquement (pas de filtre FACETAT ni LGRATUIT)

---

## Paramètres d'entrée (état actuel)

```
cdsoc    : string          — code société (obligatoire)
cdcli    : number (int)    — code client (obligatoire)
annee    : number          — optionnel, défaut = new Date().getFullYear()
adrnum   : number          — optionnel — filtre tendance_mensuelle, top_articles, transport (CLIVENT) et commandes en cours
sessionId: string          — optionnel, HTTP transport
```

`annee` contrôle les calculs N/N-1 et la requête CLIRFA.
`adrnum` absent = vue globale client (SUM de toutes les adresses).

---

## Structure de sortie (état actuel)

```json
{
  "success": true,
  "cdsoc": "01",
  "cdcli": 123456,
  "annee": 2025,
  "adrnum": null,
  "identite": {
    "raison": "DUPONT SAS", "adress1": "...", "adress2": "", "adress3": "",
    "cdpost": "75001", "ville": "PARIS", "cdpays": "France",
    "siren": "123 456 789", "cdrep": "Jean MARTIN (COM)", "cdcatcli": "GRD - Grands Comptes",
    "cdgroupe": "GRPA", "clistat": "ACT", "inactif": " ", "tvacee": "FR12123456789"
  },
  "ca_n_n1": {
    "annee_n":  { "annee": 2025, "ca_ht": 145000, "cout_achat_ht": 107000, "marge_ht": 38000, "taux_marge_pct": 26.21 },
    "annee_n1": { "annee": 2024, "ca_ht": 132000, "cout_achat_ht": 98000,  "marge_ht": 34000, "taux_marge_pct": 25.76 }
  },
  "tendance_mensuelle": [
    { "annee": 2025, "mois": 6, "ca_ht": 14200.00, "mb_ht": 3700.00 },
    { "annee": 2025, "mois": 5, "ca_ht": 12800.00, "mb_ht": 3200.00 }
  ],
  "top_articles": [
    {
      "cdart": "ART001",
      "artlib": "SACS POUBELLE 110L",
      "artfam": "Adhésifs",
      "annee_n": { "qte_livree": 5000, "ca_ht": 18000.00, "mb_ht": 5100.00, "taux_marge_pct": 28.33 },
      "annee_n1": { "qte_livree": 4800, "ca_ht": 17200.00, "mb_ht": 4900.00, "taux_marge_pct": 28.49 },
      "annee_n1_ytd": { "qte_livree": 2400, "ca_ht": 8600.00, "mb_ht": 2450.00, "taux_marge_pct": 28.49 },
      "annee_n2": { "qte_livree": 4000, "ca_ht": 14000.00, "mb_ht": 4000.00, "taux_marge_pct": 28.57 },
      "annee_n2_ytd": { "qte_livree": 2000, "ca_ht": 7000.00, "mb_ht": 2000.00, "taux_marge_pct": 28.57 }
    }
  ],
  "alertes": {
    "enctot": 45000.00, "enccpt": 32000.00,
    "cdsurv": "1", "lib_surv": "RAS",
    "bilbloc": " ",
    "rfa_taux": 0.5, "rfa_annee": 2025
  },
  "transport": {
    "cdtport": "F",
    "vfranco": 500,
    "cdtrnliv": "T01",
    "lbtrnliv": "Tournée Nord",
    "cdtrans": "TR01",
    "livdays": "1100000",
    "ilivrais": "S'adresser au quai n°3",
    "rlivrais": "Code portail 1234",
    "total_sites": 12,
    "sites_par_departement": [
      { "departement": "75", "quantite": 5 },
      { "departement": "92", "quantite": 4 },
      { "departement": "Autre dept", "quantite": 3 }
    ],
    "frais_port": {
      "annee_n": { "facture": 120.00, "depense": 150.00, "depense_moyen": 15.00, "nb_livraisons": 10 },
      "annee_n1": { "facture": 200.00, "depense": 240.00, "depense_moyen": 16.00, "nb_livraisons": 15 },
      "annee_n1_ytd": { "facture": 100.00, "depense": 120.00, "depense_moyen": 15.00, "nb_livraisons": 8 }
    }
  },
  "commandes_en_cours": [
    { "cmdnumc": 789012, "cmddate": 20260701, "dmddate": 20260710, "cmdref": "REF-ABC", "cmdetat": "En cours", "montant_ht": 1250.50 }
  ]
}
```

`adrnum` vaut `null` en sortie quand le filtre n'est pas appliqué (vue globale).
`adrnum` vaut le numéro fourni quand filtré (ex: `2` pour l'adresse n°2 du client).

---

## Orchestration interne

```
getClient360Tool()
  │
  ├─ 1. queryIdentite()             ← CLIENTS — gate : arrêt si client introuvable
  │
  └─ 2. Promise.all([
          queryCanYear(N),          ← CFACENT + CFACLGN + PARAM
          queryCanYear(N-1),        ← idem
          queryTendanceMensuelle(), ← CFACENT + CFACLGN + PARAM (avec CFACLIV si adrnum)
          queryTopArticles(),       ← CFACENT + CFACLGN + PARAM + ARTICLE (avec CFACLIV si adrnum)
          queryRfa(),               ← CLIRFA
          queryTransport(),         ← CLIENTS + CLILIV + TOURNEL + CLIVENT (avec adrnum)
          queryCommandesEnCours(),  ← CCMDENT + CCMDLGN + PARAM (avec adrnum)
        ])
```

---

## Comportement du filtre `adrnum`

### Sans `adrnum` (vue globale)
- **Tendance Mensuelle & Top Articles** : Lit toutes les lignes `WHERE CDSOC=? AND CDCLI=?` sur les dates de la période concernée.
- **Transport** :
  - Compte toutes les adresses actives de `CLILIV` (où `INACTIF <> 'I'`).
  - Lit toutes les expéditions du client dans `CLIVENT`.
- **Commandes en cours** : Lit toutes les commandes actives du client dans `CCMDENT`/`CCMDLGN`.

### Avec `adrnum` (vue agence)
- **Tendance Mensuelle & Top Articles** : Jointure avec `CFACLIV` pour filtrer sur `LIVADRNUM = ?`.
- **Transport** :
  - Filtre `CLILIV` sur `ADRNUM = ?`.
  - Filtre `CLIVENT` sur `LIVADRNUM = ?`.
- **Commandes en cours** : Filtre `CCMDENT` sur `LIVADRNUM = ?`.

> Note : `ca_n_n1` n'est pas filtré par `adrnum` — le CA vient de CFACENT/CFACLGN qui ne contient
> pas directement ADRNUM (il faudrait passer par CCMDENT/CLILIV). Vue globale conservée pour ce bloc.

---

## Sous-tâches

### Sous-tâche 1 — Bloc identité (`identite`) — `[x] done`

SELECT CLIENTS avec WHERE CDSOC=? AND CDCLI=?. Retourne aussi ENCCPT, ENCTOT, CDSURV, BILBLOC. Jointures avec `PARAM` pour formater le nom du représentant (`REPRES`) et décoder le libellé de la catégorie client (`CATEG-CLI`).

### Sous-tâche 2 — Bloc CA N/N-1 (`ca_n_n1`) — `[x] done`

2 appels `queryCanYear()` : année N et N-1. Formules DOUBLE() identiques à caMargin.ts.
Dates calculées TypeScript : `annee * 10000 + 101` → `AAAA0101` à `AAAA1231`.

### Sous-tâche 3 — Bloc tendance mensuelle (`tendance_mensuelle`) — `[x] done` (v2)

- Calcule dynamiquement le CA et la marge sur les 24 derniers mois glissants à partir de `CFACENT` et `CFACLGN`.
- Si `adrnum` est spécifié, jointure avec `CFACLIV` pour filtrer sur l'adresse de livraison.

### Sous-tâche 4 — Bloc top articles (`top_articles`) — `[x] done` (v2)

- Identifie le Top 10 des articles par CA HT sur une fenêtre de 3 ans.
- Récupère ensuite le détail mensuel des ventes pour ces 10 articles sur les années N, N-1 et N-2.
- Effectue une accumulation TypeScript par période (N, N-1, N-1 YTD, N-2, N-2 YTD).
- Enrichissement ARTLIB/ARTFAM via jointure `ARTICLE`.

### Sous-tâche 5 — Bloc alertes (`alertes`) — `[x] done`

Champs ENCTOT/ENCCPT/CDSURV/BILBLOC lus depuis le row CLIENTS de ST1 (pas de requête supplémentaire).
`queryRfa()` : SELECT CLIRFA ORDER BY RFAAA DESC FETCH FIRST 1 ROW ONLY (limité à l'année courante N).
`lib_surv` interprété TypeScript-side depuis `CDSURV`.

### Sous-tâche 6 — Assemblage + enregistrement MCP — `[x] done` (v2)

Tool `get_client_360` enregistré dans `src/server.ts`.
Schema Zod : `cdsoc` (string len 2), `cdcli` (int positive), `annee` (optional), `adrnum` (optional).

### Sous-tâche 7 — Bloc transport (`transport`) — `[x] done` (v3)

**Intent** : Retourner les conditions de livraison du client principal, la répartition géographique de ses sites et l'analyse de ses frais de port.

**Sources** :
- `CLIENTS` — champs transport lus depuis le row ST1 déjà chargé.
- `CLILIV` — adresses de livraison (`ADRNUM`), filtré sur `INACTIF <> 'I'`.
- `TOURNEL` — tournée principale du client (`LEFT JOIN` sur `CDSOC + CDTRNLIV`, `FETCH FIRST 1 ROW ONLY`).
- `CLIVENT` — expéditions de marchandises pour obtenir le comparatif des coûts de port (facturés vs dépensés).

**Fonction** : `queryTransport(cdsoc, cdcli, clientRow, referenceYear, adrnum?, sessionId)` dans `client360.ts`.

### Sous-tâche 8 — Bloc commandes en cours (`commandes_en_cours`) — `[x] done` (v3)

**Intent** : Récupérer les commandes en cours du client.

**Sources** :
- `CCMDENT` et `CCMDLGN` joint à `PARAM` pour le calcul du montant HT.
- Exclut les commandes et lignes soldées (`CMDETAT <> 'S'` et `LGNETAT <> 'S'`).
- Supporte le filtrage optionnel par `adrnum` via `E.LIVADRNUM = ?`.

---

## Roadmap v4 — Filtre CDREP

À implémenter quand les règles de sécurité sont définies.

**Questions ouvertes :**
- Filtrage par agence (`CDAGE`) ou par individu (`CDREP`) ?
- Le commercial voit-il tous les clients de son agence, ou uniquement les siens ?
- Impact sur CRMCAHT (clé contient `CDREP`) et CFACENT (ne contient pas `CDREP` directement — passe par `CLIENTS.CDREP`)


**Approche probable :**
```
AND CDREP = ?   -- dans CRMCAHT et CRMCONSO si filtrage par individu
-- OU
AND E.CDCLI IN (SELECT CDCLI FROM CLIENTS WHERE CDSOC=? AND CDREP=?)  -- dans ca_n_n1
```
