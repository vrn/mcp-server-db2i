# Plan : Tool MCP `get_fournisseur_360`

## État d'implémentation

| Version | Statut | Date |
|---------|--------|------|
| v1 — 5 blocs, vue globale fournisseur | ✅ Livré | 2026-06-25 |
| v2 — filtre `cdagel` par agence réceptrice | ✅ Livré | 2026-06-25 |
| v3 — bloc `transport` (conditions + frais de port N/N-1) | ✅ Livré | 2026-06-25 |

---

## Vue d'ensemble

Tool MCP `get_fournisseur_360` dans `/Users/vrn/Antigravity/mcp-server-db2i`.
Retourne une fiche complète à 360° pour un fournisseur identifié par `(cdsoc, cdfou)`.
Structure miroir de `get_client_360` — 6 blocs, même orchestration `Promise.all`.

**Fichier cible** : `src/tools/fournisseur360.ts` — enregistré dans `src/server.ts`.

### Décisions de conception actées

- **Source des montants d'achat** : lignes de BL fournisseur (`FLIVENT + FLIVLGN`) — la facture fournisseur (`FFACENT`) ne contient pas les montants, c'est le BL qui les porte (identique au rôle de `CFACLGN` côté client)
- **Pas de table pré-agrégée** : aucun équivalent de `CRMCAHT`/`CRMCONSO` côté achats. La tendance mensuelle et le top articles sont calculés directement depuis `FLIVENT + FLIVLGN` par SQL groupé.
- **`cdagel`** : agence réceptrice de la livraison — filtre optionnel. Absent = vue globale toutes agences.
- **Paramètre `annee`** : calculé côté TypeScript via `new Date().getFullYear()` si absent.
- **Tendance mensuelle** : 24 mois glissants depuis `LIVDATE`, calculés par SQL `GROUP BY` sur `YEAR(LIVDATE)/MONTH(LIVDATE)`.

---

## Symétrie avec `get_client_360`

| Bloc client | Source client | ↔ | Bloc fournisseur | Source fournisseur |
|------------|--------------|---|-----------------|-------------------|
| `identite` | `CLIENTS` | ↔ | `identite` | `FOURNIS` |
| `ca_n_n1` | `CFACENT+CFACLGN+PARAM` | ↔ | `achats_n_n1` | `FLIVENT+FLIVLGN+PARAM` |
| `tendance_mensuelle` (pré-agrégé CRMCAHT) | `CRMCAHT` | ↔ | `tendance_mensuelle` (calculé) | `FLIVENT+FLIVLGN` groupé |
| `top_articles` (pré-agrégé CRMCONSO) | `CRMCONSO` | ↔ | `top_articles` (calculé) | `FLIVENT+FLIVLGN+ARTICLE` |
| `alertes` | `CLIENTS+CLIRFA` | ↔ | `alertes` | `FOURNIS+FOURFA` |
| `transport` | `CLIENTS+CLILIV+TOURNEL` | ↔ | `transport` | `FOURNIS+FLIVENT` |
| filtre agence `adrnum` | `CRMCAHT/CRMCONSO.ADRNUM` | ↔ | filtre agence `cdagel` | `FLIVENT.CDAGEL` |

---

## Formule de calcul achat (validée sur STAAF10R.SQLRPGLE)

```
PA_NET_HT   = PAUNIHT × (1 − PAREM / 100)
ACHAT_HT    = SUM(PA_NET_HT × LIVQTE / NBRUNITE)
```

**Champs source `FLIVLGN` :**
- `PAUNIHT` `8S 2` — Prix d'achat unitaire HT
- `PAREM`   `4S 2` — % remise fournisseur
- `LIVQTE`  `10S 2` — Quantité livrée
- `UNITPA`  `5A`   — Code unité achat (clé PARAM pour NBRUNITE)

**NBRUNITE** : même mécanisme que côté client —
`LEFT JOIN PARAM P ON P.CDSOC=L.CDSOC AND P.MOTCLE='UNITE-PV  ' AND P.CDPARM1=L.UNITPA AND P.CDPARM2='          '`
Positions 1-5 de `PARDATA`, fallback = 1.

**DOUBLE() obligatoire** sur tous les calculs pour éviter SQL0802 (même règle que caMargin.ts).

**Filtre de ligne** : `AND L.LIVQTE <> 0` — seul filtre appliqué (identique à STAAF10R).

