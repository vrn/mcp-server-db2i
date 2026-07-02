# Plan : Tool MCP `get_client_360`

## État d'implémentation

| Version | Statut | Date |
|---------|--------|------|
| v1 — 5 blocs, vue globale client | ✅ Livré | 2026-06-24 |
| v2 — filtre `adrnum` par agence | ✅ Livré | 2026-06-24 |
| v3 — bloc `transport` (conditions + adresses de livraison) | ✅ Livré | 2026-06-25 |
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
  - v1 : agrégation globale toutes adresses (`SUM` sur CA/MB, `MAX` sur WANNE/WMOIS)
  - v2 ✅ : paramètre `adrnum` optionnel — filtre direct `AND ADRNUM=?` dans CRMCAHT et CRMCONSO
- **$CODPDA** : code agence PDA dans CRMCONSO — ignoré (agrégation par CDART sans filtre PDA)
- **CDREP** : filtrage par commercial reporté en v3. Règle à définir : filtrage par agence ou par individu.
  La sécurité par profil commercial sera ajoutée via un paramètre `cdrep` optionnel.
- **Paramètre `annee`** : calculé côté TypeScript via `new Date().getFullYear()` si absent.
  Jamais via `CURRENT_DATE` SQL.

---

## Blocs de données

| # | Bloc | Source DB | Description |
|---|------|-----------|-------------|
| 1 | `identite` | `CLIENTS` | Raison sociale, adresse, SIREN, rep, catégorie, groupe, statut, blocage |
| 2 | `ca_n_n1` | `CFACENT + CFACLGN + PARAM` | CA HT + Marge brute, année courante vs année précédente |
| 3 | `tendance_mensuelle` | `CRMCAHT` | 24 mois de CA HT + MB HT pré-agrégés, triés du plus récent au plus ancien |
| 4 | `top_articles` | `CRMCONSO` | Top 10 articles (dépivotage 12 slots TypeScript-side), triés par CA HT décroissant |
| 5 | `alertes` | `CLIENTS + CLIRFA` | Encours HT/comptable, code surveillance, blocage BIL, taux RFA année courante |
| 6 | `transport` | `CLIENTS + CLILIV + TOURNEL` | Conditions de livraison client (franchise, type de port, tournée principale) + liste des adresses de livraison actives |

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
adrnum   : number          — optionnel ✅ v2 — filtre CRMCAHT et CRMCONSO sur une agence précise
cdrep    : string          — optionnel, reporté v3 — filtrage par commercial
sessionId: string          — optionnel, HTTP transport
```

`annee` contrôle les calculs N/N-1 et la requête CLIRFA.
`CRMCAHT` retourne toujours les 24 mois disponibles (pas de filtre d'année).
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
    "cdpost": "75001", "ville": "PARIS", "cdpays": "FR",
    "siren": "123456789", "cdrep": "COM", "cdcatcli": "GRD",
    "cdgroupe": "GRPA", "clistat": "ACT", "inactif": " "
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
    { "cdart": "ART001", "artlib": "SACS POUBELLE 110L", "artfam": "HYGIEN",
      "qte_livree": 5000, "ca_ht": 18000.00, "mb_ht": 5100.00, "taux_marge_pct": 28.33 }
  ],
  "alertes": {
    "enctot": 45000.00, "enccpt": 32000.00,
    "cdsurv": "1", "lib_surv": "RAS",
    "bilbloc": " ",
    "rfa_taux": 0.5, "rfa_annee": 2025
  }
}
```

