# Plan d'Implémentation — Outil MCP `calculate_ca_marge`
## Serveur : `mcp-server-db2i` (`/Users/vrn/Antigravity/mcp-server-db2i`)

---

## 1. Résumé

Ajouter un outil MCP nommé **`calculate_ca_marge`** au serveur `mcp-server-db2i`.  
Il exécute des requêtes SQL DB2 for i sur les sociétés du groupe TINI pour retourner le chiffre d'affaires HT, le coût d'achat, la marge brute et le taux de marge, selon 3 axes : société, client, article.

Référence métier complète : [`docs/CALCUL_CA_MARGE.md`](./CALCUL_CA_MARGE.md)

---

## 2. Interface de l'outil

### Nom
```
calculate_ca_marge
```

### Description (pour le LLM)
```
Calcule le chiffre d'affaires HT et la marge brute sur les factures clients
des sociétés du groupe TINI (IBM i / DB2 for i).
Supporte 3 axes : par société, par client, par article.
Filtre obligatoire : période (date_debut + date_fin au format YYYYMMDD).
```

### Paramètres d'entrée

| Paramètre    | Type                          | Requis | Description                                                   |
|--------------|-------------------------------|--------|---------------------------------------------------------------|
| `axis`       | `enum: society\|client\|article` | ✅  | Axe d'agrégation                                              |
| `date_debut` | `string` (YYYYMMDD)           | ✅     | Date de début de période                                      |
| `date_fin`   | `string` (YYYYMMDD)           | ✅     | Date de fin de période                                        |
| `cdsoc`      | `string \| string[]`          | ❌     | Code(s) société. Défaut : toutes les sociétés du groupe       |
| `cdcli`      | `number`                      | ❌     | Filtre optionnel sur un client spécifique (axis=client)       |
| `cdart`      | `string`                      | ❌     | Filtre optionnel sur un article spécifique (axis=article)     |
| `limit`      | `number`                      | ❌     | Nombre maximum de lignes retournées. Défaut : 100             |
| `order_by`   | `enum: ca\|marge\|taux_marge` | ❌     | Tri du résultat. Défaut : `ca`                                |

### Structure de retour

```typescript
{
  axis: "society" | "client" | "article",
  period: { date_debut: string; date_fin: string },
  rows: Array<{
    cdsoc: string;
    cdcli?: number;
    raison?: string;
    cdrep?: string;
    cdart?: string;
    artlib?: string;
    artfam?: string;
    qte_facturee?: number;
    ca_ht: number;
    cout_achat_ht: number;
    marge_ht: number;
    taux_marge_pct: number | null;
  }>;
  totals: {
    ca_ht: number;
    cout_achat_ht: number;
    marge_ht: number;
    taux_marge_pct: number | null;
  };
  row_count: number;
}
```

---

## 3. Architecture du Serveur MCP

Avant de coder, inspecter la structure du serveur existant :

```
/Users/vrn/Antigravity/mcp-server-db2i/
├── src/
│   ├── index.ts          ← point d'entrée, enregistrement des outils
│   ├── tools/            ← un fichier par outil (à créer si inexistant)
│   │   └── calculate_ca_marge.ts   ← NOUVEAU FICHIER
│   └── db.ts (ou similaire)        ← client DB2 / connexion IBM i
├── package.json
└── tsconfig.json
```

> ⚠️ Adapter les chemins d'import selon la structure réelle trouvée dans le serveur.

---

## 4. Étapes d'Implémentation

### Étape 1 — Inspecter le serveur existant
- Lire `package.json` pour identifier le framework MCP utilisé (SDK officiel `@modelcontextprotocol/sdk` ou autre)
- Lire `src/index.ts` pour comprendre le pattern d'enregistrement des outils existants
- Identifier le module de connexion DB2 (ex: `idb-connector`, `odbc`, appel HTTP à un service IBM i)

### Étape 2 — Créer `src/tools/calculate_ca_marge.ts`

