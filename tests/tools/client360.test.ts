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
        if (q.includes('FROM CFACLGN') && q.includes('GROUP BY')) {
          if (q.includes('ARTLIB')) {
            return Promise.resolve(makeResult([
              { CDART: 'ART001', ARTLIB: 'SACS 110L', ARTFAM: 'HYGIEN', FACDATE: 20250615, QTE_FACTUREE: 3000, CA_HT: 11000, MARGE_HT: 3500 },
              { CDART: 'ART001', ARTLIB: 'SACS 110L', ARTFAM: 'HYGIEN', FACDATE: 20240615, QTE_FACTUREE: 1000, CA_HT: 4000,  MARGE_HT: 1500 },
              { CDART: 'ART001', ARTLIB: 'SACS 110L', ARTFAM: 'HYGIEN', FACDATE: 20241015, QTE_FACTUREE: 1000, CA_HT: 3000,  MARGE_HT: 1000 },
              { CDART: 'ART001', ARTLIB: 'SACS 110L', ARTFAM: 'HYGIEN', FACDATE: 20230615, QTE_FACTUREE: 800,  CA_HT: 2400,  MARGE_HT: 800 },
              { CDART: 'ART001', ARTLIB: 'SACS 110L', ARTFAM: 'HYGIEN', FACDATE: 20231015, QTE_FACTUREE: 200,  CA_HT: 600,   MARGE_HT: 200 },
              { CDART: 'ART002', ARTLIB: 'GANTS B',   ARTFAM: 'HYGIEN', FACDATE: 20250615, QTE_FACTUREE: 1500, CA_HT: 7000,  MARGE_HT: 2000 },
              { CDART: 'ART002', ARTLIB: 'GANTS B',   ARTFAM: 'HYGIEN', FACDATE: 20240615, QTE_FACTUREE: 500,  CA_HT: 2000,  MARGE_HT: 700 },
              { CDART: 'ART002', ARTLIB: 'GANTS B',   ARTFAM: 'HYGIEN', FACDATE: 20230615, QTE_FACTUREE: 400,  CA_HT: 1600,  MARGE_HT: 500 },
            ]));
          } else {
            return Promise.resolve(makeResult([
              { CDART: 'ART001', CA_HT: 18000 },
              { CDART: 'ART002', CA_HT: 9000 },
            ]));
          }
        }
        if (q.includes('GROUP BY') && q.includes('FACDATE')) {
          return Promise.resolve(makeResult([
            { ANNEE: 2025, MOIS: 6, CA_HT: 14200, MARGE_HT: 3700 },
            { ANNEE: 2025, MOIS: 5, CA_HT: 12800, MARGE_HT: 3200 },
          ]));
        }
        if (q.includes('FROM CFACENT')) {
          // Distinguish N vs N-1 by the date_debut bind (year * 10000 + 101)
          const dateDebut = b.find(v => typeof v === 'number' && v > 20000000);
          const anneeDebut = dateDebut ? Math.floor(Number(dateDebut) / 10000) : 0;
          return Promise.resolve(makeResult([anneeDebut >= 2025
            ? { CA_HT: 145000, COUT_ACHAT_HT: 107000, MARGE_HT: 38000, TAUX_MARGE_PCT: 26.21 }
            : { CA_HT: 132000, COUT_ACHAT_HT: 98000,  MARGE_HT: 34000, TAUX_MARGE_PCT: 25.76 },
          ]));
        }
        if (q.includes('FROM CLIRFA'))   return Promise.resolve(makeResult([{ RFATAUX: 0.5, RFAAA: 2025 }]));
        if (q.includes('FROM TOURNEL'))  return Promise.resolve(makeResult(tournelRow));
        if (q.includes('FROM CLILIV'))   return Promise.resolve(makeResult(cliliv));
        if (q.includes('FROM CLIVENT')) {
          return Promise.resolve(makeResult([
            { EXPDATE: 20250615, PORT_FACTURE: 25.50, PORT_DEPENSE: 25.50 },
            { EXPDATE: 20250510, PORT_FACTURE: 0.0,   PORT_DEPENSE: 0.00 }, // Franco
            { EXPDATE: 20240615, PORT_FACTURE: 35.00, PORT_DEPENSE: 35.00 },
            { EXPDATE: 20241015, PORT_FACTURE: 15.00, PORT_DEPENSE: 15.00 },
          ]));
        }
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

    it('maps top_articles with YTD N, Full N-1, YTD N-1, Full N-2, and YTD N-2 breakdown', async () => {
      const result = await getClient360Tool({ cdsoc: '01', cdcli: 123, annee: 2025 });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.top_articles).toHaveLength(2);

      const art1 = result.top_articles.find(a => a.cdart === 'ART001')!;
      expect(art1).toBeDefined();
      expect(art1.artlib).toBe('SACS 110L');
      expect(art1.artfam).toBe('HYGIEN');

      // Année N YTD (2025) -> qte = 3000, ca = 11000, mb = 3500
      expect(art1.annee_n.qte_livree).toBe(3000);
      expect(art1.annee_n.ca_ht).toBe(11000);
      expect(art1.annee_n.mb_ht).toBe(3500);

      // Année N-1 Entière (2024) -> qte = 1000 + 1000 = 2000, ca = 4000 + 3000 = 7000, mb = 1500 + 1000 = 2500
      expect(art1.annee_n1.qte_livree).toBe(2000);
      expect(art1.annee_n1.ca_ht).toBe(7000);
      expect(art1.annee_n1.mb_ht).toBe(2500);

      // Année N-1 YTD (mois <= 6 de 2024) -> qte = 1000, ca = 4000, mb = 1500
      expect(art1.annee_n1_ytd.qte_livree).toBe(1000);
      expect(art1.annee_n1_ytd.ca_ht).toBe(4000);
      expect(art1.annee_n1_ytd.mb_ht).toBe(1500);

      // Année N-2 Entière (2023) -> qte = 800 + 200 = 1000, ca = 2400 + 600 = 3000, mb = 800 + 200 = 1000
      expect(art1.annee_n2.qte_livree).toBe(1000);
      expect(art1.annee_n2.ca_ht).toBe(3000);
      expect(art1.annee_n2.mb_ht).toBe(1000);

      // Année N-2 YTD (mois <= 6 de 2023) -> qte = 800, ca = 2400, mb = 800
      expect(art1.annee_n2_ytd.qte_livree).toBe(800);
      expect(art1.annee_n2_ytd.ca_ht).toBe(2400);
      expect(art1.annee_n2_ytd.mb_ht).toBe(800);
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

    it('maps transport bloc with sites count and comparative shipping costs', async () => {
      const result = await getClient360Tool({ cdsoc: '01', cdcli: 123, annee: 2025 });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.transport.cdtport).toBe('F');
      expect(result.transport.cdtrnliv).toBe('TOUR01');
      expect(result.transport.total_sites).toBe(1);
      expect(result.transport.sites_par_departement).toEqual({ '59': 1 });

      // Validation comparative port
      expect(result.transport.frais_port.annee_n).toEqual({
        facture: 25.5,
        depense: 25.5,
        depense_moyen: 25.5,
        nb_livraisons: 2,
      });
      expect(result.transport.frais_port.annee_n1).toEqual({
        facture: 50.0,
        depense: 50.0,
        depense_moyen: 25.0,
        nb_livraisons: 2,
      });
      expect(result.transport.frais_port.annee_n1_ytd).toEqual({
        facture: 35.0,
        depense: 35.0,
        depense_moyen: 35.0,
        nb_livraisons: 1,
      });
    });

    it('groups departments and limits to Top 10 with Autre dept fallback', async () => {
      const multiCliliv = [
        { CDPOST: '75001' }, { CDPOST: '75002' }, { CDPOST: '75003' }, // 75: 3
        { CDPOST: '92000' }, { CDPOST: '92100' },                    // 92: 2
        { CDPOST: '93000' }, { CDPOST: '93100' },                    // 93: 2
        { CDPOST: '94000' },                                         // 94: 1
        { CDPOST: '69000' },                                         // 69: 1
        { CDPOST: '13000' },                                         // 13: 1
        { CDPOST: '33000' },                                         // 33: 1
        { CDPOST: '31000' },                                         // 31: 1
        { CDPOST: '44000' },                                         // 44: 1
        { CDPOST: '59000' },                                         // 59: 1
        { CDPOST: '21000' },                                         // 21: 1 -> should go to Autre dept
        { CDPOST: '22000' },                                         // 22: 1 -> should go to Autre dept
      ];

      mockExecuteQuery.mockImplementation((sql: unknown) => {
        const q = String(sql).replace(/\s+/g, ' ').toUpperCase();
        if (q.includes('FROM CLIENTS'))  return Promise.resolve(makeResult([clientsRow]));
        if (q.includes('FROM TOURNEL'))  return Promise.resolve(makeResult(tournelRow));
        if (q.includes('FROM CLILIV'))   return Promise.resolve(makeResult(multiCliliv));
        if (q.includes('FROM CLIVENT'))  return Promise.resolve(makeResult([]));
        return Promise.resolve(makeResult([]));
      });

      const result = await getClient360Tool({ cdsoc: '01', cdcli: 123, annee: 2025 });

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.transport.total_sites).toBe(16);
      
      const keys = Object.keys(result.transport.sites_par_departement);
      expect(keys).toHaveLength(11);
      expect(result.transport.sites_par_departement['75']).toBe(3);
      expect(result.transport.sites_par_departement['92']).toBe(2);
      expect(result.transport.sites_par_departement['93']).toBe(2);
      expect(result.transport.sites_par_departement['Autre dept']).toBe(2);
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
        if (q.includes('FROM CLIVENT'))  return Promise.resolve(makeResult([]));
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
