/**
 * CA & Gross Margin calculation tool for groupe TINI (IBM i / DB2 for i)
 *
 * Aggregates HT revenue and gross margin from client invoice lines (CFACENT/CFACLGN)
 * across three axes: by society, by client, or by article.
 *
 * Business rules applied:
 * - Source: invoice lines only (CFACENT + CFACLGN) — never orders or delivery notes
 * - Lines with FACQTE = 0 excluded (mirrors RPG STAVC behaviour)
 * - No filter on FACETAT — RPG programmes do not filter on invoice status
 * - No filter on LGRATUIT — RPG programmes do not filter on free-line flag
 * - Net price: COALESCE(PVUNIHT,0) × (1 − COALESCE(PVREM,0) / 100)
 * - Gross margin: net_price × qty − COALESCE(PRUNIHT,0) × qty
 * - Credit notes are included (negative amounts reduce CA/margin automatically)
 *
 * @see docs/CALCUL_CA_MARGE.md for full business documentation
 */

import { executeQuery } from '../db/connection.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger({ component: 'ca-margin-tool' });

/** All TINI group society codes */
const TINI_SOCIETIES = ['01', '03', '11', '12', '14', '15', '17', '18', '19', '23'] as const;

/** Aggregation axis */
export type Axis = 'society' | 'client' | 'article';

/** Sort order */
export type OrderBy = 'ca' | 'marge' | 'taux_marge';

/** Input parameters for the CA/margin tool */
export interface CaMarginInput {
  /** Aggregation axis: 'society' | 'client' | 'article' */
  axis: Axis;
  /** Period start date in YYYYMMDD format (DB2i 8S 0 integer) */
  date_debut: string;
  /** Period end date in YYYYMMDD format (DB2i 8S 0 integer) */
  date_fin: string;
  /** Society code(s) — defaults to all TINI societies */
  cdsoc?: string | string[];
  /** Filter on a specific client code (applies when axis = 'client') */
  cdcli?: number;
  /** Filter on a specific article code (applies when axis = 'article') */
  cdart?: string;
  /** Maximum rows returned (default: 100, max: 1000) */
  limit?: number;
  /** Sort order (default: 'ca') */
  order_by?: OrderBy;
  /** Optional session ID for HTTP transport */
  sessionId?: string;
}

/** One result row */
export interface CaMarginRow {
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
}

/** Aggregated totals */
export interface CaMarginTotals {
  ca_ht: number;
  cout_achat_ht: number;
  marge_ht: number;
  taux_marge_pct: number | null;
}

/** Tool result */
export type CaMarginResult =
  | {
      success: true;
      axis: Axis;
      period: { date_debut: string; date_fin: string };
      rows: CaMarginRow[];
      totals: CaMarginTotals;
      row_count: number;
    }
  | { success: false; error: string };

// ---------------------------------------------------------------------------
// SQL building
// ---------------------------------------------------------------------------

// DOUBLE() cast is mandatory on DB2 for i:
// PVUNIHT(8,2) × (1-PVREM(6,4)/100) × FACQTE(10,2) overflows DECIMAL precision rules → SQL0802
//
// NBRUNITE: FACQTE is in base units (e.g. individual sheets), PVUNIHT is priced per NBRUNITE units
// (e.g. price per 1000 = MILLE, per 100 = CENT). Without dividing, amounts are 1000x too large.
// NBRUNITE is stored in PARAM (MOTCLE='UNITE-PV  ', CDPARM1=UNITPV), positions 1-5 of PARDATA.
// Fallback to 1 when: no PARAM row found (LEFT JOIN → NULL) or PARDATA value = 0.
const PV   = `DOUBLE(COALESCE(L.PVUNIHT,0))`;
const REM  = `DOUBLE(COALESCE(L.PVREM,0))`;
const PR   = `DOUBLE(COALESCE(L.PRUNIHT,0))`;
const QTE  = `DOUBLE(L.FACQTE)`;
const NBR  = `DOUBLE(COALESCE(NULLIF(CAST(TRIM(SUBSTR(P.PARDATA,1,5)) AS DECIMAL(7,0)),0),1))`;

const CA_EXPR   = `SUM(${PV} * (1 - ${REM} / 100) * ${QTE} / ${NBR})`;
const COUT_EXPR = `SUM(${PR} * ${QTE} / ${NBR})`;
const MB_EXPR   = `SUM((${PV} * (1 - ${REM} / 100) - ${PR}) * ${QTE} / ${NBR})`;
const TX_EXPR   = `CASE WHEN ${CA_EXPR} = 0 THEN NULL ELSE ROUND(${MB_EXPR} / ${CA_EXPR} * 100, 2) END`;