```typescript
import { z } from "zod";

/** Sociétés du groupe TINI */
const TINI_SOCIETES = ['01','03','11','12','14','15','17','18','19','23'] as const;

/** Schéma de validation des paramètres d'entrée */
export const schema = z.object({
  axis:       z.enum(["society", "client", "article"]),
  date_debut: z.string().regex(/^\d{8}$/, "Format YYYYMMDD requis"),
  date_fin:   z.string().regex(/^\d{8}$/, "Format YYYYMMDD requis"),
  cdsoc:      z.union([z.string(), z.array(z.string())]).optional(),
  cdcli:      z.number().int().positive().optional(),
  cdart:      z.string().max(10).optional(),
  limit:      z.number().int().min(1).max(1000).default(100),
  order_by:   z.enum(["ca", "marge", "taux_marge"]).default("ca"),
});

/** Construit la requête SQL selon l'axe demandé */
function buildQuery(params: z.infer<typeof schema>): { sql: string; binds: unknown[] } {
  const societes = params.cdsoc
    ? (Array.isArray(params.cdsoc) ? params.cdsoc : [params.cdsoc])
    : [...TINI_SOCIETES];

  const socPlaceholders = societes.map(() => "?").join(",");
  const binds: unknown[] = [...societes, params.date_debut, params.date_fin];

  // Colonnes communes et expression de marge
  const CA_EXPR   = `SUM(L.PVUNIHT*(1-L.PVREM/100)*L.FACQTE)`;
  const COUT_EXPR = `SUM(L.PRUNIHT*L.FACQTE)`;
  const MB_EXPR   = `SUM((L.PVUNIHT*(1-L.PVREM/100)-L.PRUNIHT)*L.FACQTE)`;
  const TX_EXPR   = `CASE WHEN ${CA_EXPR}=0 THEN NULL ELSE ROUND(${MB_EXPR}/${CA_EXPR}*100,2) END`;

  const ORDER_MAP = { ca: `${CA_EXPR} DESC`, marge: `${MB_EXPR} DESC`, taux_marge: `${TX_EXPR} DESC` };
  const orderClause = ORDER_MAP[params.order_by];

  if (params.axis === "society") {
    return {
      sql: `
        SELECT E.CDSOC,
               ${CA_EXPR}   AS CA_HT,
               ${COUT_EXPR} AS COUT_ACHAT_HT,
               ${MB_EXPR}   AS MARGE_HT,
               ${TX_EXPR}   AS TAUX_MARGE_PCT
        FROM   CFACENT E
        JOIN   CFACLGN L ON L.CDSOC=E.CDSOC AND L.FACNUMC=E.FACNUMC
        WHERE  E.CDSOC IN (${socPlaceholders})
          AND  E.FACETAT IN ('E','C')
          AND  E.FACDATE BETWEEN ? AND ?
          AND  L.LGRATUIT <> 'O'
        GROUP  BY E.CDSOC
        ORDER  BY ${orderClause}
        FETCH FIRST ${params.limit} ROWS ONLY`,
      binds,
    };
  }

  if (params.axis === "client") {
    if (params.cdcli) binds.push(params.cdcli);
    return {
      sql: `
        SELECT E.CDSOC, E.CDCLI, C.RAISON, C.CDREP,
               ${CA_EXPR}   AS CA_HT,
               ${COUT_EXPR} AS COUT_ACHAT_HT,
               ${MB_EXPR}   AS MARGE_HT,
               ${TX_EXPR}   AS TAUX_MARGE_PCT
        FROM   CFACENT E
        JOIN   CFACLGN L ON L.CDSOC=E.CDSOC AND L.FACNUMC=E.FACNUMC
        JOIN   CLIENTS C  ON C.CDSOC=E.CDSOC AND C.CDCLI=E.CDCLI
        WHERE  E.CDSOC IN (${socPlaceholders})
          AND  E.FACETAT IN ('E','C')
          AND  E.FACDATE BETWEEN ? AND ?
          AND  L.LGRATUIT <> 'O'
          ${params.cdcli ? `AND E.CDCLI = ?` : ""}
        GROUP  BY E.CDSOC, E.CDCLI, C.RAISON, C.CDREP
        ORDER  BY ${orderClause}
        FETCH FIRST ${params.limit} ROWS ONLY`,
      binds,
    };
  }

  // axis === "article"
  if (params.cdart) binds.push(params.cdart);
  return {
    sql: `
      SELECT L.CDSOC, L.CDART, A.ARTLIB, A.ARTFAM,
             SUM(L.FACQTE) AS QTE_FACTUREE,
             ${CA_EXPR}    AS CA_HT,
             ${COUT_EXPR}  AS COUT_ACHAT_HT,
             ${MB_EXPR}    AS MARGE_HT,
             ${TX_EXPR}    AS TAUX_MARGE_PCT
      FROM   CFACLGN L
      JOIN   CFACENT E ON E.CDSOC=L.CDSOC AND E.FACNUMC=L.FACNUMC
      JOIN   ARTICLE A ON A.CDSOC=L.CDSOC AND A.CDART=L.CDART
      WHERE  L.CDSOC IN (${socPlaceholders})
        AND  E.FACETAT IN ('E','C')
        AND  E.FACDATE BETWEEN ? AND ?
        AND  L.LGRATUIT <> 'O'
        ${params.cdart ? `AND L.CDART = ?` : ""}
      GROUP  BY L.CDSOC, L.CDART, A.ARTLIB, A.ARTFAM
      ORDER  BY ${orderClause}
      FETCH FIRST ${params.limit} ROWS ONLY`,
    binds,
  };
}
```

### Étape 3 — Enregistrer l'outil dans `src/index.ts`