**Jointure** : `FLIVENT E JOIN FLIVLGN L ON L.CDSOC=E.CDSOC AND L.LIVNUMF=E.LIVNUMF AND L.CMDNUMF=E.CMDNUMF`
Filtre date : `E.LIVDATE BETWEEN ? AND ?` (format `8S 0` AAAAMMJJ, depuis `FLIVENT`).

---

## Paramètres d'entrée

```
cdsoc   : string    — code société (obligatoire)
cdfou   : number    — code fournisseur 6S 0 (obligatoire)
annee   : number    — optionnel, défaut = new Date().getFullYear()
cdagel  : string    — optionnel, filtre par agence réceptrice (FLIVENT.CDAGEL, 2A)
sessionId: string   — optionnel, HTTP transport
```

`cdagel` absent = vue globale toutes agences agrégées.
`cdagel` fourni = vue restreinte à cette agence réceptrice (tous les blocs calculés depuis FLIVENT/FLIVLGN).

---

## Structure de sortie

```json
{
  "success": true,
  "cdsoc": "01",
  "cdfou": 12345,
  "annee": 2025,
  "cdagel": null,
  "identite": {
    "raison": "PAPETERIES DU NORD", "adress1": "...", "adress2": "", "adress3": "",
    "cdpost": "59000", "ville": "LILLE", "cdpays": "FR",
    "siren": "987654321", "cdnaf": "17.12Z", "cddevis": "EUR",
    "livdly": 5, "bloque": " ", "rglcd": "30J"
  },
  "achats_n_n1": {
    "annee_n":  { "annee": 2025, "achat_ht": 87000, "qte_livree": 125000 },
    "annee_n1": { "annee": 2024, "achat_ht": 79000, "qte_livree": 118000 }
  },
  "tendance_mensuelle": [
    { "annee": 2025, "mois": 6, "achat_ht": 8200.00, "qte_livree": 11500 },
    { "annee": 2025, "mois": 5, "achat_ht": 7600.00, "qte_livree": 10800 }
  ],
  "top_articles": [
    { "cdart": "ART042", "artlib": "PAPIER A4 80G", "artfam": "PAPIER",
      "qte_livree": 45000, "achat_ht": 18500.00, "pa_net_moyen": 0.41 }
  ],
  "alertes": {
    "bloque": " ",
    "rfa_taux": 2.0, "rfa_annee": 2025, "rfa_obtenu": 1700, "rfa_seuil": 50000
  },
  "transport": {
    "cdtport": "F",
    "type_port_lib": "Franco",
    "ftarif": "N",
    "ftarif_lib": "Tarif national",
    "franco_valeur": 150,
    "franco_palettes": 2,
    "franco_poids_kg": 500,
    "franco_cartons": 0,
    "delai_livraison_jours": 5,
    "frets_n":  { "annee": 2025, "frais_port": 320.00, "frais_transport": 180.00, "total": 500.00 },
    "frets_n1": { "annee": 2024, "frais_port": 290.00, "frais_transport": 160.00, "total": 450.00 }
  }
}
```

---

## Orchestration interne

```
getFournisseur360Tool()
  │
  ├─ 1. queryIdentite()         ← FOURNIS — gate : arrêt si fournisseur introuvable
  │                               (fournit aussi les champs transport statiques)
  └─ 2. Promise.all([
          queryAchatsYear(N),   ← FLIVENT + FLIVLGN + PARAM
          queryAchatsYear(N-1), ← idem
          queryTendance(),      ← FLIVENT + FLIVLGN + PARAM groupé par AAAA/MM
          queryTopArticles(),   ← FLIVENT + FLIVLGN + ARTICLE
          queryRfa(),           ← FOURFA
          queryFrets(N),        ← FLIVENT SUM(FRAIPORT + FRAITRANS)
          queryFrets(N-1),      ← idem
        ])
```

---

## Sous-tâches

---

### Sous-tâche 1 — Bloc identité (`identite`) — `[x] done`

**Intent** : Récupérer les champs d'identité du fournisseur depuis `FOURNIS`.

**Expected outcomes** :
- `identite` contient : `raison`, `adress1-3`, `cdpost`, `ville`, `cdpays`, `siren`, `cdnaf`, `cddevis`, `livdly`, `bloque`, `rglcd`
- `success: false` si fournisseur introuvable (gate obligatoire)

**Todo list** :
1. Créer `src/tools/fournisseur360.ts` avec interfaces TypeScript et structure de base
2. Écrire `queryIdentite(cdsoc, cdfou, sessionId)` : `SELECT` simple sur `FOURNIS` avec `WHERE CDSOC=? AND CDFOU=?`
3. Mapper le row DB2 vers `Fournisseur360Identite`

