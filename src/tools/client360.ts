/**
 * Client 360° profile tool for groupe TINI (IBM i / DB2 for i)
 *
 * Returns a complete client profile in a single call, structured in 6 blocs:
 * - identite     : client identity from CLIENTS
 * - ca_n_n1      : CA HT + gross margin for year N and N-1 (CFACENT/CFACLGN/PARAM)
 * - tendance_mensuelle : 24-month CA+MB trend from CRMCAHT (pre-aggregated, no recalculation)
 * - top_articles : top 10 articles by CA from CRMCONSO (pivoted TypeScript-side)
 * - alertes      : outstanding balance, surveillance code, BIL block, RFA rate (CLIENTS+CLIRFA)
 * - transport    : shipping conditions from CLIENTS + delivery addresses from CLILIV + tour from TOURNEL
 *
 * Business rules:
 * - CDSOC mandatory in every WHERE and JOIN ON
 * - Dates: 8S 0 integer YYYYMMDD — never CURRENT_DATE in SQL
 * - DOUBLE() casts on all CA/margin arithmetic to prevent SQL0802
 * - Invoice lines: FACQTE <> 0 only, no FACETAT/LGRATUIT filter
 * - ADRNUM / $CODPDA / CDREP: aggregated globally in v1 (all addresses, all reps)
 * - annee: computed TypeScript-side via new Date().getFullYear() if not provided
 *
 * @see docs/MCP_PLAN_CLIENT360.md for full plan and v2 roadmap
 * @see src/tools/caMargin.ts for SQL formula reference (CA/margin constants)
 */

import { executeQuery } from '../db/connection.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger({ component: 'client360-tool' });

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

/** Input parameters */
export interface Client360Input {
  /** Society code (mandatory) */
  cdsoc: string;
  /** Client code (mandatory) */
  cdcli: number;
  /** Reference year for N/N-1 calculations — defaults to current year */
  annee?: number;
  /**
   * Optional delivery address number — filters CRMCAHT and CRMCONSO to a specific
   * client site/agency. When omitted, all addresses are aggregated (global client view).
   */
  adrnum?: number;
  /** Optional session ID for HTTP transport */
  sessionId?: string;
}

/** Client identity bloc */
export interface Client360Identite {
  raison: string;
  adress1: string;
  adress2: string;
  adress3: string;
  cdpost: string;
  ville: string;
  cdpays: string;
  siren: string;
  cdrep: string;
  cdcatcli: string;
  cdgroupe: string;
  clistat: string;
  inactif: string;
}

/** CA + margin for one year */
export interface Client360CaYear {
  annee: number;
  ca_ht: number;
  cout_achat_ht: number;
  marge_ht: number;
  taux_marge_pct: number | null;
}

/** CA N / N-1 comparison bloc */
export interface Client360CaN1 {
  annee_n: Client360CaYear;
  annee_n1: Client360CaYear;
}

/** One month in the trend series */
export interface Client360TrendMonth {
  annee: number;
  mois: number;
  ca_ht: number;
  mb_ht: number;
}

/** One article in the top-10 */
export interface Client360TopArticle {
  cdart: string;
  artlib: string;
  artfam: string;
  qte_livree: number;
  ca_ht: number;
  mb_ht: number;
  taux_marge_pct: number | null;
}

/** Alerts and risk indicators bloc */
export interface Client360Alertes {
  /** Total outstanding balance HT */
  enctot: number;
  /** Accounting outstanding balance */
  enccpt: number;
  /** Surveillance code: '1'=RAS '2'=A surveiller '3'=Bloqué '4'=Contentieux */
  cdsurv: string;
  /** Human-readable surveillance label */
  lib_surv: string;
  /** BIL block flag: 'B'=blocked */
  bilbloc: string;
  /** RFA rate for the reference year (null if none) */
  rfa_taux: number | null;
  /** RFA year (null if none) */
  rfa_annee: number | null;
}