/** LEFT JOIN fragment to resolve NBRUNITE from PARAM — alias P, joined on CDSOC+UNITPV */
const PARAM_JOIN = `LEFT JOIN PARAM P
    ON  P.CDSOC   = L.CDSOC
    AND P.MOTCLE  = 'UNITE-PV  '
    AND P.CDPARM1 = L.UNITPV
    AND P.CDPARM2 = '          '`;

/** Returns the ORDER BY fragment for the chosen sort key */
function orderByClause(orderBy: OrderBy): string {
  switch (orderBy) {
    case 'marge':      return `${MB_EXPR} DESC`;
    case 'taux_marge': return `${TX_EXPR} DESC`;
    default:           return `${CA_EXPR} DESC`;
  }
}

/** Builds the WHERE society IN (…) fragment and its bind values */
function buildSocietyFilter(cdsoc?: string | string[]): { clause: string; values: string[] } {
  const list = cdsoc
    ? (Array.isArray(cdsoc) ? cdsoc : [cdsoc])
    : [...TINI_SOCIETIES];
  const placeholders = list.map(() => '?').join(',');
  return { clause: `E.CDSOC IN (${placeholders})`, values: list };
}

interface QueryParts {
  sql: string;
  binds: unknown[];
}

/** Builds SQL + bind array for the 'society' axis */
function buildSocietyQuery(input: CaMarginInput, socFilter: ReturnType<typeof buildSocietyFilter>, limit: number): QueryParts {
  const order = orderByClause(input.order_by ?? 'ca');
  const sql = `
    SELECT
      E.CDSOC,
      ${CA_EXPR}   AS CA_HT,
      ${COUT_EXPR} AS COUT_ACHAT_HT,
      ${MB_EXPR}   AS MARGE_HT,
      ${TX_EXPR}   AS TAUX_MARGE_PCT
    FROM   CFACENT E
    JOIN   CFACLGN L ON L.CDSOC=E.CDSOC AND L.FACNUMC=E.FACNUMC
    ${PARAM_JOIN}
    WHERE  ${socFilter.clause}
      AND  E.FACDATE BETWEEN ? AND ?
      AND  L.FACQTE <> 0
    GROUP  BY E.CDSOC
    ORDER  BY ${order}
    FETCH FIRST ${limit} ROWS ONLY`;
  return { sql, binds: [...socFilter.values, input.date_debut, input.date_fin] };
}

/** Builds SQL + bind array for the 'client' axis */
function buildClientQuery(input: CaMarginInput, socFilter: ReturnType<typeof buildSocietyFilter>, limit: number): QueryParts {
  const order = orderByClause(input.order_by ?? 'ca');
  const extraFilter = input.cdcli ? 'AND  E.CDCLI = ?' : '';
  const sql = `
    SELECT
      E.CDSOC,
      E.CDCLI,
      C.RAISON,
      C.CDREP,
      ${CA_EXPR}   AS CA_HT,
      ${COUT_EXPR} AS COUT_ACHAT_HT,
      ${MB_EXPR}   AS MARGE_HT,
      ${TX_EXPR}   AS TAUX_MARGE_PCT
    FROM   CFACENT E
    JOIN   CFACLGN L ON L.CDSOC=E.CDSOC AND L.FACNUMC=E.FACNUMC
    JOIN   CLIENTS C  ON C.CDSOC=E.CDSOC AND C.CDCLI=E.CDCLI
    ${PARAM_JOIN}
    WHERE  ${socFilter.clause}
      AND  E.FACDATE BETWEEN ? AND ?
      AND  L.FACQTE <> 0
      ${extraFilter}
    GROUP  BY E.CDSOC, E.CDCLI, C.RAISON, C.CDREP
    ORDER  BY ${order}
    FETCH FIRST ${limit} ROWS ONLY`;
  const binds: unknown[] = [...socFilter.values, input.date_debut, input.date_fin];
  if (input.cdcli) binds.push(input.cdcli);
  return { sql, binds };
}