Suivre le pattern des outils existants. Exemple générique avec le SDK MCP officiel :

```typescript
import { schema as caMargSchema, buildQuery } from "./tools/calculate_ca_marge.js";

server.registerTool("calculate_ca_marge", {
  description: "Calcule CA HT et marge brute par société/client/article (groupe TINI, DB2 for i)",
  inputSchema: zodToJsonSchema(caMargSchema),
  handler: async (params) => {
    const validated = caMargSchema.parse(params);
    const { sql, binds } = buildQuery(validated);
    const rows = await db.query(sql, binds);

    // Calcul des totaux
    const totals = rows.reduce((acc, r) => ({
      ca_ht:        acc.ca_ht        + (r.CA_HT ?? 0),
      cout_achat_ht:acc.cout_achat_ht + (r.COUT_ACHAT_HT ?? 0),
      marge_ht:     acc.marge_ht     + (r.MARGE_HT ?? 0),
    }), { ca_ht: 0, cout_achat_ht: 0, marge_ht: 0 });

    return {
      axis: validated.axis,
      period: { date_debut: validated.date_debut, date_fin: validated.date_fin },
      rows: rows.map(r => ({ /* mapper les colonnes en camelCase */ })),
      totals: {
        ...totals,
        taux_marge_pct: totals.ca_ht === 0 ? null :
          Math.round(totals.marge_ht / totals.ca_ht * 10000) / 100,
      },
      row_count: rows.length,
    };
  },
});
```

### Étape 4 — Tests

Exemples d'invocations à valider :

```json
// CA par société, année en cours
{ "axis": "society", "date_debut": "20260101", "date_fin": "20261231" }

// Top 20 clients BBA sur Q1 2026, trié par marge
{ "axis": "client", "cdsoc": "01", "date_debut": "20260101",
  "date_fin": "20260331", "order_by": "marge", "limit": 20 }

// Top 50 articles toutes sociétés
{ "axis": "article", "date_debut": "20260101", "date_fin": "20261231", "limit": 50 }

// Un client spécifique
{ "axis": "client", "cdsoc": "01", "cdcli": 12345,
  "date_debut": "20260101", "date_fin": "20261231" }
```

### Étape 5 — Build & reconfiguration Bob

```bash
cd /Users/vrn/Antigravity/mcp-server-db2i
npm run build        # ou tsc / bun build selon le projet
```

Vérifier que le serveur MCP est bien référencé dans la configuration Bob (`.vscode/mcp.json` ou `~/.config/bob/mcp.json`).

---

## 5. Points d'Attention

| Sujet | Action |
|-------|--------|
| **CDSOC dans tous les JOIN** | Vérifié dans les 3 requêtes SQL ci-dessus |
| **Dates `8S 0`** | Paramètres `date_debut`/`date_fin` passés directement comme entiers |
| **Avoirs** | Inclus automatiquement (montants négatifs), pas de filtre spécial |
| **NBRUNITE** | ⚠️ **Obligatoire** — sans diviseur, le CA peut être jusqu'à 10 000× trop grand. `LEFT JOIN PARAM P` sur `MOTCLE='UNITE-PV  '`, PARDATA positions 1-5, fallback=1. Voir `caMargin.ts` pour l'expression exacte. |
| **LGRATUIT** | ❌ **Pas de filtre** — les programmes RPG ne filtrent pas sur ce champ. Lignes gratuites ont PVUNIHT=0 → CA=0 naturellement. |
| **FACETAT** | ❌ **Pas de filtre** — les programmes RPG ne filtrent pas sur l'état de la facture. |
| **FACQTE** | ✅ `AND L.FACQTE <> 0` — seul filtre de ligne appliqué (identique à STAVC10R) |
| **DOUBLE()** | ✅ Obligatoire sur tous les calculs CA/marge pour éviter SQL0802 |
| **Performance** | `FETCH FIRST n ROWS ONLY` + index sur FACDATE recommandé |

---

> ⚠️ **Le SQL de l'étape 2 ci-dessus est un exemple de plan initial** — il contient des filtres
> `FACETAT IN ('E','C')` et `LGRATUIT <> 'O'` qui ont été **invalidés** lors de la confrontation
> avec les programmes RPG. L'implémentation finale dans `caMargin.ts` n'applique **pas** ces filtres.
> Se référer à `src/tools/caMargin.ts` pour le SQL de référence validé.

---

## 6. État d'implémentation

| Fichier | Statut |
|---------|--------|
| `src/tools/caMargin.ts` | ✅ Livré et validé |
| `src/server.ts` | ✅ Tool `calculate_ca_marge` enregistré |

*Document créé le 2026-06-21 — mis à jour le 2026-06-24*
*Référence métier : [`docs/CALCUL_CA_MARGE.md`](./CALCUL_CA_MARGE.md)*