/** One delivery address with its transport settings (from CLILIV + TOURNEL) */
export interface Client360AdresseLivraison {
  adrnum: number;
  raison: string;
  adress1: string;
  cdpost: string;
  ville: string;
  cdpays: string;
  cdtrnliv: string;
  /** Tour label from TOURNEL.LBTRNLIV (empty string if tour not found) */
  lbtrnliv: string;
  /** Transporter code from TOURNEL.CDTRANS */
  cdtrans: string;
  livdays: string;
  notrnliv: number;
  /** Delivery services flags */
  livrvl: string;
  livrmanu: string;
  livrdepo: string;
  livrrdv: string;
  livrpams: string;
  vfranco: number;
  inactif: string;
}

/** Transport conditions bloc */
export interface Client360Transport {
  /** Shipping type code (CLIENTS.CDTPORT) */
  cdtport: string;
  /** Free shipping threshold from CLIENTS (principal address) */
  vfranco: number;
  /** Main delivery tour code (CLIENTS.CDTRNLIV) */
  cdtrnliv: string;
  /** Main tour label from TOURNEL (empty if not found) */
  lbtrnliv: string;
  /** Main transporter code from TOURNEL */
  cdtrans: string;
  /** Main delivery days pattern (CLIENTS.LIVDAYS, 7A) */
  livdays: string;
  /** Delivery instructions (CLIENTS.ILIVRAIS) */
  ilivrais: string;
  /** Delivery remarks (CLIENTS.RLIVRAIS) */
  rlivrais: string;
  /** Delivery time windows (HHMM integers, 0 = not set) */
  horaires: {
    am_debut: number;
    am_fin: number;
    pm_debut: number;
    pm_fin: number;
  };
  /** Delivery service flags */
  services: {
    rdv: string;
    manutention: string;
    depotage: string;
    vl: string;
    livrpams: string;
  };
  /**
   * All active delivery addresses from CLILIV with per-address transport settings.
   * When adrnum is provided: single-element array for that address.
   * When absent: all active addresses.
   */
  adresses_livraison: Client360AdresseLivraison[];
}

/** Successful result */
export interface Client360Success {
  success: true;
  cdsoc: string;
  cdcli: number;
  annee: number;
  /** Filtered delivery address, or null when viewing the global client aggregate */
  adrnum: number | null;
  identite: Client360Identite;
  ca_n_n1: Client360CaN1;
  tendance_mensuelle: Client360TrendMonth[];
  top_articles: Client360TopArticle[];
  alertes: Client360Alertes;
  transport: Client360Transport;
}

/** Tool result */
export type Client360Result =
  | Client360Success
  | { success: false; error: string };

// ---------------------------------------------------------------------------
// SQL constants — copied from caMargin.ts to avoid circular imports
// DOUBLE() is mandatory: PVUNIHT(8,2) × PVREM(6,4) × FACQTE(10,2) overflows DB2 DECIMAL precision
// NBRUNITE: price is per N units (MILLE=1000, CENT=100) — must divide qty by NBRUNITE
// ---------------------------------------------------------------------------
const PV   = `DOUBLE(COALESCE(L.PVUNIHT,0))`;
const REM  = `DOUBLE(COALESCE(L.PVREM,0))`;
const PR   = `DOUBLE(COALESCE(L.PRUNIHT,0))`;
const QTE  = `DOUBLE(L.FACQTE)`;
const NBR  = `DOUBLE(COALESCE(NULLIF(CAST(TRIM(SUBSTR(P.PARDATA,1,5)) AS DECIMAL(7,0)),0),1))`;

const CA_EXPR   = `SUM(${PV} * (1 - ${REM} / 100) * ${QTE} / ${NBR})`;
const COUT_EXPR = `SUM(${PR} * ${QTE} / ${NBR})`;
const MB_EXPR   = `SUM((${PV} * (1 - ${REM} / 100) - ${PR}) * ${QTE} / ${NBR})`;
const TX_EXPR   = `CASE WHEN ${CA_EXPR} = 0 THEN NULL ELSE ROUND(${MB_EXPR} / ${CA_EXPR} * 100, 2) END`;

