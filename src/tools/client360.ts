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
  tvacee: string;
}

/** CA + margin for one year */
export interface Client360CaYear {
  annee: number;
  ca_ht: string;
  cout_achat_ht: string;
  marge_ht: string;
  taux_marge_pct: string | null;
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
  ca_ht: string;
  mb_ht: string;
}

/** Metrics for a specific period of an article */
export interface Client360TopArticleMetrics {
  qte_livree: number;
  ca_ht: string;
  mb_ht: string;
  taux_marge_pct: string | null;
}

/** One article in the top-10 */
export interface Client360TopArticle {
  cdart: string;
  artlib: string;
  artfam: string;
  annee_n: Client360TopArticleMetrics;
  annee_n1: Client360TopArticleMetrics;
  annee_n1_ytd: Client360TopArticleMetrics;
  annee_n2: Client360TopArticleMetrics;
  annee_n2_ytd: Client360TopArticleMetrics;
}

/** Alerts and risk indicators bloc */
export interface Client360Alertes {
  /** Total outstanding balance HT */
  enctot: string;
  /** Accounting outstanding balance */
  enccpt: string;
  /** Surveillance code: '1'=RAS '2'=A surveiller '3'=Bloqué '4'=Contentieux */
  cdsurv: string;
  /** Human-readable surveillance label */
  lib_surv: string;
  /** BIL block flag: 'B'=blocked */
  bilbloc: string;
  /** RFA rate for the reference year (null if none) */
  rfa_taux: string | null;
  /** RFA year (null if none) */
  rfa_annee: number | null;
}

/** Metrics for shipping costs on a specific period */
export interface Client360FraisPortMetrics {
  facture: string;
  depense: string;
  depense_moyen: string;
  nb_livraisons: number;
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
  /** Total active delivery sites */
  total_sites: number;
  /** Sites count by French department key (2 digits, or 'Autre') sorted */
  sites_par_departement: { departement: string; quantite: number }[];
  /** Comparative shipping costs metrics */
  frais_port: {
    annee_n: Client360FraisPortMetrics;
    annee_n1: Client360FraisPortMetrics;
    annee_n1_ytd: Client360FraisPortMetrics;
  };
}

/** One open order in progress */
export interface Client360CommandeEnCours {
  cmdnumc: number;
  cmddate: number;
  dmddate: number;
  cmdref: string;
  cmdetat: string;
  montant_ht: string;
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
  commandes_en_cours: Client360CommandeEnCours[];
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

function formatPrenom(str: string): string {
  return str.toLowerCase().replace(/(?:^|[- ])\p{L}/gu, match => match.toUpperCase());
}

function formatRepres(cdrep: string, pardata: string): string {
  const code = cdrep.trim();
  if (!code) return '';
  const emailPart = pardata.substring(20).trim();
  const emailMatch = emailPart.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/);
  if (emailMatch) {
    const email = emailMatch[1];
    const localPart = email.split('@')[0];
    const nameParts = localPart.split('.');
    
    let prenom = nameParts[0] || '';
    prenom = formatPrenom(prenom);

    const nom = (nameParts[1] || '').toUpperCase();

    const formattedName = `${prenom} ${nom}`.trim();
    return `${formattedName} (${code})`;
  }
  return code;
}

function formatSiren(siren: string): string {
  const s = siren.replace(/\s+/g, '');
  if (s.length === 9) {
    return `${s.substring(0, 3)} ${s.substring(3, 6)} ${s.substring(6, 9)}`;
  }
  return siren;
}