**Relevant context** :
- `src/QDDSSRC_DDS/FOURNIS.PF` — RAISON (30A), ADRESS1-3 (30A), CDPOST (5A), VILLE (30A), CDPAYS (3A), SIREN (9A), CDNAF (5A), CDDEVIS (3A), LIVDLY (3S0), BLOQUE (1A), RGLCD (3A)
- Pattern identique à `client360.ts` — `executeQuery`, `createChildLogger`

---

### Sous-tâche 2 — Bloc achats N/N-1 (`achats_n_n1`) — `[x] done`

**Intent** : Calculer montant achat HT + quantité livrée pour l'année N et N-1.

**Expected outcomes** :
- `achats_n_n1.annee_n` et `achats_n_n1.annee_n1` contiennent : `annee`, `achat_ht`, `qte_livree`
- Formule validée sur STAAF10R : `SUM(DOUBLE(PAUNIHT)*(1-DOUBLE(PAREM)/100)*DOUBLE(LIVQTE)/DOUBLE(NBR))`

**Todo list** :
1. Écrire `queryAchatsYear(cdsoc, cdfou, annee, cdagel?, sessionId)` :
   - `date_debut = annee * 10000 + 101`, `date_fin = annee * 10000 + 1231`
   - JOIN : `FLIVENT E JOIN FLIVLGN L ON L.CDSOC=E.CDSOC AND L.LIVNUMF=E.LIVNUMF AND L.CMDNUMF=E.CMDNUMF`
   - `LEFT JOIN PARAM P ON P.CDSOC=L.CDSOC AND P.MOTCLE='UNITE-PV  ' AND P.CDPARM1=L.UNITPA AND P.CDPARM2='          '`
   - `WHERE E.CDSOC=? AND E.CDFOU=? AND E.LIVDATE BETWEEN ? AND ? AND L.LIVQTE <> 0`
   - `AND E.CDAGEL=?` si `cdagel` fourni
2. Expressions SQL avec DOUBLE() — voir constantes à définir (PAUNIHT, PAREM, LIVQTE, NBR)
3. Mapper vers `Fournisseur360AchatsYear`

**Relevant context** :
- `src/QDDSSRC_DDS/FLIVENT.PF` — CDFOU (6S0), CDAGEL (2A), LIVDATE (8S0), LIVNUMF (7P0), CMDNUMF (7P0)
- `src/QDDSSRC_DDS/FLIVLGN.PF` — PAUNIHT (8S2), PAREM (4S2), LIVQTE (10S2), UNITPA (5A)
- `src/tools/client360.ts` — pattern queryCanYear() à dupliquer en adaptant les champs
- `src/tools/caMargin.ts` l.102-111 — constantes DOUBLE() à adapter pour les champs achat

---

### Sous-tâche 3 — Bloc tendance mensuelle (`tendance_mensuelle`) — `[x] done`

**Intent** : Calculer 24 mois glissants de montants d'achat depuis `FLIVENT + FLIVLGN` par SQL GROUP BY.

**Expected outcomes** :
- Tableau de max 24 éléments `{ annee, mois, achat_ht, qte_livree }`
- 24 mois glissants depuis la date courante, triés du plus récent au plus ancien
- Mois sans livraison : exclus (pas de ligne vide)

**Todo list** :
1. Écrire `queryTendanceMensuelle(cdsoc, cdfou, cdagel?, sessionId)` :
   - Calculer `date_debut` = 24 mois en arrière depuis aujourd'hui : `(annee-2) * 10000 + mmjj_courant`
   - SQL :
     ```sql
     SELECT
       YEAR(DATE(SUBSTR(DIGITS(E.LIVDATE),1,4)||'-'||SUBSTR(DIGITS(E.LIVDATE),5,2)||'-'||SUBSTR(DIGITS(E.LIVDATE),7,2))) AS ANNEE,
       MONTH(DATE(...)) AS MOIS,
       SUM(...achat...) AS ACHAT_HT,
       SUM(L.LIVQTE) AS QTE_LIVREE
     FROM FLIVENT E
     JOIN FLIVLGN L ON ...
     LEFT JOIN PARAM P ON ...
     WHERE E.CDSOC=? AND E.CDFOU=?
       AND E.LIVDATE BETWEEN ? AND ?
       AND L.LIVQTE <> 0
     GROUP BY ANNEE_CALC, MOIS_CALC
     ORDER BY ANNEE_CALC DESC, MOIS_CALC DESC
     FETCH FIRST 24 ROWS ONLY
     ```
   - Alternative plus simple : utiliser `E.LIVDATE / 100` pour obtenir AAAAMM, puis GROUP BY — évite les conversions DATE.
     ```sql
     INTEGER(E.LIVDATE / 100) AS AAAAMM  -- ex: 202506
     -- puis dans le mapper : annee = Math.floor(aaaamm / 100), mois = aaaamm % 100
     ```