/** LEFT JOIN to resolve NBRUNITE from PARAM */
const PARAM_JOIN = `LEFT JOIN PARAM P
    ON  P.CDSOC   = L.CDSOC
    AND P.MOTCLE  = 'UNITE-PV  '
    AND P.CDPARM1 = L.UNITPV
    AND P.CDPARM2 = '          '`;

// ---------------------------------------------------------------------------
// ST1 — Identity
// ---------------------------------------------------------------------------

/** Raw row returned from CLIENTS */
type ClientsRow = Record<string, unknown>;

/**
 * Fetches client identity fields from CLIENTS.
 * Returns null if the client does not exist.
 */
async function queryIdentite(
  cdsoc: string,
  cdcli: number,
  sessionId?: string
): Promise<{ row: ClientsRow } | null> {
  const sql = `
    SELECT
      RAISON, ADRESS1, ADRESS2, ADRESS3, CDPOST, VILLE, CDPAYS,
      SIREN, CDREP, CDCATCLI, CDGROUPE, CLISTAT, INACTIF,
      ENCCPT, ENCTOT, CDSURV, BILBLOC,
      CDTPORT, VFRANCO, CDTRNLIV, NOTRNLIV, LIVDAYS,
      AMDTIMLIV, AMFTIMLIV, PMDTIMLIV, PMFTIMLIV,
      LIVRVL, LIVRMANU, LIVRDEPO, LIVRRDV, LIVRPAMS,
      ILIVRAIS, RLIVRAIS
    FROM CLIENTS
    WHERE CDSOC = ? AND CDCLI = ?
    FETCH FIRST 1 ROW ONLY`;
  const result = await executeQuery(sql, [cdsoc, cdcli], sessionId);
  if (result.rows.length === 0) return null;
  return { row: result.rows[0] };
}

/** Maps CLIENTS row to Client360Identite */
function mapIdentite(row: ClientsRow): Client360Identite {
  const s = (f: string) => String(row[f] ?? '').trim();
  return {
    raison:    s('RAISON'),
    adress1:   s('ADRESS1'),
    adress2:   s('ADRESS2'),
    adress3:   s('ADRESS3'),
    cdpost:    s('CDPOST'),
    ville:     s('VILLE'),
    cdpays:    s('CDPAYS'),
    siren:     s('SIREN'),
    cdrep:     s('CDREP'),
    cdcatcli:  s('CDCATCLI'),
    cdgroupe:  s('CDGROUPE'),
    clistat:   s('CLISTAT'),
    inactif:   s('INACTIF'),
  };
}

// ---------------------------------------------------------------------------
// ST2 — CA N / N-1
// ---------------------------------------------------------------------------

/** Builds YYYYMMDD integer date from year + MMDD suffix */
function yyyymmdd(annee: number, mmdd: number): number {
  return annee * 10000 + mmdd;
}

/** Fetches CA+margin for a single year, filtered on one client */
async function queryCanYear(
  cdsoc: string,
  cdcli: number,
  annee: number,
  sessionId?: string
): Promise<Client360CaYear> {
  const dateDebut = yyyymmdd(annee, 101);    // AAAA0101
  const dateFin   = yyyymmdd(annee, 1231);   // AAAA1231
  const sql = `
    SELECT
      ${CA_EXPR}   AS CA_HT,
      ${COUT_EXPR} AS COUT_ACHAT_HT,
      ${MB_EXPR}   AS MARGE_HT,
      ${TX_EXPR}   AS TAUX_MARGE_PCT
    FROM   CFACENT E
    JOIN   CFACLGN L ON L.CDSOC=E.CDSOC AND L.FACNUMC=E.FACNUMC
    ${PARAM_JOIN}
    WHERE  E.CDSOC  = ?
      AND  E.CDCLI  = ?
      AND  E.FACDATE BETWEEN ? AND ?
      AND  L.FACQTE <> 0`;
  const result = await executeQuery(sql, [cdsoc, cdcli, dateDebut, dateFin], sessionId);
  const row = result.rows[0] ?? {};
  const ca = Number(row.CA_HT ?? 0);
  const cout = Number(row.COUT_ACHAT_HT ?? 0);
  const mb   = Number(row.MARGE_HT ?? 0);
  const tx   = row.TAUX_MARGE_PCT != null ? Number(row.TAUX_MARGE_PCT) : null;
  return { annee, ca_ht: ca, cout_achat_ht: cout, marge_ht: mb, taux_marge_pct: tx };
}