function translateCountry(code: string): string {
  const c = code.trim();
  const dict: Record<string, string> = {
    '001': 'France',
    '094': 'Serbie',
    '101': 'Danemark',
    '102': 'Islande',
    '103': 'Norvège',
    '104': 'Suède',
    '105': 'Finlande',
    '106': 'Estonie',
    '107': 'Lettonie',
    '108': 'Lituanie',
    '109': 'Allemagne',
    '110': 'Autriche',
    '111': 'Bulgarie',
    '112': 'Hongrie',
    '113': 'Liechtenstein',
    '114': 'Roumanie',
    '115': 'République Tchèque',
    '116': 'Slovaquie',
    '119': 'Croatie',
    '150': 'Belgique',
    '151': 'Luxembourg',
    '152': 'Pays-Bas',
    '153': 'Italie',
    '154': 'Espagne',
    '155': 'Portugal',
    '156': 'Royaume-Uni',
    '157': 'Suisse',
  };
  return dict[c] || c;
}

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
      C.RAISON, C.ADRESS1, C.ADRESS2, C.ADRESS3, C.CDPOST, C.VILLE, C.CDPAYS,
      C.SIREN, C.CDREP, C.CDCATCLI, C.CDGROUPE, C.CLISTAT, C.INACTIF, C.TVACEE,
      C.ENCCPT, C.ENCTOT, C.CDSURV, C.BILBLOC,
      C.CDTPORT, C.VFRANCO, C.CDTRNLIV, C.NOTRNLIV, C.LIVDAYS,
      C.AMDTIMLIV, C.AMFTIMLIV, C.PMDTIMLIV, C.PMFTIMLIV,
      C.LIVRVL, C.LIVRMANU, C.LIVRDEPO, C.LIVRRDV, C.LIVRPAMS,
      C.ILIVRAIS, C.RLIVRAIS,
      P_REP.PARDATA AS REP_PARDATA,
      P_CAT.PARLIBL AS CAT_LIBELLE
    FROM CLIENTS C
    LEFT JOIN PARAM P_REP
      ON  P_REP.CDSOC   = C.CDSOC
      AND P_REP.MOTCLE  = 'REPRES'
      AND P_REP.CDPARM1 = C.CDREP
      AND P_REP.CDPARM2 = '          '
    LEFT JOIN PARAM P_CAT
      ON  P_CAT.CDSOC   = C.CDSOC
      AND P_CAT.MOTCLE  = 'CATEG-CLI'
      AND P_CAT.CDPARM1 = C.CDCATCLI
      AND P_CAT.CDPARM2 = '          '
    WHERE C.CDSOC = ? AND C.CDCLI = ?
    FETCH FIRST 1 ROW ONLY`;
  const result = await executeQuery(sql, [cdsoc, cdcli], sessionId);
  if (result.rows.length === 0) return null;
  return { row: result.rows[0] };
}

/** Maps CLIENTS row to Client360Identite */
function mapIdentite(row: ClientsRow): Client360Identite {
  const s = (f: string) => String(row[f] ?? '').trim();
  
  const rawSiren = s('SIREN');
  const formattedSiren = formatSiren(rawSiren);
  const country = translateCountry(s('CDPAYS'));

  const rawRep = s('CDREP');
  const repParData = s('REP_PARDATA');
  const representative = formatRepres(rawRep, repParData);

  const rawCat = s('CDCATCLI');
  const catLibelle = s('CAT_LIBELLE');
  const category = catLibelle ? `${rawCat} - ${catLibelle}` : rawCat;

  return {
    raison:    s('RAISON'),
    adress1:   s('ADRESS1'),
    adress2:   s('ADRESS2'),
    adress3:   s('ADRESS3'),
    cdpost:    s('CDPOST'),
    ville:     s('VILLE'),
    cdpays:    country,
    siren:     formattedSiren,
    cdrep:     representative,
    cdcatcli:  category,
    cdgroupe:  s('CDGROUPE'),
    clistat:   s('CLISTAT'),
    inactif:   s('INACTIF'),
    tvacee:    s('TVACEE'),
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
  return {
    annee,
    ca_ht:         ca.toFixed(2),
    cout_achat_ht: cout.toFixed(2),
    marge_ht:      mb.toFixed(2),
    taux_marge_pct: tx !== null ? tx.toFixed(2) : null,
  };
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
    ca_ht: Number(row.CA_HT ?? 0).toFixed(2),
    mb_ht: Number(row.MARGE_HT ?? 0).toFixed(2),
  }));

  // Defensive sort, most-recent first
  months.sort((a, b) => b.annee - a.annee || b.mois - a.mois);
  return months;
}

function translateArtFam(code: string): string {
  const c = code.toUpperCase().trim();
  const dict: Record<string, string> = {
    'ADH':   'Adhésifs',
    'ADHD':  'Adhésifs double-face',
    'ADHT':  'Adhésifs techniques',
    'CD':    'Cartons et caisses',
    'FITA':  'Film machine',
    'FITE':  'Film étirable',
    'FITES': 'Film manuel',
    'PL':    'Palettes',
    'COLLE': 'Colles',
  };
  return dict[c] || c;
}

// ---------------------------------------------------------------------------
// ST4 — Top 10 articles calculated from CFACENT / CFACLGN
// ---------------------------------------------------------------------------

/**
 * Calculates the top 10 articles consumed by the client over the last 24 months.
 * When `adrnum` is provided, restricts to that delivery address via CFACLIV.
 * Otherwise aggregates globally across all addresses.
 * Returns top 10 articles sorted by CA HT descending.
 */
async function queryTopArticles(
  cdsoc: string,
  cdcli: number,
  referenceYear: number,
  adrnum: number | undefined,
  sessionId?: string
): Promise<Client360TopArticle[]> {
  const now = new Date();
  const currentMonth = now.getMonth() + 1; // 1 to 12

  // 1. Calculate boundaries of N-2 to N (from Jan 1st of N-2 to Dec 31st of N)
  const dateDebut = (referenceYear - 2) * 10000 + 101; // (N-2)-01-01
  const dateFin = referenceYear * 10000 + 1231;        // N-12-31

  // 2. Identify the top 10 articles by CA HT on the 3-year window
  let top10Sql: string;
  let top10Binds: unknown[];

  if (adrnum !== undefined) {
    top10Sql = `
      SELECT L.CDART, ${CA_EXPR} AS CA_HT
      FROM CFACLGN L
      JOIN CFACENT E ON E.CDSOC = L.CDSOC AND E.FACNUMC = L.FACNUMC
      JOIN CFACLIV V ON V.CDSOC = E.CDSOC AND V.FACNUMC = E.FACNUMC AND V.CDCLI = E.CDCLI
      ${PARAM_JOIN}
      WHERE E.CDSOC = ?
        AND E.CDCLI = ?
        AND V.LIVADRNUM = ?
        AND E.FACDATE BETWEEN ? AND ?
        AND L.FACQTE <> 0
      GROUP BY L.CDART
      ORDER BY CA_HT DESC
      FETCH FIRST 10 ROWS ONLY`;
    top10Binds = [cdsoc, cdcli, adrnum, dateDebut, dateFin];
  } else {
    top10Sql = `
      SELECT L.CDART, ${CA_EXPR} AS CA_HT
      FROM CFACLGN L
      JOIN CFACENT E ON E.CDSOC = L.CDSOC AND E.FACNUMC = L.FACNUMC
      ${PARAM_JOIN}
      WHERE E.CDSOC = ?
        AND E.CDCLI = ?
        AND E.FACDATE BETWEEN ? AND ?
        AND L.FACQTE <> 0
      GROUP BY L.CDART
      ORDER BY CA_HT DESC
      FETCH FIRST 10 ROWS ONLY`;
    top10Binds = [cdsoc, cdcli, dateDebut, dateFin];
  }

  const top10Result = await executeQuery(top10Sql, top10Binds, sessionId);
  if (top10Result.rows.length === 0) return [];

  const top10Arts = top10Result.rows
    .map(row => String(row.CDART ?? '').trim())
    .filter(Boolean);

  if (top10Arts.length === 0) return [];

  // 3. Query monthly details for these 10 articles over N, N-1, and N-2
  const placeholders = top10Arts.map(() => '?').join(',');
  let detailsSql: string;
  let detailsBinds: unknown[];

  if (adrnum !== undefined) {
    detailsSql = `
      SELECT
        L.CDART,
        MAX(A.ARTLIB) AS ARTLIB,
        MAX(A.ARTFAM) AS ARTFAM,
        E.FACDATE,
        SUM(DOUBLE(L.FACQTE)) AS QTE_FACTUREE,
        ${CA_EXPR} AS CA_HT,
        ${MB_EXPR} AS MARGE_HT
      FROM CFACLGN L
      JOIN CFACENT E ON E.CDSOC = L.CDSOC AND E.FACNUMC = L.FACNUMC
      JOIN CFACLIV V ON V.CDSOC = E.CDSOC AND V.FACNUMC = E.FACNUMC AND V.CDCLI = E.CDCLI
      JOIN ARTICLE A ON A.CDSOC = L.CDSOC AND A.CDART = L.CDART
      ${PARAM_JOIN}
      WHERE E.CDSOC = ?
        AND E.CDCLI = ?
        AND V.LIVADRNUM = ?
        AND L.CDART IN (${placeholders})
        AND E.FACDATE BETWEEN ? AND ?
        AND L.FACQTE <> 0
      GROUP BY L.CDART, E.FACDATE`;
    detailsBinds = [cdsoc, cdcli, adrnum, ...top10Arts, dateDebut, dateFin];
  } else {
    detailsSql = `
      SELECT
        L.CDART,
        MAX(A.ARTLIB) AS ARTLIB,
        MAX(A.ARTFAM) AS ARTFAM,
        E.FACDATE,
        SUM(DOUBLE(L.FACQTE)) AS QTE_FACTUREE,
        ${CA_EXPR} AS CA_HT,
        ${MB_EXPR} AS MARGE_HT
      FROM CFACLGN L
      JOIN CFACENT E ON E.CDSOC = L.CDSOC AND E.FACNUMC = L.FACNUMC
      JOIN ARTICLE A ON A.CDSOC = L.CDSOC AND A.CDART = L.CDART
      ${PARAM_JOIN}
      WHERE E.CDSOC = ?
        AND E.CDCLI = ?
        AND L.CDART IN (${placeholders})
        AND E.FACDATE BETWEEN ? AND ?
        AND L.FACQTE <> 0
      GROUP BY L.CDART, E.FACDATE`;
    detailsBinds = [cdsoc, cdcli, ...top10Arts, dateDebut, dateFin];
  }

  const detailsResult = await executeQuery(detailsSql, detailsBinds, sessionId);

  // 4. Group and sum metrics in TypeScript by period
  interface PeriodAccum {
    qte: number;
    ca: number;
    mb: number;
  }
  interface ArtGroup {
    artlib: string;
    artfam: string;
    annee_n: PeriodAccum;
    annee_n1: PeriodAccum;
    annee_n1_ytd: PeriodAccum;
    annee_n2: PeriodAccum;
    annee_n2_ytd: PeriodAccum;
  }

  const groups = new Map<string, ArtGroup>();
  for (const cdart of top10Arts) {
    groups.set(cdart, {
      artlib: '',
      artfam: '',
      annee_n: { qte: 0, ca: 0, mb: 0 },
      annee_n1: { qte: 0, ca: 0, mb: 0 },
      annee_n1_ytd: { qte: 0, ca: 0, mb: 0 },
      annee_n2: { qte: 0, ca: 0, mb: 0 },
      annee_n2_ytd: { qte: 0, ca: 0, mb: 0 },
    });
  }

  // Calculate N-1 and N-2 YTD date limits using last day of current month in N-1 and N-2
  const cutMonth = currentMonth;
  const lastDayN1 = new Date(referenceYear - 1, cutMonth, 0).getDate();
  const dateFinN1Ytd = (referenceYear - 1) * 10000 + cutMonth * 100 + lastDayN1;

  const lastDayN2 = new Date(referenceYear - 2, cutMonth, 0).getDate();
  const dateFinN2Ytd = (referenceYear - 2) * 10000 + cutMonth * 100 + lastDayN2;

  for (const row of detailsResult.rows) {
    const cdart = String(row.CDART ?? '').trim();
    const group = groups.get(cdart);
    if (!group) continue;

    if (!group.artlib) {
      group.artlib = String(row.ARTLIB ?? '').replace(/\s+/g, ' ').trim();
      group.artfam = translateArtFam(String(row.ARTFAM ?? '').trim());
    }

    const facdate = Number(row.FACDATE ?? 0);
    const qte = Number(row.QTE_FACTUREE ?? 0);
    const ca = Number(row.CA_HT ?? 0);
    const mb = Number(row.MARGE_HT ?? 0);

    const year = Math.floor(facdate / 10000);

    // Année en cours N (YTD: du 01/01/N à aujourd'hui)
    if (year === referenceYear) {
      group.annee_n.qte += qte;
      group.annee_n.ca += ca;
      group.annee_n.mb += mb;
    }

    // Année précédente N-1
    if (year === (referenceYear - 1)) {
      group.annee_n1.qte += qte;
      group.annee_n1.ca += ca;
      group.annee_n1.mb += mb;

      if (facdate <= dateFinN1Ytd) {
        group.annee_n1_ytd.qte += qte;
        group.annee_n1_ytd.ca += ca;
        group.annee_n1_ytd.mb += mb;
      }
    }

    // Année N-2
    if (year === (referenceYear - 2)) {
      group.annee_n2.qte += qte;
      group.annee_n2.ca += ca;
      group.annee_n2.mb += mb;

      if (facdate <= dateFinN2Ytd) {
        group.annee_n2_ytd.qte += qte;
        group.annee_n2_ytd.ca += ca;
        group.annee_n2_ytd.mb += mb;
      }
    }
  }

  // 5. Map accumulator to return structure
  return top10Arts.map(cdart => {
    const group = groups.get(cdart)!;

    const mapMetrics = (accum: PeriodAccum): Client360TopArticleMetrics => {
      const txMargeVal = accum.ca === 0
        ? null
        : accum.mb / accum.ca * 100;
      return {
        qte_livree:      Math.round(accum.qte * 100) / 100,
        ca_ht:           accum.ca.toFixed(2),
        mb_ht:           accum.mb.toFixed(2),
        taux_marge_pct:  txMargeVal !== null ? txMargeVal.toFixed(2) : null,
      };
    };

    return {
      cdart,
      artlib:          group.artlib,
      artfam:          group.artfam,
      annee_n:         mapMetrics(group.annee_n),
      annee_n1:        mapMetrics(group.annee_n1),
      annee_n1_ytd:    mapMetrics(group.annee_n1_ytd),
      annee_n2:        mapMetrics(group.annee_n2),
      annee_n2_ytd:    mapMetrics(group.annee_n2_ytd),
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
  const enctot = Number(clientsRow.ENCTOT ?? 0).toFixed(2);
  const enccpt = Number(clientsRow.ENCCPT ?? 0).toFixed(2);
  const rfaTaux = rfa.rfa_taux !== null ? Number(rfa.rfa_taux).toFixed(2) : null;

  return {
    enctot,
    enccpt,
    cdsurv,
    lib_surv:  libSurv(cdsurv),
    bilbloc:   String(clientsRow.BILBLOC ?? '').trim(),
    rfa_taux:  rfaTaux,
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
  referenceYear: number,
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

  // Fetch active delivery addresses from CLILIV (INACTIF <> 'I')
  const adrnumFilter = adrnum !== undefined ? 'AND C.ADRNUM = ?' : "AND C.INACTIF <> 'I'";
  const adrnumBinds: unknown[] = adrnum !== undefined ? [adrnum] : [];

  const adressesSql = `
    SELECT C.CDPOST
    FROM CLILIV C
    WHERE C.CDSOC = ? AND C.CDCLI = ?
      ${adrnumFilter}`;

  const adressesBind: unknown[] = [cdsoc, cdcli, ...adrnumBinds];
  const adressesResult = await executeQuery(adressesSql, adressesBind, sessionId);

  const total_sites = adressesResult.rows.length;
  const tousDepartements: { [dept: string]: number } = {};

  for (const row of adressesResult.rows) {
    const cdpost = String(row.CDPOST ?? '').trim();
    if (cdpost) {
      const dept = cdpost.substring(0, 2);
      if (dept.match(/^\d{2}$/)) {
        tousDepartements[dept] = (tousDepartements[dept] || 0) + 1;
      } else {
        tousDepartements['Autre'] = (tousDepartements['Autre'] || 0) + 1;
      }
    }
  }

  // Keep only Top 10 departments and group the rest under "Autre dept"
  const entries = Object.entries(tousDepartements).sort((a, b) => b[1] - a[1]);
  const top10 = entries.slice(0, 10);
  const remaining = entries.slice(10);

  const sites_par_departement: { departement: string; quantite: number }[] = [];
  for (const [dept, count] of top10) {
    sites_par_departement.push({ departement: dept, quantite: count });
  }
  if (remaining.length > 0) {
    const remainingCount = remaining.reduce((acc, curr) => acc + curr[1], 0);
    sites_par_departement.push({ departement: 'Autre dept', quantite: remainingCount });
  }

  // Fetch shipping costs from CLIVENT over N and N-1 periods
  const dateDebut = (referenceYear - 1) * 10000 + 101;
  const dateFin = referenceYear * 10000 + 1231;

  const portFilter = adrnum !== undefined ? 'AND LIVADRNUM = ?' : '';
  const portBinds = adrnum !== undefined ? [adrnum] : [];

  const portSql = `
    SELECT
      EXPDATE,
      DOUBLE(COALESCE(FRAIPORT, 0)) AS PORT_FACTURE,
      (
        DOUBLE(COALESCE(COUTPORT, 0)) +
        DOUBLE(COALESCE(TAXEGAS, 0)) +
        DOUBLE(COALESCE(TAXESUR, 0)) +
        DOUBLE(COALESCE(TAXEIDF, 0)) +
        DOUBLE(COALESCE(TAXEDIFF, 0)) +
        DOUBLE(COALESCE(TAXEILE, 0)) +
        DOUBLE(COALESCE(TAXEPAMS, 0)) +
        DOUBLE(COALESCE(TAXEVL, 0)) +
        DOUBLE(COALESCE(TAXEMANUT, 0)) +
        DOUBLE(COALESCE(TAXEDEPOT, 0)) +
        DOUBLE(COALESCE(TAXERDV, 0))
      ) AS PORT_DEPENSE
    FROM CLIVENT
    WHERE CDSOC = ?
      AND CDCLI = ?
      AND EXPDATE BETWEEN ? AND ?
      ${portFilter}`;

  const portResult = await executeQuery(portSql, [cdsoc, cdcli, dateDebut, dateFin, ...portBinds], sessionId);

  interface PortAccum {
    facture: number;
    depense: number;
    depenseMoyenneSomme: number;
    nbTotal: number;
    nbAvecDepensePort: number;
  }
  const accumN: PortAccum = { facture: 0, depense: 0, depenseMoyenneSomme: 0, nbTotal: 0, nbAvecDepensePort: 0 };
  const accumN1: PortAccum = { facture: 0, depense: 0, depenseMoyenneSomme: 0, nbTotal: 0, nbAvecDepensePort: 0 };
  const accumN1Ytd: PortAccum = { facture: 0, depense: 0, depenseMoyenneSomme: 0, nbTotal: 0, nbAvecDepensePort: 0 };

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const lastDayN1 = new Date(referenceYear - 1, currentMonth, 0).getDate();
  const dateFinN1Ytd = (referenceYear - 1) * 10000 + currentMonth * 100 + lastDayN1;

  for (const row of portResult.rows) {
    const expdate = Number(row.EXPDATE ?? 0);
    const portFacture = Number(row.PORT_FACTURE ?? 0);
    const portDepense = Number(row.PORT_DEPENSE ?? 0);
    const year = Math.floor(expdate / 10000);

    if (year === referenceYear) {
      accumN.nbTotal += 1;
      accumN.facture += portFacture;
      accumN.depense += portDepense;
      if (portDepense > 0) {
        accumN.depenseMoyenneSomme += portDepense;
        accumN.nbAvecDepensePort += 1;
      }
    } else if (year === referenceYear - 1) {
      accumN1.nbTotal += 1;
      accumN1.facture += portFacture;
      accumN1.depense += portDepense;
      if (portDepense > 0) {
        accumN1.depenseMoyenneSomme += portDepense;
        accumN1.nbAvecDepensePort += 1;
      }

      if (expdate <= dateFinN1Ytd) {
        accumN1Ytd.nbTotal += 1;
        accumN1Ytd.facture += portFacture;
        accumN1Ytd.depense += portDepense;
        if (portDepense > 0) {
          accumN1Ytd.depenseMoyenneSomme += portDepense;
          accumN1Ytd.nbAvecDepensePort += 1;
        }
      }
    }
  }

  const formatPort = (accum: PortAccum): Client360FraisPortMetrics => {
    const moyen = accum.nbAvecDepensePort > 0 ? accum.depenseMoyenneSomme / accum.nbAvecDepensePort : 0;
    return {
      facture:        accum.facture.toFixed(2),
      depense:        accum.depense.toFixed(2),
      depense_moyen:  moyen.toFixed(2),
      nb_livraisons:  accum.nbTotal,
    };
  };

  return {
    cdtport:               s('CDTPORT'),
    vfranco:               Number(clientsRow.VFRANCO ?? 0),
    cdtrnliv:              cdtrnlivPrincipal,
    lbtrnliv:              lbtrnlivPrincipal,
    cdtrans:               cdtransPrincipal,
    livdays:               s('LIVDAYS'),
    ilivrais:              s('ILIVRAIS'),
    rlivrais:              s('RLIVRAIS'),
    total_sites,
    sites_par_departement,
    frais_port: {
      annee_n:             formatPort(accumN),
      annee_n1:            formatPort(accumN1),
      annee_n1_ytd:        formatPort(accumN1Ytd),
    },
  };
}

/**
 * Fetches open orders (portefeuille) for the client from CCMDENT and CCMDLGN.
 * Excludes sold orders (CMDETAT = 'S' and LGNETAT = 'S').
 */
async function queryCommandesEnCours(
  cdsoc: string,
  cdcli: number,
  adrnum: number | undefined,
  sessionId?: string
): Promise<Client360CommandeEnCours[]> {
  const adrnumFilter = adrnum !== undefined ? 'AND E.LIVADRNUM = ?' : '';
  const binds = adrnum !== undefined ? [cdsoc, cdcli, adrnum] : [cdsoc, cdcli];

  const sql = `
    SELECT
      E.CMDNUMC,
      E.CMDDATE,
      E.DMDDATE,
      E.CMDREF,
      E.CMDETAT,
      SUM(
        DOUBLE(COALESCE(L.PVUNIHT, 0)) * 
        (1.0 - DOUBLE(COALESCE(L.PVREM, 0)) / 100.0) * 
        DOUBLE(COALESCE(L.CMDQTE, 0)) / 
        DOUBLE(COALESCE(NULLIF(CAST(TRIM(SUBSTR(P.PARDATA, 1, 5)) AS DECIMAL(7, 0)), 0), 1))
      ) AS MONTANT_HT
    FROM CCMDENT E
    JOIN CCMDLGN L ON L.CDSOC = E.CDSOC AND L.CMDNUMC = E.CMDNUMC
    LEFT JOIN PARAM P
      ON  P.CDSOC   = L.CDSOC
      AND P.MOTCLE  = 'UNITE-PV  '
      AND P.CDPARM1 = L.UNITPV
      AND P.CDPARM2 = '          '
    WHERE E.CDSOC = ?
      AND E.CDCLI = ?
      AND E.CMDETAT <> 'S'
      AND L.LGNETAT <> 'S'
      ${adrnumFilter}
    GROUP BY E.CMDNUMC, E.CMDDATE, E.DMDDATE, E.CMDREF, E.CMDETAT
    ORDER BY E.CMDDATE DESC
  `;

  const result = await executeQuery(sql, binds, sessionId);

  return result.rows.map(row => {
    const rawEtat = String(row.CMDETAT ?? '').trim();
    let stateLabel = rawEtat;
    switch (rawEtat.toUpperCase()) {
      case 'E': stateLabel = 'En cours'; break;
      case 'P': stateLabel = 'En préparation'; break;
      case 'S': stateLabel = 'Soldée'; break;
      default:  stateLabel = rawEtat || 'Nouveau';
    }

    return {
      cmdnumc:    Number(row.CMDNUMC ?? 0),
      cmddate:    Number(row.CMDDATE ?? 0),
      dmddate:    Number(row.DMDDATE ?? 0),
      cmdref:     String(row.CMDREF ?? '').trim(),
      cmdetat:    stateLabel,
      montant_ht: Number(row.MONTANT_HT ?? 0).toFixed(2),
    };
  });
}

// ---------------------------------------------------------------------------
// Main tool handler
// ---------------------------------------------------------------------------

/**
 * Returns a complete 360° client profile.
 *
 * Orchestration:
 * 1. queryIdentite  — fetches CLIENTS row (mandatory gate)
 * 2. Promise.all — parallel: ca_n, ca_n1, tendance, top_articles, rfa, transport, commandes_en_cours
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
  let OpenOrders: Client360CommandeEnCours[];

  try {
    [canN, canN1, tendance, topArticles, rfa, transport, OpenOrders] = await Promise.all([
      queryCanYear(cdsoc, cdcli, annee,     sessionId),
      queryCanYear(cdsoc, cdcli, annee - 1, sessionId),
      queryTendanceMensuelle(cdsoc, cdcli, annee, adrnum, sessionId),
      queryTopArticles(cdsoc, cdcli, annee, adrnum, sessionId),
      queryRfa(cdsoc, cdcli, annee, sessionId),
      queryTransport(cdsoc, cdcli, clientRow.row, annee, adrnum, sessionId),
      queryCommandesEnCours(cdsoc, cdcli, adrnum, sessionId),
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
    commandes_en_cours: OpenOrders,
  };
}