/** Builds SQL + bind array for the 'article' axis */
function buildArticleQuery(input: CaMarginInput, socFilter: ReturnType<typeof buildSocietyFilter>, limit: number): QueryParts {
  const order = orderByClause(input.order_by ?? 'ca');
  // Use L.CDSOC in WHERE for article axis (join direction reversed)
  const socClause = socFilter.clause.replace(/E\.CDSOC/g, 'L.CDSOC');
  const extraFilter = input.cdart ? 'AND  L.CDART = ?' : '';
  const sql = `
    SELECT
      L.CDSOC,
      L.CDART,
      A.ARTLIB,
      A.ARTFAM,
      SUM(L.FACQTE)  AS QTE_FACTUREE,
      ${CA_EXPR}     AS CA_HT,
      ${COUT_EXPR}   AS COUT_ACHAT_HT,
      ${MB_EXPR}     AS MARGE_HT,
      ${TX_EXPR}     AS TAUX_MARGE_PCT
    FROM   CFACLGN L
    JOIN   CFACENT E ON E.CDSOC=L.CDSOC AND E.FACNUMC=L.FACNUMC
    JOIN   ARTICLE A ON A.CDSOC=L.CDSOC AND A.CDART=L.CDART
    ${PARAM_JOIN}
    WHERE  ${socClause}
      AND  E.FACDATE BETWEEN ? AND ?
      AND  L.FACQTE <> 0
      ${extraFilter}
    GROUP  BY L.CDSOC, L.CDART, A.ARTLIB, A.ARTFAM
    ORDER  BY ${order}
    FETCH FIRST ${limit} ROWS ONLY`;
  const binds: unknown[] = [...socFilter.values, input.date_debut, input.date_fin];
  if (input.cdart) binds.push(input.cdart);
  return { sql, binds };
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

/** Maps a raw DB2 row to a typed CaMarginRow */
function mapRow(raw: Record<string, unknown>, axis: Axis): CaMarginRow {
  const base: CaMarginRow = {
    cdsoc:         String(raw.CDSOC ?? '').trim(),
    ca_ht:         Number(raw.CA_HT ?? 0),
    cout_achat_ht: Number(raw.COUT_ACHAT_HT ?? 0),
    marge_ht:      Number(raw.MARGE_HT ?? 0),
    taux_marge_pct: raw.TAUX_MARGE_PCT != null ? Number(raw.TAUX_MARGE_PCT) : null,
  };
  if (axis === 'client') {
    base.cdcli  = raw.CDCLI  != null ? Number(raw.CDCLI)         : undefined;
    base.raison = raw.RAISON != null ? String(raw.RAISON).trim() : undefined;
    base.cdrep  = raw.CDREP  != null ? String(raw.CDREP).trim()  : undefined;
  }
  if (axis === 'article') {
    base.cdart        = raw.CDART  != null ? String(raw.CDART).trim()  : undefined;
    base.artlib       = raw.ARTLIB != null ? String(raw.ARTLIB).trim() : undefined;
    base.artfam       = raw.ARTFAM != null ? String(raw.ARTFAM).trim() : undefined;
    base.qte_facturee = raw.QTE_FACTUREE != null ? Number(raw.QTE_FACTUREE) : undefined;
  }
  return base;
}

/** Computes aggregate totals from mapped rows */
function computeTotals(rows: CaMarginRow[]): CaMarginTotals {
  const t = rows.reduce(
    (acc, r) => ({
      ca_ht:        acc.ca_ht        + r.ca_ht,
      cout_achat_ht: acc.cout_achat_ht + r.cout_achat_ht,
      marge_ht:     acc.marge_ht    + r.marge_ht,
    }),
    { ca_ht: 0, cout_achat_ht: 0, marge_ht: 0 }
  );
  return {
    ...t,
    taux_marge_pct: t.ca_ht === 0
      ? null
      : Math.round(t.marge_ht / t.ca_ht * 10000) / 100,
  };
}

// ---------------------------------------------------------------------------
// Main tool handler
// ---------------------------------------------------------------------------

/**
 * Calculate HT revenue and gross margin for groupe TINI.
 *
 * @param input - Axis, date range, optional filters and session context
 */
export async function calculateCaMarginTool(input: CaMarginInput): Promise<CaMarginResult> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  const socFilter = buildSocietyFilter(input.cdsoc);

  let parts: QueryParts;
  switch (input.axis) {
    case 'society': parts = buildSocietyQuery(input, socFilter, limit); break;
    case 'client':  parts = buildClientQuery(input, socFilter, limit);  break;
    case 'article': parts = buildArticleQuery(input, socFilter, limit); break;
  }

  log.debug(
    { axis: input.axis, date_debut: input.date_debut, date_fin: input.date_fin, limit },
    'Calculating CA/margin'
  );

  try {
    const result = await executeQuery(parts.sql, parts.binds, input.sessionId);
    const rows = result.rows.map(r => mapRow(r, input.axis));
    const totals = computeTotals(rows);

    log.info({ axis: input.axis, row_count: rows.length }, 'CA/margin calculation completed');

    return {
      success:   true,
      axis:      input.axis,
      period:    { date_debut: input.date_debut, date_fin: input.date_fin },
      rows,
      totals,
      row_count: rows.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.debug({ err: error }, 'CA/margin calculation failed');
    return { success: false, error: message };
  }
}
