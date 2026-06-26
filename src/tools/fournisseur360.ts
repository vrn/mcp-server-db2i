/**
 * Fournisseur 360° profile tool for groupe TINI (IBM i / DB2 for i)
 *
 * Returns a complete 360° supplier profile in a single call, structured in 6 blocs:
 * - identite           : supplier identity from FOURNIS
 * - achats_n_n1        : purchase amount HT + qty for year N and N-1 (FLIVENT/FLIVLGN/PARAM)
 * - tendance_mensuelle : 24 rolling months of purchases, calculated by SQL GROUP BY
 * - top_articles       : top 10 articles by purchase amount over year N (FLIVENT/FLIVLGN/ARTICLE)
 * - alertes            : blocking flag, RFA rate/obtained/threshold (FOURNIS + FOURFA)
 * - transport          : shipping conditions (FOURNIS) + aggregated freight costs N/N-1 (FLIVENT)
 *
 * Business rules (validated against STAAF10R.SQLRPGLE, subroutine $EXTR_BR l.1360-1363):
 * - Source: delivery lines only (FLIVENT + FLIVLGN) — FFACENT does not carry amounts
 * - Formula: ACHAT_HT = SUM(DOUBLE(PAUNIHT)*(1-DOUBLE(PAREM)/100)*DOUBLE(LIVQTE)/DOUBLE(NBR))
 * - DOUBLE() mandatory on all arithmetic to prevent SQL0802
 * - Filter: LIVQTE <> 0 only — no LIVETAT / LGRATUIT filter (mirrors STAAF10R behaviour)
 * - NBRUNITE from PARAM (MOTCLE='UNITE-PV  ', CDPARM1=UNITPA), positions 1-5 of PARDATA, default 1
 * - FLIVENT join key: CDSOC + LIVNUMF + CMDNUMF
 * - Date field: FLIVENT.LIVDATE (8S 0 YYYYMMDD)
 * - cdagel: optional filter on receiving agency. Absent = all agencies aggregated.
 * - annee: TypeScript new Date().getFullYear() if not provided — never CURRENT_DATE in SQL
 *
 * @see docs/MCP_PLAN_FOURNISSEUR360.md for full plan
 * @see src/tools/caMargin.ts for SQL formula reference (DOUBLE constants pattern)
 * @see src/tools/client360.ts for mirror implementation (client side)
 */

import { executeQuery } from '../db/connection.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger({ component: 'fournisseur360-tool' });

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

/** Input parameters */
export interface Fournisseur360Input {
  /** Society code (mandatory) */
  cdsoc: string;
  /** Supplier code 6S 0 (mandatory) */
  cdfou: number;
  /** Reference year for N/N-1 calculations — defaults to current year */
  annee?: number;
  /**
   * Optional receiving agency code (FLIVENT.CDAGEL, 2A).
   * When provided, all purchase blocs are filtered to this agency.
   * When omitted, all agencies are aggregated (global supplier view).
   */
  cdagel?: string;
  /** Optional session ID for HTTP transport */
  sessionId?: string;
}

/** Supplier identity bloc */
export interface Fournisseur360Identite {
  raison: string;
  adress1: string;
  adress2: string;
  adress3: string;
  cdpost: string;
  ville: string;
  cdpays: string;
  siren: string;
  cdnaf: string;
  cddevis: string;
  /** Delivery lead time in days */
  livdly: number;
  /** Block flag: 'B'=blocked */
  bloque: string;
  rglcd: string;
}

/** Purchase amount for one year */
export interface Fournisseur360AchatsYear {
  annee: number;
  achat_ht: number;
  qte_livree: number;
}

/** Purchases N / N-1 comparison bloc */
export interface Fournisseur360AchatsN1 {
  annee_n: Fournisseur360AchatsYear;
  annee_n1: Fournisseur360AchatsYear;
}

/** One month in the purchase trend series */
export interface Fournisseur360TrendMonth {
  annee: number;
  mois: number;
  achat_ht: number;
  qte_livree: number;
}

/** One article in the top-10 */
export interface Fournisseur360TopArticle {
  cdart: string;
  artlib: string;
  artfam: string;
  qte_livree: number;
  achat_ht: number;
  /** Average net unit purchase price = achat_ht / qte_livree (null if qty = 0) */
  pa_net_moyen: number | null;
}