2. Mapper TypeScript : `{ annee: Math.floor(aaaamm/100), mois: aaaamm%100, achat_ht, qte_livree }`

**Relevant context** :
- `FLIVENT.LIVDATE` est `8S 0` AAAAMMJJ — `INTEGER(LIVDATE/100)` donne AAAAMM proprement
- Calcul date 24 mois en arrière côté TypeScript : `new Date()` - 24 mois → AAAAMMJJ

---

### Sous-tâche 4 — Bloc top articles (`top_articles`) — `[x] done`

**Intent** : Extraire les 10 articles les plus achetés chez ce fournisseur sur les 12 derniers mois.

**Expected outcomes** :
- Tableau de max 10 articles : `{ cdart, artlib, artfam, qte_livree, achat_ht, pa_net_moyen }`
- `pa_net_moyen` = `achat_ht / qte_livree` si qte > 0, sinon null (utile pour comparaison tarifaire)
- `artlib` + `artfam` obtenus via JOIN ARTICLE (ou depuis FLIVLGN.ARTLIB directement)

**Todo list** :
1. Écrire `queryTopArticles(cdsoc, cdfou, annee, cdagel?, sessionId)` :
   - Période : année N (12 mois complets)
   - SQL : GROUP BY `L.CDART`, SUM de l'achat HT et de LIVQTE, JOIN ARTICLE pour ARTFAM
   - `FETCH FIRST 10 ROWS ONLY ORDER BY ACHAT_HT DESC`
2. `pa_net_moyen` calculé TypeScript-side après mapping

**Relevant context** :
- `FLIVLGN.ARTLIB` (90A) est disponible directement — pas besoin de JOIN ARTICLE pour le libellé
- `JOIN ARTICLE ON A.CDSOC=L.CDSOC AND A.CDART=L.CDART` pour obtenir `ARTFAM` uniquement
- Contrairement à CRMCONSO, ici le SQL fait directement le GROUP BY CDART — pas de dépivotage TypeScript

---

### Sous-tâche 5 — Bloc alertes (`alertes`) — `[x] done`

**Intent** : Retourner les indicateurs de risque fournisseur et le taux RFA.

**Expected outcomes** :
- `alertes` contient : `bloque`, `rfa_taux`, `rfa_annee`, `rfa_obtenu`, `rfa_seuil`
- `bloque` lu depuis le row `FOURNIS` de ST1 — pas de nouvelle requête
- `rfa_*` issus de `FOURFA` — ligne la plus récente ≤ `annee`

**Todo list** :
1. Lire `BLOQUE` depuis le row `FOURNIS` de ST1 (pas de requête supplémentaire)
2. Écrire `queryRfa(cdsoc, cdfou, annee, sessionId)` :
   ```sql
   SELECT RFATAUX, RFAAA, RFAOBTNU, RFASEUIL
   FROM FOURFA
   WHERE CDSOC=? AND CDFOU=? AND RFAAA <= ?
   ORDER BY RFAAA DESC, RFASEUIL ASC
   FETCH FIRST 1 ROW ONLY
   ```

**Relevant context** :
- `src/QDDSSRC_DDS/FOURNIS.PF` l.69 : `BLOQUE 1A` (`'B'`=bloqué)
- `src/QDDSSRC_DDS/FOURFA.PF` : clé `(CDSOC, CDFOU, RFAAA DESC, RFASEUIL)`, champs `RFATAUX 5S3`, `RFACAFOU 9S0`, `RFAOBTNU 9S0`, `RFASEUIL 9S0`
- Pattern identique à `client360.ts` `queryRfa()`

---

### Sous-tâche 6 — Bloc transport (`transport`) — `[x] done` (v3)

**Intent** : Retourner les conditions de transport fournisseur (depuis `FOURNIS`) et les frais de port agrégés N/N-1 (depuis `FLIVENT`).