// ---------------------------------------------------------------------------
// ST3 — 24-month trend calculated from CFACENT / CFACLGN
// ---------------------------------------------------------------------------

/**
 * Calculates the 24-month monthly trend of CA and margin.
 * When `adrnum` is provided, filters to that specific delivery address via CFACLIV.
 * Otherwise aggregates globally across all addresses.
 * Returns slots sorted most-recent first.
 */
async function queryTendanceMensuelle(
  cdsoc: string,
  cdcli: number,
  referenceYear: number,
  adrnum: number | undefined,
  sessionId?: string
): Promise<Client360TrendMonth[]> {
  let dateDebut: number;
  let dateFin: number;

  const now = new Date();
  const currentYear = now.getFullYear();

  if (referenceYear === currentYear) {
    const currentMonth = now.getMonth() + 1; // 1 to 12
    const lastDay = new Date(currentYear, currentMonth, 0).getDate();
    dateFin = currentYear * 10000 + currentMonth * 100 + lastDay;

    let startYear = currentYear - 2;
    let startMonth = currentMonth + 1;
    if (startMonth > 12) {
      startMonth -= 12;
      startYear += 1;
    }
    dateDebut = startYear * 10000 + startMonth * 100 + 1;
  } else {
    dateDebut = (referenceYear - 1) * 10000 + 101; // (referenceYear - 1)-01-01
    dateFin = referenceYear * 10000 + 1231;        // referenceYear-12-31
  }

  let sql: string;
  let binds: unknown[];

  if (adrnum !== undefined) {
    sql = `
      SELECT
        INTEGER(E.FACDATE / 10000) AS ANNEE,
        MOD(INTEGER(E.FACDATE / 100), 100) AS MOIS,
        ${CA_EXPR} AS CA_HT,
        ${MB_EXPR} AS MARGE_HT
      FROM CFACENT E
      JOIN CFACLGN L ON L.CDSOC = E.CDSOC AND L.FACNUMC = E.FACNUMC
      JOIN CFACLIV V ON V.CDSOC = E.CDSOC AND V.FACNUMC = E.FACNUMC AND V.CDCLI = E.CDCLI
      ${PARAM_JOIN}
      WHERE E.CDSOC = ?
        AND E.CDCLI = ?
        AND V.LIVADRNUM = ?
        AND E.FACDATE BETWEEN ? AND ?
        AND L.FACQTE <> 0
      GROUP BY
        INTEGER(E.FACDATE / 10000),
        MOD(INTEGER(E.FACDATE / 100), 100)
      ORDER BY ANNEE DESC, MOIS DESC`;
    binds = [cdsoc, cdcli, adrnum, dateDebut, dateFin];
  } else {
    sql = `
      SELECT
        INTEGER(E.FACDATE / 10000) AS ANNEE,
        MOD(INTEGER(E.FACDATE / 100), 100) AS MOIS,
        ${CA_EXPR} AS CA_HT,
        ${MB_EXPR} AS MARGE_HT
      FROM CFACENT E
      JOIN CFACLGN L ON L.CDSOC = E.CDSOC AND L.FACNUMC = E.FACNUMC
      ${PARAM_JOIN}
      WHERE E.CDSOC = ?
        AND E.CDCLI = ?
        AND E.FACDATE BETWEEN ? AND ?
        AND L.FACQTE <> 0
      GROUP BY
        INTEGER(E.FACDATE / 10000),
        MOD(INTEGER(E.FACDATE / 100), 100)
      ORDER BY ANNEE DESC, MOIS DESC`;
    binds = [cdsoc, cdcli, dateDebut, dateFin];
  }

  const result = await executeQuery(sql, binds, sessionId);
  
  const months: Client360TrendMonth[] = result.rows.map(row => ({
    annee: Number(row.ANNEE ?? 0),
    mois:  Number(row.MOIS ?? 0),
    ca_ht: Number(row.CA_HT ?? 0),
    mb_ht: Number(row.MARGE_HT ?? 0),
  }));

  // Defensive sort, most-recent first
  months.sort((a, b) => b.annee - a.annee || b.mois - a.mois);
  return months;
}