/** Alerts and risk indicators bloc */
export interface Fournisseur360Alertes {
  /** Block flag: 'B'=blocked, ' '=active */
  bloque: string;
  /** RFA rate for the reference year (null if none) */
  rfa_taux: number | null;
  /** RFA year (null if none) */
  rfa_annee: number | null;
  /** RFA obtained amount (null if none) */
  rfa_obtenu: number | null;
  /** RFA threshold (null if none) */
  rfa_seuil: number | null;
}

/** Freight costs for one year (SUM of FRAIPORT + FRAITRANS from FLIVENT) */
export interface Fournisseur360FretsYear {
  annee: number;
  frais_port: number;
  frais_transport: number;
  /** Total = frais_port + frais_transport */
  frais_total: number;
}

/** Transport conditions bloc */
export interface Fournisseur360Transport {
  /** Shipping type code (FOURNIS.CDTPORT) */
  cdtport: string;
  /** Delivery lead time in days (FOURNIS.LIVDLY) */
  livdly: number;
  /** Tariff scope: 'A'=agency, 'N'=national (FOURNIS.FTARIF) */
  ftarif: string;
  /** Free shipping value threshold (FOURNIS.VALFRANC) */
  valfranc: number;
  /** Free shipping palette count threshold (FOURNIS.PALFRANC) */
  palfranc: number;
  /** Free shipping weight threshold in kg (FOURNIS.PDSFRANC) */
  pdsfranc: number;
  /** Free shipping carton count threshold (FOURNIS.CARFRANC) */
  carfranc: number;
  /** Freight costs aggregated for year N */
  frets_n: Fournisseur360FretsYear;
  /** Freight costs aggregated for year N-1 */
  frets_n1: Fournisseur360FretsYear;
}

/** Successful result */
export interface Fournisseur360Success {
  success: true;
  cdsoc: string;
  cdfou: number;
  annee: number;
  /** Filtered receiving agency, or null when viewing the global supplier aggregate */
  cdagel: string | null;
  identite: Fournisseur360Identite;
  achats_n_n1: Fournisseur360AchatsN1;
  tendance_mensuelle: Fournisseur360TrendMonth[];
  top_articles: Fournisseur360TopArticle[];
  alertes: Fournisseur360Alertes;
  transport: Fournisseur360Transport;
}

/** Tool result */
export type Fournisseur360Result =
  | Fournisseur360Success
  | { success: false; error: string };

// ---------------------------------------------------------------------------
// SQL constants
// DOUBLE() is mandatory: PAUNIHT(8,2) × PAREM(4,2) × LIVQTE(10,2) overflows DB2 DECIMAL precision
// NBRUNITE: same mechanism as caMargin.ts — purchase price is per N units (MILLE=1000, CENT=100)
// ---------------------------------------------------------------------------
const PA   = `DOUBLE(COALESCE(L.PAUNIHT,0))`;
const REM  = `DOUBLE(COALESCE(L.PAREM,0))`;
const QTE  = `DOUBLE(L.LIVQTE)`;
const NBR  = `DOUBLE(COALESCE(NULLIF(CAST(TRIM(SUBSTR(P.PARDATA,1,5)) AS DECIMAL(7,0)),0),1))`;

const ACHAT_EXPR = `SUM(${PA} * (1 - ${REM} / 100) * ${QTE} / ${NBR})`;
const QTE_EXPR   = `SUM(${QTE})`;

/** LEFT JOIN to resolve NBRUNITE from PARAM — uses UNITPA (purchase unit) */
const PARAM_JOIN = `LEFT JOIN PARAM P
    ON  P.CDSOC   = L.CDSOC
    AND P.MOTCLE  = 'UNITE-PV  '
    AND P.CDPARM1 = L.UNITPA
    AND P.CDPARM2 = '          '`;

/** JOIN FLIVLGN on its composite key (CDSOC + LIVNUMF + CMDNUMF) */
const FLIVLGN_JOIN = `JOIN FLIVLGN L
    ON  L.CDSOC   = E.CDSOC
    AND L.LIVNUMF = E.LIVNUMF
    AND L.CMDNUMF = E.CMDNUMF`;