**Sources** :
- `FOURNIS` — champs lus depuis le row ST1 déjà chargé : `CDTPORT`, `FTARIF`, `VALFRANC`, `PALFRANC`, `PDSFRANC`, `CARFRANC`, `LIVDLY`
- `FLIVENT` — `SUM(FRAIPORT)` + `SUM(FRAITRANS)` par année (en-tête BL fournisseur, filtré sur `CDSOC + CDFOU + LIVDATE`)

**Fonctions** :
- `mapTransportConditions(fournisRow)` — synchrone, lit les champs transport depuis le row FOURNIS déjà en mémoire
- `queryFrets(cdsoc, cdfou, annee, cdagel?, sessionId)` — `SUM(DOUBLE(COALESCE(FRAIPORT,0))) + SUM(DOUBLE(COALESCE(FRAITRANS,0)))` depuis `FLIVENT` avec `WHERE CDSOC=? AND CDFOU=? AND LIVDATE BETWEEN ? AND ?`

**Interfaces** :
- `Fournisseur360FretsYear` : `annee`, `frais_port`, `frais_transport`, `total`
- `Fournisseur360Transport` : `cdtport`, `type_port_lib`, `ftarif`, `ftarif_lib`, `franco_valeur`, `franco_palettes`, `franco_poids_kg`, `franco_cartons`, `delai_livraison_jours`, `frets_n`, `frets_n1`

**Note sur `FRAIPORT`/`FRAITRANS`** : champs `7P2` portés par `FLIVENT` (en-tête BL), pas par `FLIVLGN`. La SUM ne nécessite pas de JOIN sur les lignes — un seul GROUP BY sur FLIVENT suffit.

---

### Sous-tâche 7 — Assemblage + enregistrement MCP — `[x] done`

**Intent** : Assembler les 6 blocs, enregistrer dans `server.ts`, typecheck.

**Expected outcomes** :
- `getFournisseur360Tool(input)` retourne `Fournisseur360Result`
- Tool `get_fournisseur_360` enregistré dans `src/server.ts`
- `npm run typecheck && npm run build` passent sans erreur ✅

**Todo list** :
1. Écrire `getFournisseur360Tool(input)` :
   - `queryIdentite()` séquentiel (gate)
   - `Promise.all([queryAchatsYear(N), queryAchatsYear(N-1), queryTendance(), queryTopArticles(), queryRfa(), queryFrets(N), queryFrets(N-1)])`
   - `mapTransportConditions(fournisRow)` synchrone, assemblé après Promise.all
2. Enregistré dans `src/server.ts` avec schema Zod : `cdsoc` (string), `cdfou` (int positive), `annee` (optional), `cdagel` (string 2 car. optional)

**Relevant context** :
- `src/server.ts` l.355-400 — pattern `get_client_360` à dupliquer
- `src/tools/client360.ts` — structure complète à suivre

---

## Points de vigilance techniques

| Sujet | Règle |
|-------|-------|
| CDSOC | Obligatoire dans tout WHERE et JOIN ON |
| Dates LIVDATE | `8S 0` AAAAMMJJ — utiliser `INTEGER(LIVDATE/100)` pour grouper par AAAAMM |
| DOUBLE() | Obligatoire sur `PAUNIHT × PAREM × LIVQTE` pour éviter SQL0802 |
| NBRUNITE | `LEFT JOIN PARAM` sur `MOTCLE='UNITE-PV  '` + `CDPARM1=UNITPA` + `CDPARM2='          '` |
| Filtre ligne | `AND L.LIVQTE <> 0` uniquement (validé sur STAAF10R) |
| FLIVENT join | Clé composite : `L.CDSOC=E.CDSOC AND L.LIVNUMF=E.LIVNUMF AND L.CMDNUMF=E.CMDNUMF` |
| FFACENT | Ne contient PAS les montants — utiliser FLIVLGN uniquement (équivalent de CFACLGN) |
| Pas de FFACLGN | La facture fournisseur n'a pas de table de lignes — les montants sont dans FLIVLGN |

---

## Références

- Programme RPG de référence : `src/QRPGLESRC/STAAF10R.SQLRPGLE` (formule $EXTR_BR l.1360-1363)
- Tables sources : `FOURNIS.PF`, `FLIVENT.PF`, `FLIVLGN.PF`, `FOURFA.PF`, `PARAM.PF` (src/QDDSSRC_DDS/)
- Tool miroir implémenté : `src/tools/client360.ts`
- Règles SQL CA/marge : `docs/CALCUL_CA_MARGE.md`