// ---------------------------------------------------------------------------
// ST4 — Top 10 articles from CRMCONSO
// ---------------------------------------------------------------------------

/** Accumulator per article during CRMCONSO pivot */
interface ArticleAccum {
  qte_livree: number;
  ca_ht: number;
  mb_ht: number;
}

/**
 * Reads CRMCONSO for the client and pivots 12 slots TypeScript-side.
 * When `adrnum` is provided, restricts to that delivery address.
 * Otherwise aggregates across all ADRNUM and $CODPDA (global client view).
 * Returns top 10 articles sorted by CA HT descending.
 */
async function queryTopArticles(
  cdsoc: string,
  cdcli: number,
  adrnum: number | undefined,
  sessionId?: string
): Promise<Client360TopArticle[]> {
  // 1 row per CDART × ADRNUM × $CODPDA — TypeScript accumulates by CDART
  const slotCols = Array.from({ length: 12 }, (_, i) => {
    const nn = String(i + 1).padStart(2, '0');
    return `WQLIV${nn}, WPVHT${nn}, WP100${nn}, WPRHT${nn}`;
  }).join(', ');

  const adrnumFilter = adrnum !== undefined ? 'AND ADRNUM = ?' : '';
  const sql = `
    SELECT CDART, ${slotCols}
    FROM CRMCONSO
    WHERE CDSOC = ? AND CDCLI = ? ${adrnumFilter}`;
  const binds: unknown[] = adrnum !== undefined ? [cdsoc, cdcli, adrnum] : [cdsoc, cdcli];

  const result = await executeQuery(sql, binds, sessionId);

  // Accumulate by CDART across all rows and slots
  const accum = new Map<string, ArticleAccum>();

  for (const row of result.rows) {
    const cdart = String(row.CDART ?? '').trim();
    if (!cdart) continue;

    const entry = accum.get(cdart) ?? { qte_livree: 0, ca_ht: 0, mb_ht: 0 };

    for (let i = 1; i <= 12; i++) {
      const nn  = String(i).padStart(2, '0');
      const qte = Number(row[`WQLIV${nn}`] ?? 0);
      const pv  = Number(row[`WPVHT${nn}`] ?? 0);
      const rem = Number(row[`WP100${nn}`] ?? 0);
      const pr  = Number(row[`WPRHT${nn}`] ?? 0);
      if (qte === 0) continue;

      const netPv = pv * (1 - rem / 100);
      entry.qte_livree += qte;
      entry.ca_ht      += netPv * qte;
      entry.mb_ht      += (netPv - pr) * qte;
    }
    accum.set(cdart, entry);
  }

  if (accum.size === 0) return [];

  // Sort by CA descending, keep top 10
  const sorted = [...accum.entries()]
    .sort(([, a], [, b]) => b.ca_ht - a.ca_ht)
    .slice(0, 10);

  const top10Arts = sorted.map(([cdart]) => cdart);

  // Enrich with ARTLIB + ARTFAM from ARTICLE table
  const placeholders = top10Arts.map(() => '?').join(',');
  const artSql = `
    SELECT CDART, ARTLIB, ARTFAM
    FROM ARTICLE
    WHERE CDSOC = ? AND CDART IN (${placeholders})`;
  const artResult = await executeQuery(artSql, [cdsoc, ...top10Arts], sessionId);

  const artMap = new Map<string, { artlib: string; artfam: string }>();
  for (const row of artResult.rows) {
    artMap.set(
      String(row.CDART ?? '').trim(),
      { artlib: String(row.ARTLIB ?? '').trim(), artfam: String(row.ARTFAM ?? '').trim() }
    );
  }

  return sorted.map(([cdart, acc]) => {
    const art = artMap.get(cdart) ?? { artlib: '', artfam: '' };
    const txMarge = acc.ca_ht === 0
      ? null
      : Math.round(acc.mb_ht / acc.ca_ht * 10000) / 100;
    return {
      cdart,
      artlib:          art.artlib,
      artfam:          art.artfam,
      qte_livree:      Math.round(acc.qte_livree * 100) / 100,
      ca_ht:           Math.round(acc.ca_ht * 100) / 100,
      mb_ht:           Math.round(acc.mb_ht * 100) / 100,
      taux_marge_pct:  txMarge,
    };
  });
}