`adrnum` vaut `null` en sortie quand le filtre n'est pas appliqué (vue globale).
`adrnum` vaut le numéro fourni quand filtré (ex: `2` pour l'agence n°2 du client).

---

## Orchestration interne

```
getClient360Tool()
  │
  ├─ 1. queryIdentite()      ← CLIENTS — gate : arrêt si client introuvable
  │
  └─ 2. Promise.all([
          queryCanYear(N),    ← CFACENT + CFACLGN + PARAM
          queryCanYear(N-1),  ← idem
          queryTendanceMensuelle(adrnum?),  ← CRMCAHT
          queryTopArticles(adrnum?),        ← CRMCONSO + ARTICLE
          queryRfa(),                       ← CLIRFA
          queryTransport(),                 ← CLILIV LEFT JOIN TOURNEL
        ])
```

---

## Comportement du filtre `adrnum`

### Sans `adrnum` (vue globale)
- **CRMCAHT** : `SUM(WCAHT_nn)` + `MAX(WANNE_nn)` — additionne toutes les adresses du client
- **CRMCONSO** : lit toutes les lignes `WHERE CDSOC=? AND CDCLI=?` — accumulation TypeScript par `CDART`

### Avec `adrnum` (vue agence)
- **CRMCAHT** : `WHERE CDSOC=? AND CDCLI=? AND ADRNUM=?` — lecture directe sans SUM
- **CRMCONSO** : `WHERE CDSOC=? AND CDCLI=? AND ADRNUM=?` — uniquement les lignes de cette adresse

> Note : `ca_n_n1` n'est pas filtré par `adrnum` — le CA vient de CFACENT/CFACLGN qui ne contient
> pas directement ADRNUM (il faudrait passer par CCMDENT/CLILIV). Vue globale conservée pour ce bloc.

---

## Sous-tâches

### Sous-tâche 1 — Bloc identité (`identite`) — `[x] done`

SELECT CLIENTS avec WHERE CDSOC=? AND CDCLI=?. Retourne aussi ENCCPT, ENCTOT, CDSURV, BILBLOC
(réutilisés par ST5 alertes sans nouvelle requête).

### Sous-tâche 2 — Bloc CA N/N-1 (`ca_n_n1`) — `[x] done`

2 appels `queryCanYear()` : année N et N-1. Formules DOUBLE() identiques à caMargin.ts.
Dates calculées TypeScript : `annee * 10000 + 101` → `AAAA0101`.

### Sous-tâche 3 — Bloc tendance mensuelle (`tendance_mensuelle`) — `[x] done` (v2)

- Sans `adrnum` : `SUM(WCAHT_nn) + MAX(WANNE_nn)` × 24 slots, dépivotage TypeScript
- Avec `adrnum` : SELECT direct + `AND ADRNUM=?`, dépivotage TypeScript identique

### Sous-tâche 4 — Bloc top articles (`top_articles`) — `[x] done` (v2)

- Dépivotage TypeScript des 12 slots CRMCONSO, accumulation par CDART
- `adrnum` → `AND ADRNUM=?` conditionnel dans le WHERE
- Enrichissement ARTLIB/ARTFAM via requête séparée `ARTICLE WHERE CDART IN (...)`

### Sous-tâche 5 — Bloc alertes (`alertes`) — `[x] done`

Champs ENCTOT/ENCCPT/CDSURV/BILBLOC lus depuis le row CLIENTS de ST1 (pas de requête supplémentaire).
`queryRfa()` : SELECT CLIRFA ORDER BY RFAAA DESC FETCH FIRST 1 ROW ONLY.
`lib_surv` interprété TypeScript-side depuis `CDSURV`.

### Sous-tâche 6 — Assemblage + enregistrement MCP — `[x] done` (v2)

Tool `get_client_360` enregistré dans `src/server.ts`.
Schema Zod : `cdsoc` (string len 2), `cdcli` (int positive), `annee` (optional), `adrnum` (optional).

### Sous-tâche 7 — Bloc transport (`transport`) — `[x] done` (v3)

**Intent** : Retourner les conditions de livraison du client et la liste de ses adresses de livraison actives.

**Sources** :
- `CLIENTS` — champs transport lus depuis le row ST1 déjà chargé : `CDTPORT`, `VFRANCO`, `CDTRNLIV`, `NOTRNLIV`, `LIVDAYS`, `AMDTIMLIV`/`AMFTIMLIV`/`PMDTIMLIV`/`PMFTIMLIV`, `LIVRVL`/`LIVRMANU`/`LIVRDEPO`/`LIVRRDV`/`LIVRPAMS`, `ILIVRAIS`, `RLIVRAIS`
- `CLILIV` — une ligne par adresse de livraison (`ADRNUM`), filtrée sur `INACTIF <> 'Y'`
- `TOURNEL` — tourné principale du client (`LEFT JOIN` sur `CDSOC + CDTRNLIV`, `FETCH FIRST 1 ROW ONLY`)

**Fonction** : `queryTransport(cdsoc, cdcli, clientRow, adrnum?, sessionId)` dans `client360.ts`

**Interfaces** :
- `Client360AdresseLivraison` : `adrnum`, `cdtrnliv`, `lbtrnliv`, `cdtrans`, `dayliv`, `livdays`, `amdtimliv`/`amftimliv`/`pmdtimliv`/`pmftimliv`, `livrvl`/`livrmanu`/`livrdepo`/`livrrdv`/`livrpams`, `vfranco`
- `Client360Transport` : `cdtport`, `vfranco_principal`, `cdtrnliv_principal`, `notrnliv`, `lbtrnliv_principal`, `cdtrans_principal`, `livdays`, `contraintes_livraison`, `instructions_livraison`, `remarques_livraison`, `adresses_livraison[]`

**Note sur TOURNEL** : clé composite `(CDSOC, CDAGED, CDTRNLIV)`. Sans `CDAGED` disponible au niveau client, le JOIN se fait sur `CDSOC + CDTRNLIV` uniquement → peut retourner plusieurs lignes si le même code tournée existe dans plusieurs agences départ. Mitigation : `FETCH FIRST 1 ROW ONLY` implicite via la résolution SQL.

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
