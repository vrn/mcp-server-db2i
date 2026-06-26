/**
 * Unit tests for getClient360Tool
 *
 * DB2 queries are mocked via vi.mock('../../src/db/connection.js').
 * Tests cover: identity gate, ca_n_n1 mapping, tendance_mensuelle pivot,
 * alertes bloc, transport bloc, and adrnum filter propagation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QueryResult } from '../../src/db/connection.js';

const mockExecuteQuery = vi.fn<() => Promise<QueryResult>>();
vi.mock('../../src/db/connection.js', () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
  initializePool: vi.fn(),
}));

import { getClient360Tool } from '../../src/tools/client360.js';

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

/** Minimal CLIENTS row fixture */
const clientsRow: Record<string, unknown> = {
  RAISON: 'DUPONT SAS   ', ADRESS1: '12 RUE DE LA PAIX', ADRESS2: '', ADRESS3: '',
  CDPOST: '75001', VILLE: 'PARIS', CDPAYS: 'FR', SIREN: '123456789',
  CDREP: 'COM', CDCATCLI: 'GRD', CDGROUPE: 'GRPA', CLISTAT: 'ACT', INACTIF: ' ',
  ENCCPT: 32000, ENCTOT: 45000, CDSURV: '1', BILBLOC: ' ',
  CDTPORT: 'F', VFRANCO: 500, CDTRNLIV: 'TOUR01', NOTRNLIV: 0,
  LIVDAYS: '1111100', AMDTIMLIV: 0, AMFTIMLIV: 0, PMDTIMLIV: 0, PMFTIMLIV: 0,
  LIVRVL: ' ', LIVRMANU: ' ', LIVRDEPO: ' ', LIVRRDV: ' ', LIVRPAMS: ' ',
  ILIVRAIS: 'Appeler avant livraison', RLIVRAIS: '',
};

/** CRMCAHT row with 2 populated slots */
function crmcahtRow(slots: Array<{ nn: string; annee: number; mois: number; ca: number; mb: number }>) {
  const row: Record<string, unknown> = {};
  for (let i = 1; i <= 24; i++) {
    const nn = String(i).padStart(2, '0');
    row[`WCAHT${nn}`] = 0; row[`WMBHT${nn}`] = 0; row[`WANNE${nn}`] = 0; row[`WMOIS${nn}`] = 0;
  }
  for (const s of slots) {
    row[`WCAHT${s.nn}`] = s.ca;
    row[`WMBHT${s.nn}`] = s.mb;
    row[`WANNE${s.nn}`] = s.annee;
    row[`WMOIS${s.nn}`] = s.mois;
  }
  return row;
}

/**
 * CRMCONSO row fixture — uses CRMCONSO slot column schema:
 * CDART (10A), WQLIV01-12 (qty), WPVHT01-12 (PV unit HT),
 * WP100 01-12 (% remise ×100 — so 0 = no discount), WPRHT01-12 (PR unit HT)
 *
 * Slot 01: ART001 — qty=5000, pv=3.60 (no rem), pr=2.40  → ca=18000, mb=6000
 * Slot 02: ART002 — qty=2000, pv=4.50 (no rem), pr=3.15  → ca=9000, mb=2700
 * Slots 03-12: empty (qty=0)
 */
const crmconsoRows: Record<string, unknown>[] = [
  {
    CDART: 'ART001',
    WQLIV01: 5000, WPVHT01: 3.60, WP10001: 0, WPRHT01: 2.40,
    WQLIV02: 2000, WPVHT02: 4.50, WP10002: 0, WPRHT02: 3.15,
    ...Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => {
        const nn = String(i + 3).padStart(2, '0');
        return [
          [`WQLIV${nn}`, 0], [`WPVHT${nn}`, 0], [`WP100${nn}`, 0], [`WPRHT${nn}`, 0],
        ];
      }).flat()
    ),
  },
];

/**
 * Minimal CLILIV result — the query includes LEFT JOIN TOURNEL inline,
 * so LBTRNLIV and CDTRANS come from the JOIN (COALESCE'd to '' if no match).
 */