/** Builds YYYYMMDD integer date from year + MMDD suffix */
function yyyymmdd(annee: number, mmdd: number): number {
  return annee * 10000 + mmdd;
}

/** Returns an optional CDAGEL WHERE clause and its bind value */
function agenceFilter(cdagel: string | undefined): { clause: string; bind: string[] } {
  return cdagel
    ? { clause: 'AND E.CDAGEL = ?', bind: [cdagel] }
    : { clause: '', bind: [] };
}

// ---------------------------------------------------------------------------
// ST1 — Identity
// ---------------------------------------------------------------------------

type FournisRow = Record<string, unknown>;

/**
 * Fetches supplier identity and blocking fields from FOURNIS.
 * Returns null if the supplier does not exist.
 */
async function queryIdentite(
  cdsoc: string,
  cdfou: number,
  sessionId?: string
): Promise<{ row: FournisRow } | null> {
  const sql = `
    SELECT
      RAISON, ADRESS1, ADRESS2, ADRESS3, CDPOST, VILLE, CDPAYS,
      SIREN, CDNAF, CDDEVIS, LIVDLY, BLOQUE, RGLCD,
      CDTPORT, FTARIF, VALFRANC, PALFRANC, PDSFRANC, CARFRANC
    FROM FOURNIS
    WHERE CDSOC = ? AND CDFOU = ?
    FETCH FIRST 1 ROW ONLY`;
  const result = await executeQuery(sql, [cdsoc, cdfou], sessionId);
  if (result.rows.length === 0) return null;
  return { row: result.rows[0] };
}

/** Maps FOURNIS row to Fournisseur360Identite */
function mapIdentite(row: FournisRow): Fournisseur360Identite {
  const s = (f: string) => String(row[f] ?? '').trim();
  return {
    raison:  s('RAISON'),
    adress1: s('ADRESS1'),
    adress2: s('ADRESS2'),
    adress3: s('ADRESS3'),
    cdpost:  s('CDPOST'),
    ville:   s('VILLE'),
    cdpays:  s('CDPAYS'),
    siren:   s('SIREN'),
    cdnaf:   s('CDNAF'),
    cddevis: s('CDDEVIS'),
    livdly:  Number(row.LIVDLY ?? 0),
    bloque:  s('BLOQUE'),
    rglcd:   s('RGLCD'),
  };
}

// ---------------------------------------------------------------------------
// ST2 — Purchases N / N-1
// ---------------------------------------------------------------------------

/**
 * Calculates total purchase amount HT and delivered quantity for a single year.
 * Optionally filtered by receiving agency (cdagel).
 */