// ---------------------------------------------------------------------------
// ST5 — Alerts
// ---------------------------------------------------------------------------

/** Maps CDSURV code to human-readable label */
function libSurv(cdsurv: string): string {
  switch (cdsurv.trim()) {
    case '1': return 'RAS';
    case '2': return 'À surveiller';
    case '3': return 'Bloqué';
    case '4': return 'Contentieux';
    default:  return cdsurv.trim() || 'Non renseigné';
  }
}

/**
 * Fetches the most recent RFA rate for this client, up to and including `annee`.
 * Returns null values if no RFA is defined.
 */
async function queryRfa(
  cdsoc: string,
  cdcli: number,
  annee: number,
  sessionId?: string
): Promise<{ rfa_taux: number | null; rfa_annee: number | null }> {
  const sql = `
    SELECT RFATAUX, RFAAA
    FROM CLIRFA
    WHERE CDSOC = ? AND CDCLI = ? AND RFAAA <= ?
    ORDER BY RFAAA DESC
    FETCH FIRST 1 ROW ONLY`;
  const result = await executeQuery(sql, [cdsoc, cdcli, annee], sessionId);
  if (result.rows.length === 0) return { rfa_taux: null, rfa_annee: null };
  const row = result.rows[0];
  return {
    rfa_taux:  row.RFATAUX != null ? Number(row.RFATAUX) : null,
    rfa_annee: row.RFAAA   != null ? Number(row.RFAAA)   : null,
  };
}

/** Builds the alertes bloc from the CLIENTS row and the RFA query result */
function mapAlertes(
  clientsRow: ClientsRow,
  rfa: { rfa_taux: number | null; rfa_annee: number | null }
): Client360Alertes {
  const cdsurv = String(clientsRow.CDSURV ?? '').trim();
  return {
    enctot:    Number(clientsRow.ENCTOT  ?? 0),
    enccpt:    Number(clientsRow.ENCCPT  ?? 0),
    cdsurv,
    lib_surv:  libSurv(cdsurv),
    bilbloc:   String(clientsRow.BILBLOC ?? '').trim(),
    rfa_taux:  rfa.rfa_taux,
    rfa_annee: rfa.rfa_annee,
  };
}

// ---------------------------------------------------------------------------
// Transport — delivery addresses + tour info
// ---------------------------------------------------------------------------

/**
 * Fetches delivery addresses from CLILIV, enriched with tour info from TOURNEL.
 * When adrnum is provided, returns only that address.
 * When absent, returns all active addresses (INACTIF <> 'I').
 * Tour label and transporter are resolved via LEFT JOIN TOURNEL on CDTRNLIV.
 */