const cliliv: Record<string, unknown>[] = [{
  ADRNUM: 1, RAISON: 'SITE NORD', ADRESS1: '5 AV DU PORT', CDPOST: '59000', VILLE: 'LILLE', CDPAYS: 'FR',
  CDTRNLIV: 'TOUR01', LIVDAYS: '1111100', NOTRNLIV: 0,
  LIVRVL: ' ', LIVRMANU: ' ', LIVRDEPO: ' ', LIVRRDV: ' ', LIVRPAMS: ' ',
  VFRANCO: 500, INACTIF: ' ',
  LBTRNLIV: 'TOUR NORD', CDTRANS: 'TNT',   // joined from TOURNEL inline
}];

/** TOURNEL row */
const tournelRow: Record<string, unknown>[] = [{ LBTRNLIV: 'TOUR NORD', CDTRANS: 'TNT' }];

function makeResult(rows: Record<string, unknown>[]): QueryResult {
  return { rows };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getClient360Tool', () => {
  beforeEach(() => vi.clearAllMocks());

  // ---- identity gate -------------------------------------------------------

  describe('identity gate', () => {
    it('returns success:false when client not found', async () => {
      // queryIdentite → empty
      mockExecuteQuery.mockResolvedValueOnce(makeResult([]));

      const result = await getClient360Tool({ cdsoc: '01', cdcli: 99999, annee: 2025 });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toMatch(/99999/);
    });

    it('returns success:false when DB throws on identity', async () => {
      mockExecuteQuery.mockRejectedValueOnce(new Error('JDBC failure'));

      const result = await getClient360Tool({ cdsoc: '01', cdcli: 12345, annee: 2025 });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toMatch(/JDBC failure/);
    });
  });

  // ---- successful full response -------------------------------------------

  describe('successful response', () => {
    beforeEach(() => {
      // Promise.all runs branches concurrently — parallel call order is non-deterministic.
      // Route by SQL table name + bind values so each query gets the right fixture.
      mockExecuteQuery.mockImplementation((sql: unknown, binds: unknown) => {
        const q = String(sql).replace(/\s+/g, ' ').toUpperCase();
        const b = (binds as unknown[] | undefined) ?? [];
        if (q.includes('FROM CLIENTS'))  return Promise.resolve(makeResult([clientsRow]));
        if (q.includes('FROM CFACENT')) {
          // Distinguish N vs N-1 by the date_debut bind (year * 10000 + 101)
          const dateDebut = b.find(v => typeof v === 'number' && v > 20000000);
          const anneeDebut = dateDebut ? Math.floor(Number(dateDebut) / 10000) : 0;
          return Promise.resolve(makeResult([anneeDebut >= 2025
            ? { CA_HT: 145000, COUT_ACHAT_HT: 107000, MARGE_HT: 38000, TAUX_MARGE_PCT: 26.21 }
            : { CA_HT: 132000, COUT_ACHAT_HT: 98000,  MARGE_HT: 34000, TAUX_MARGE_PCT: 25.76 },
          ]));
        }
        if (q.includes('FROM CRMCAHT'))  return Promise.resolve(makeResult([crmcahtRow([
          { nn: '01', annee: 2025, mois: 6, ca: 14200, mb: 3700 },
          { nn: '02', annee: 2025, mois: 5, ca: 12800, mb: 3200 },
        ])]));
        if (q.includes('FROM CRMCONSO')) return Promise.resolve(makeResult(crmconsoRows));
        if (q.includes('FROM ARTICLE'))  return Promise.resolve(makeResult([
          { CDART: 'ART001', ARTLIB: 'SACS 110L', ARTFAM: 'HYGIEN' },
          { CDART: 'ART002', ARTLIB: 'GANTS B',   ARTFAM: 'HYGIEN' },
        ]));
        if (q.includes('FROM CLIRFA'))   return Promise.resolve(makeResult([{ RFATAUX: 0.5, RFAAA: 2025 }]));
        if (q.includes('FROM TOURNEL'))  return Promise.resolve(makeResult(tournelRow));
        if (q.includes('FROM CLILIV'))   return Promise.resolve(makeResult(cliliv));
        return Promise.resolve(makeResult([]));
      });
    });

    it('returns success:true with all 6 blocs', async () => {
      const result = await getClient360Tool({ cdsoc: '01', cdcli: 123, annee: 2025 });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.cdsoc).toBe('01');
      expect(result.cdcli).toBe(123);
      expect(result.annee).toBe(2025);
      expect(result.adrnum).toBeNull();
      expect(result.identite).toBeDefined();
      expect(result.ca_n_n1).toBeDefined();
      expect(result.tendance_mensuelle).toBeDefined();
      expect(result.top_articles).toBeDefined();
      expect(result.alertes).toBeDefined();
      expect(result.transport).toBeDefined();
    });

    it('maps identite correctly (trims whitespace)', async () => {
      const result = await getClient360Tool({ cdsoc: '01', cdcli: 123, annee: 2025 });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.identite.raison).toBe('DUPONT SAS');
      expect(result.identite.cdrep).toBe('COM');
    });

    it('maps ca_n_n1 correctly', async () => {
      const result = await getClient360Tool({ cdsoc: '01', cdcli: 123, annee: 2025 });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.ca_n_n1.annee_n.annee).toBe(2025);
      expect(result.ca_n_n1.annee_n.ca_ht).toBe(145000);
      expect(result.ca_n_n1.annee_n.marge_ht).toBe(38000);
      expect(result.ca_n_n1.annee_n1.annee).toBe(2024);
      expect(result.ca_n_n1.annee_n1.ca_ht).toBe(132000);
    });

    it('maps tendance_mensuelle sorted most-recent first', async () => {
      const result = await getClient360Tool({ cdsoc: '01', cdcli: 123, annee: 2025 });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.tendance_mensuelle.length).toBeGreaterThan(0);
      expect(result.tendance_mensuelle[0].annee).toBe(2025);
      expect(result.tendance_mensuelle[0].mois).toBe(6);
    });

    it('maps alertes with enctot/enccpt from CLIENTS row and rfa_taux from CLIRFA', async () => {
      const result = await getClient360Tool({ cdsoc: '01', cdcli: 123, annee: 2025 });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.alertes.enctot).toBe(45000);
      expect(result.alertes.enccpt).toBe(32000);
      // rfa_taux comes from CLIRFA row — RFATAUX field
      expect(result.alertes.rfa_taux).toBe(0.5);
      expect(result.alertes.rfa_annee).toBe(2025);
      expect(result.alertes.cdsurv).toBe('1');
      expect(result.alertes.lib_surv).toBe('RAS');
    });

    it('maps transport bloc with CLILIV addresses', async () => {
      const result = await getClient360Tool({ cdsoc: '01', cdcli: 123, annee: 2025 });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.transport.cdtport).toBe('F');
      expect(result.transport.cdtrnliv).toBe('TOUR01');
      expect(result.transport.adresses_livraison).toHaveLength(1);
      expect(result.transport.adresses_livraison[0].lbtrnliv).toBe('TOUR NORD');
    });
  });

  // ---- adrnum filter -------------------------------------------------------

  describe('adrnum filter', () => {
    it('echoes adrnum in the result', async () => {
      // Use SQL-routing mock — same pattern as successful response tests
      mockExecuteQuery.mockImplementation((sql: unknown) => {
        const q = String(sql).replace(/\s+/g, ' ').toUpperCase();
        if (q.includes('FROM CLIENTS'))  return Promise.resolve(makeResult([clientsRow]));
        if (q.includes('FROM TOURNEL'))  return Promise.resolve(makeResult(tournelRow));
        if (q.includes('FROM CLILIV'))   return Promise.resolve(makeResult([])); // adrnum=2 → no match
        return Promise.resolve(makeResult([{ CA_HT: 0, COUT_ACHAT_HT: 0, MARGE_HT: 0, TAUX_MARGE_PCT: null }]));
      });

      const result = await getClient360Tool({ cdsoc: '01', cdcli: 123, annee: 2025, adrnum: 2 });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.adrnum).toBe(2);
    });
  });

  // ---- error handling in parallel bloc ------------------------------------

  describe('parallel queries error', () => {
    it('returns success:false when a parallel query throws', async () => {
      mockExecuteQuery
        .mockResolvedValueOnce(makeResult([clientsRow]))          // identite OK
        .mockRejectedValueOnce(new Error('timeout'));             // ca N fails

      const result = await getClient360Tool({ cdsoc: '01', cdcli: 123, annee: 2025 });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toMatch(/timeout/);
    });
  });
});