async function queryAchatsYear(
  cdsoc: string,
  cdfou: number,
  annee: number,
  cdagel: string | undefined,
  sessionId?: string
): Promise<Fournisseur360AchatsYear> {
  const dateDebut = yyyymmdd(annee, 101);   // AAAA0101
  const dateFin   = yyyymmdd(annee, 1231);  // AAAA1231
  const agence    = agenceFilter(cdagel);

  const sql = `
    SELECT
      ${ACHAT_EXPR} AS ACHAT_HT,
      ${QTE_EXPR}   AS QTE_LIVREE
    FROM   FLIVENT E
    ${FLIVLGN_JOIN}
    ${PARAM_JOIN}
    WHERE  E.CDSOC  = ?
      AND  E.CDFOU  = ?
      AND  E.LIVDATE BETWEEN ? AND ?
      AND  L.LIVQTE <> 0
      ${agence.clause}`;

  const binds: unknown[] = [cdsoc, cdfou, dateDebut, dateFin, ...agence.bind];
  const result = await executeQuery(sql, binds, sessionId);
  const row = result.rows[0] ?? {};
  return {
    annee,
    achat_ht:   Math.round(Number(row.ACHAT_HT  ?? 0) * 100) / 100,
    qte_livree: Math.round(Number(row.QTE_LIVREE ?? 0) * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// ST3 — 24-month rolling trend
// ---------------------------------------------------------------------------

/**
 * Calculates purchase amounts grouped by YYYYMM over the last 24 rolling months.
 * Uses INTEGER(LIVDATE/100) to extract YYYYMM from the 8S0 integer date.
 * Months with no deliveries are excluded (no zero-fill).
 */
async function queryTendanceMensuelle(
  cdsoc: string,
  cdfou: number,
  cdagel: string | undefined,
  sessionId?: string
): Promise<Fournisseur360TrendMonth[]> {
  const now = new Date();
  // First day of the month 23 months back (= 24 months including current)
  const debut  = new Date(now.getFullYear(), now.getMonth() - 23, 1);
  const dateDebut = debut.getFullYear() * 10000 + (debut.getMonth() + 1) * 100 + 1;
  // Last possible day of current month (31 is safe — BETWEEN on YYYYMMDD integers)
  const dateFin   = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + 31;

  const agence = agenceFilter(cdagel);

  const sql = `
    SELECT
      INTEGER(E.LIVDATE / 100) AS AAAAMM,
      ${ACHAT_EXPR}            AS ACHAT_HT,
      ${QTE_EXPR}              AS QTE_LIVREE
    FROM   FLIVENT E
    ${FLIVLGN_JOIN}
    ${PARAM_JOIN}
    WHERE  E.CDSOC  = ?
      AND  E.CDFOU  = ?
      AND  E.LIVDATE BETWEEN ? AND ?
      AND  L.LIVQTE <> 0
      ${agence.clause}
    GROUP  BY INTEGER(E.LIVDATE / 100)
    ORDER  BY AAAAMM DESC
    FETCH FIRST 24 ROWS ONLY`;

  const binds: unknown[] = [cdsoc, cdfou, dateDebut, dateFin, ...agence.bind];
  const result = await executeQuery(sql, binds, sessionId);

  return result.rows.map(row => {
    const aaaamm = Number(row.AAAAMM ?? 0);
    return {
      annee:      Math.floor(aaaamm / 100),
      mois:       aaaamm % 100,
      achat_ht:   Math.round(Number(row.ACHAT_HT  ?? 0) * 100) / 100,
      qte_livree: Math.round(Number(row.QTE_LIVREE ?? 0) * 100) / 100,
    };
  });
}

// ---------------------------------------------------------------------------
// ST4 — Top 10 articles
// ---------------------------------------------------------------------------

/**
 * Returns the top 10 articles by purchase amount for year N.
 * ARTLIB is taken from FLIVLGN (denormalised); ARTFAM from LEFT JOIN ARTICLE.
 * MAX(ARTLIB) avoids GROUP BY on a 90-char column.
 */
async function queryTopArticles(
  cdsoc: string,
  cdfou: number,
  annee: number,
  cdagel: string | undefined,
  sessionId?: string
): Promise<Fournisseur360TopArticle[]> {
  const dateDebut = yyyymmdd(annee, 101);
  const dateFin   = yyyymmdd(annee, 1231);
  const agence    = agenceFilter(cdagel);

  const sql = `
    SELECT
      L.CDART,
      MAX(L.ARTLIB)              AS ARTLIB,
      COALESCE(MAX(A.ARTFAM),'') AS ARTFAM,
      ${ACHAT_EXPR}              AS ACHAT_HT,
      ${QTE_EXPR}                AS QTE_LIVREE
    FROM   FLIVENT E
    ${FLIVLGN_JOIN}
    ${PARAM_JOIN}
    LEFT JOIN ARTICLE A ON A.CDSOC=L.CDSOC AND A.CDART=L.CDART
    WHERE  E.CDSOC  = ?
      AND  E.CDFOU  = ?
      AND  E.LIVDATE BETWEEN ? AND ?
      AND  L.LIVQTE <> 0
      ${agence.clause}
    GROUP  BY L.CDART
    ORDER  BY ACHAT_HT DESC
    FETCH FIRST 10 ROWS ONLY`;

  const binds: unknown[] = [cdsoc, cdfou, dateDebut, dateFin, ...agence.bind];
  const result = await executeQuery(sql, binds, sessionId);

  return result.rows.map(row => {
    const achat = Math.round(Number(row.ACHAT_HT  ?? 0) * 100) / 100;
    const qte   = Math.round(Number(row.QTE_LIVREE ?? 0) * 100) / 100;
    return {
      cdart:        String(row.CDART  ?? '').trim(),
      artlib:       String(row.ARTLIB ?? '').trim(),
      artfam:       String(row.ARTFAM ?? '').trim(),
      qte_livree:   qte,
      achat_ht:     achat,
      pa_net_moyen: qte === 0 ? null : Math.round(achat / qte * 10000) / 10000,
    };
  });
}

// ---------------------------------------------------------------------------
// ST5 — Alerts
// ---------------------------------------------------------------------------

type RfaResult = {
  rfa_taux: number | null;
  rfa_annee: number | null;
  rfa_obtenu: number | null;
  rfa_seuil: number | null;
};

/**
 * Fetches the most recent RFA record for this supplier up to and including `annee`.
 * Returns null values if no RFA is configured.
 */
async function queryRfa(
  cdsoc: string,
  cdfou: number,
  annee: number,
  sessionId?: string
): Promise<RfaResult> {
  const sql = `
    SELECT RFATAUX, RFAAA, RFAOBTNU, RFASEUIL
    FROM FOURFA
    WHERE CDSOC = ? AND CDFOU = ? AND RFAAA <= ?
    ORDER BY RFAAA DESC, RFASEUIL ASC
    FETCH FIRST 1 ROW ONLY`;
  const result = await executeQuery(sql, [cdsoc, cdfou, annee], sessionId);
  if (result.rows.length === 0) {
    return { rfa_taux: null, rfa_annee: null, rfa_obtenu: null, rfa_seuil: null };
  }
  const row = result.rows[0];
  return {
    rfa_taux:   row.RFATAUX  != null ? Number(row.RFATAUX)  : null,
    rfa_annee:  row.RFAAA    != null ? Number(row.RFAAA)    : null,
    rfa_obtenu: row.RFAOBTNU != null ? Number(row.RFAOBTNU) : null,
    rfa_seuil:  row.RFASEUIL != null ? Number(row.RFASEUIL) : null,
  };
}

// ---------------------------------------------------------------------------
// Transport — static conditions + aggregated freight costs
// ---------------------------------------------------------------------------

/** Builds the transport static conditions from the FOURNIS row (already loaded) */
function mapTransportConditions(row: FournisRow): Omit<Fournisseur360Transport, 'frets_n' | 'frets_n1'> {
  return {
    cdtport:  String(row.CDTPORT  ?? '').trim(),
    livdly:   Number(row.LIVDLY   ?? 0),
    ftarif:   String(row.FTARIF   ?? '').trim(),
    valfranc: Number(row.VALFRANC ?? 0),
    palfranc: Number(row.PALFRANC ?? 0),
    pdsfranc: Number(row.PDSFRANC ?? 0),
    carfranc: Number(row.CARFRANC ?? 0),
  };
}

/**
 * Calculates aggregated freight costs (FRAIPORT + FRAITRANS) for a single year.
 * Reads directly from FLIVENT header — no join with FLIVLGN needed.
 * Optional cdagel filter applied if provided.
 */
async function queryFrets(
  cdsoc: string,
  cdfou: number,
  annee: number,
  cdagel: string | undefined,
  sessionId?: string
): Promise<Fournisseur360FretsYear> {
  const dateDebut = yyyymmdd(annee, 101);
  const dateFin   = yyyymmdd(annee, 1231);
  const agence    = agenceFilter(cdagel);

  const sql = `
    SELECT
      SUM(DOUBLE(COALESCE(FRAIPORT,  0))) AS FRAIS_PORT,
      SUM(DOUBLE(COALESCE(FRAITRANS, 0))) AS FRAIS_TRANSPORT
    FROM FLIVENT
    WHERE CDSOC   = ?
      AND CDFOU   = ?
      AND LIVDATE BETWEEN ? AND ?
      ${agence.clause}`;

  const binds: unknown[] = [cdsoc, cdfou, dateDebut, dateFin, ...agence.bind];
  const result = await executeQuery(sql, binds, sessionId);
  const row = result.rows[0] ?? {};
  const port  = Math.round(Number(row.FRAIS_PORT      ?? 0) * 100) / 100;
  const trans = Math.round(Number(row.FRAIS_TRANSPORT ?? 0) * 100) / 100;
  return {
    annee,
    frais_port:      port,
    frais_transport: trans,
    frais_total:     Math.round((port + trans) * 100) / 100,
  };
}

/** Builds the alertes bloc from the FOURNIS row and the RFA query result */
function mapAlertes(row: FournisRow, rfa: RfaResult): Fournisseur360Alertes {
  return {
    bloque:     String(row.BLOQUE ?? '').trim(),
    rfa_taux:   rfa.rfa_taux,
    rfa_annee:  rfa.rfa_annee,
    rfa_obtenu: rfa.rfa_obtenu,
    rfa_seuil:  rfa.rfa_seuil,
  };
}

// ---------------------------------------------------------------------------
// Main tool handler
// ---------------------------------------------------------------------------

/**
 * Returns a complete 360° supplier profile.
 *
 * Orchestration:
 * 1. queryIdentite  — fetches FOURNIS row (mandatory gate)
 * 2. Promise.all — parallel: achats_n, achats_n1, tendance, top_articles, rfa, frets_n, frets_n1
 *
 * @param input - cdsoc, cdfou, optional annee, cdagel, and sessionId
 */
export async function getFournisseur360Tool(input: Fournisseur360Input): Promise<Fournisseur360Result> {
  const { cdsoc, cdfou, sessionId, cdagel } = input;
  const annee = input.annee ?? new Date().getFullYear();

  log.debug({ cdsoc, cdfou, annee, cdagel }, 'Starting fournisseur 360 query');

  // Step 1: identity gate — also provides BLOQUE + transport conditions for later blocs
  let fournisRow: { row: FournisRow } | null;
  try {
    fournisRow = await queryIdentite(cdsoc, cdfou, sessionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    log.debug({ err }, 'queryIdentite (fournis) failed');
    return { success: false, error: `Erreur identité fournisseur: ${msg}` };
  }

  if (fournisRow === null) {
    return { success: false, error: `Fournisseur ${cdfou} introuvable pour la société ${cdsoc}` };
  }

  const identite = mapIdentite(fournisRow.row);

  // Step 2: parallel queries
  let achatsN:     Fournisseur360AchatsYear;
  let achatsN1:    Fournisseur360AchatsYear;
  let tendance:    Fournisseur360TrendMonth[];
  let topArticles: Fournisseur360TopArticle[];
  let rfa:         RfaResult;
  let fretsN:      Fournisseur360FretsYear;
  let fretsN1:     Fournisseur360FretsYear;

  try {
    [achatsN, achatsN1, tendance, topArticles, rfa, fretsN, fretsN1] = await Promise.all([
      queryAchatsYear(cdsoc, cdfou, annee,     cdagel, sessionId),
      queryAchatsYear(cdsoc, cdfou, annee - 1, cdagel, sessionId),
      queryTendanceMensuelle(cdsoc, cdfou, cdagel, sessionId),
      queryTopArticles(cdsoc, cdfou, annee, cdagel, sessionId),
      queryRfa(cdsoc, cdfou, annee, sessionId),
      queryFrets(cdsoc, cdfou, annee,     cdagel, sessionId),
      queryFrets(cdsoc, cdfou, annee - 1, cdagel, sessionId),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    log.debug({ err }, 'Parallel fournisseur360 queries failed');
    return { success: false, error: `Erreur données fournisseur: ${msg}` };
  }

  const alertes   = mapAlertes(fournisRow.row, rfa);
  const transport: Fournisseur360Transport = {
    ...mapTransportConditions(fournisRow.row),
    frets_n:  fretsN,
    frets_n1: fretsN1,
  };

  log.info(
    { cdsoc, cdfou, annee, cdagel, tendance_count: tendance.length, top_articles_count: topArticles.length },
    'Fournisseur 360 completed'
  );

  return {
    success: true,
    cdsoc,
    cdfou,
    annee,
    cdagel: cdagel ?? null,
    identite,
    achats_n_n1:       { annee_n: achatsN, annee_n1: achatsN1 },
    tendance_mensuelle: tendance,
    top_articles:       topArticles,
    alertes,
    transport,
  };
}