async function queryTransport(
  cdsoc: string,
  cdcli: number,
  clientsRow: ClientsRow,
  adrnum: number | undefined,
  sessionId?: string
): Promise<Client360Transport> {
  const s = (f: string) => String(clientsRow[f] ?? '').trim();

  // Build the main tour info (from CLIENTS row) — enrich with TOURNEL
  const cdtrnlivPrincipal = s('CDTRNLIV');
  let lbtrnlivPrincipal = '';
  let cdtransPrincipal  = '';

  if (cdtrnlivPrincipal) {
    const tourSql = `
      SELECT LBTRNLIV, CDTRANS
      FROM TOURNEL
      WHERE CDSOC = ? AND CDTRNLIV = ?
      FETCH FIRST 1 ROW ONLY`;
    const tourResult = await executeQuery(tourSql, [cdsoc, cdtrnlivPrincipal], sessionId);
    if (tourResult.rows.length > 0) {
      lbtrnlivPrincipal = String(tourResult.rows[0].LBTRNLIV ?? '').trim();
      cdtransPrincipal  = String(tourResult.rows[0].CDTRANS  ?? '').trim();
    }
  }

  // Fetch delivery addresses from CLILIV
  const adrnumFilter = adrnum !== undefined ? 'AND C.ADRNUM = ?' : "AND C.INACTIF <> 'I'";
  const adrnumBinds: unknown[] = adrnum !== undefined ? [adrnum] : [];

  const adressesSql = `
    SELECT
      C.ADRNUM, C.RAISON, C.ADRESS1, C.CDPOST, C.VILLE, C.CDPAYS,
      C.CDTRNLIV, C.NOTRNLIV, C.LIVDAYS, C.VFRANCO,
      C.LIVRVL, C.LIVRMANU, C.LIVRDEPO, C.LIVRRDV, C.LIVRPAMS, C.INACTIF,
      COALESCE(T.LBTRNLIV, '') AS LBTRNLIV,
      COALESCE(T.CDTRANS,  '') AS CDTRANS
    FROM CLILIV C
    LEFT JOIN TOURNEL T
      ON  T.CDSOC    = C.CDSOC
      AND T.CDTRNLIV = C.CDTRNLIV
    WHERE C.CDSOC = ? AND C.CDCLI = ?
      ${adrnumFilter}
    ORDER BY C.ADRNUM`;

  const adressesBind: unknown[] = [cdsoc, cdcli, ...adrnumBinds];
  const adressesResult = await executeQuery(adressesSql, adressesBind, sessionId);

  const adresses: Client360AdresseLivraison[] = adressesResult.rows.map(row => ({
    adrnum:    Number(row.ADRNUM   ?? 0),
    raison:    String(row.RAISON   ?? '').trim(),
    adress1:   String(row.ADRESS1  ?? '').trim(),
    cdpost:    String(row.CDPOST   ?? '').trim(),
    ville:     String(row.VILLE    ?? '').trim(),
    cdpays:    String(row.CDPAYS   ?? '').trim(),
    cdtrnliv:  String(row.CDTRNLIV ?? '').trim(),
    lbtrnliv:  String(row.LBTRNLIV ?? '').trim(),
    cdtrans:   String(row.CDTRANS  ?? '').trim(),
    livdays:   String(row.LIVDAYS  ?? '').trim(),
    notrnliv:  Number(row.NOTRNLIV ?? 0),
    livrvl:    String(row.LIVRVL   ?? '').trim(),
    livrmanu:  String(row.LIVRMANU ?? '').trim(),
    livrdepo:  String(row.LIVRDEPO ?? '').trim(),
    livrrdv:   String(row.LIVRRDV  ?? '').trim(),
    livrpams:  String(row.LIVRPAMS ?? '').trim(),
    vfranco:   Number(row.VFRANCO  ?? 0),
    inactif:   String(row.INACTIF  ?? '').trim(),
  }));

  return {
    cdtport:   s('CDTPORT'),
    vfranco:   Number(clientsRow.VFRANCO ?? 0),
    cdtrnliv:  cdtrnlivPrincipal,
    lbtrnliv:  lbtrnlivPrincipal,
    cdtrans:   cdtransPrincipal,
    livdays:   s('LIVDAYS'),
    ilivrais:  s('ILIVRAIS'),
    rlivrais:  s('RLIVRAIS'),
    horaires: {
      am_debut: Number(clientsRow.AMDTIMLIV ?? 0),
      am_fin:   Number(clientsRow.AMFTIMLIV ?? 0),
      pm_debut: Number(clientsRow.PMDTIMLIV ?? 0),
      pm_fin:   Number(clientsRow.PMFTIMLIV ?? 0),
    },
    services: {
      rdv:         s('LIVRRDV'),
      manutention: s('LIVRMANU'),
      depotage:    s('LIVRDEPO'),
      vl:          s('LIVRVL'),
      livrpams:    s('LIVRPAMS'),
    },
    adresses_livraison: adresses,
  };
}

// ---------------------------------------------------------------------------
// Main tool handler
// ---------------------------------------------------------------------------

/**
 * Returns a complete 360° client profile.
 *
 * Orchestration:
 * 1. queryIdentite  — fetches CLIENTS row (mandatory gate)
 * 2. Promise.all — parallel: ca_n, ca_n1, tendance, top_articles, rfa
 *
 * @param input - cdsoc, cdcli, optional annee, adrnum, and sessionId
 */
export async function getClient360Tool(input: Client360Input): Promise<Client360Result> {
  const { cdsoc, cdcli, sessionId, adrnum } = input;
  const annee = input.annee ?? new Date().getFullYear();

  log.debug({ cdsoc, cdcli, annee, adrnum }, 'Starting client 360 query');

  // Step 1: identity (also populates alertes fields from the same row)
  let clientRow: { row: ClientsRow } | null;
  try {
    clientRow = await queryIdentite(cdsoc, cdcli, sessionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    log.debug({ err }, 'queryIdentite failed');
    return { success: false, error: `Erreur identité client: ${msg}` };
  }

  if (clientRow === null) {
    return { success: false, error: `Client ${cdcli} introuvable pour la société ${cdsoc}` };
  }

  const identite = mapIdentite(clientRow.row);

  // Step 2: parallel queries
  let canN: Client360CaYear;
  let canN1: Client360CaYear;
  let tendance: Client360TrendMonth[];
  let topArticles: Client360TopArticle[];
  let rfa: { rfa_taux: number | null; rfa_annee: number | null };
  let transport: Client360Transport;

  try {
    [canN, canN1, tendance, topArticles, rfa, transport] = await Promise.all([
      queryCanYear(cdsoc, cdcli, annee,     sessionId),
      queryCanYear(cdsoc, cdcli, annee - 1, sessionId),
      queryTendanceMensuelle(cdsoc, cdcli, annee, adrnum, sessionId),
      queryTopArticles(cdsoc, cdcli, adrnum, sessionId),
      queryRfa(cdsoc, cdcli, annee, sessionId),
      queryTransport(cdsoc, cdcli, clientRow.row, adrnum, sessionId),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    log.debug({ err }, 'Parallel client360 queries failed');
    return { success: false, error: `Erreur données client: ${msg}` };
  }

  const alertes = mapAlertes(clientRow.row, rfa);

  log.info({ cdsoc, cdcli, annee, adrnum, tendance_count: tendance.length, top_articles_count: topArticles.length }, 'Client 360 completed');

  return {
    success: true,
    cdsoc,
    cdcli,
    annee,
    adrnum: adrnum ?? null,
    identite,
    ca_n_n1: { annee_n: canN, annee_n1: canN1 },
    tendance_mensuelle: tendance,
    top_articles: topArticles,
    alertes,
    transport,
  };
}
