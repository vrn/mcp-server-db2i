/**
 * Unit tests for getFournisseur360Tool
 *
 * DB2 queries are mocked via vi.mock('../../src/db/connection.js').
 * Tests cover: identity gate, achats_n_n1 mapping, tendance_mensuelle,
 * top_articles, alertes, transport bloc (conditions + frets N/N-1),
 * and cdagel filter propagation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QueryResult } from '../../src/db/connection.js';

const mockExecuteQuery = vi.fn<() => Promise<QueryResult>>();
vi.mock('../../src/db/connection.js', () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
  initializePool: vi.fn(),
}));

import { getFournisseur360Tool } from '../../src/tools/fournisseur360.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeResult(rows: Record<string, unknown>[]): QueryResult {
  return { rows };
}

/** FOURNIS row fixture */
const fournisRow: Record<string, unknown> = {
  RAISON: 'PAPETERIES DU NORD', ADRESS1: '1 BD LIBERTÉ', ADRESS2: '', ADRESS3: '',
  CDPOST: '59000', VILLE: 'LILLE', CDPAYS: 'FR',
  SIREN: '987654321', CDNAF: '17.12Z', CDDEVIS: 'EUR',
  LIVDLY: 5, BLOQUE: ' ', RGLCD: '30J',
  CDTPORT: 'F', FTARIF: 'N', VALFRANC: 150, PALFRANC: 2, PDSFRANC: 500, CARFRANC: 0,
};

const achatsRowN: Record<string, unknown>  = { ACHAT_HT: 87000, QTE_LIVREE: 125000 };
const achatsRowN1: Record<string, unknown> = { ACHAT_HT: 79000, QTE_LIVREE: 118000 };

const tendanceRows: Record<string, unknown>[] = [
  { AAAAMM: 202506, ACHAT_HT: 8200, QTE_LIVREE: 11500 },
  { AAAAMM: 202505, ACHAT_HT: 7600, QTE_LIVREE: 10800 },
];

const topArticlesRows: Record<string, unknown>[] = [
  { CDART: 'ART042', ARTLIB: 'PAPIER A4 80G', ARTFAM: 'PAPIER', QTE_LIVREE: 45000, ACHAT_HT: 18500 },
];

const rfaRow: Record<string, unknown> = { RFATAUX: 2.0, RFAAA: 2025, RFAOBTNU: 1700, RFASEUIL: 50000 };

const fretsRowN:  Record<string, unknown> = { FRAIS_PORT: 320, FRAIS_TRANSPORT: 180 };
const fretsRowN1: Record<string, unknown> = { FRAIS_PORT: 290, FRAIS_TRANSPORT: 160 };

// ---------------------------------------------------------------------------
// Helper — sets up the standard 8-query mock sequence
// ---------------------------------------------------------------------------

function setupFullMocks() {
  // Call order from Promise.all (after queryIdentite):
  // 1. queryAchatsYear N
  // 2. queryAchatsYear N-1
  // 3. queryTendanceMensuelle
  // 4. queryTopArticles
  // 5. queryRfa
  // 6. queryFrets N
  // 7. queryFrets N-1
  mockExecuteQuery
    .mockResolvedValueOnce(makeResult([fournisRow]))         // 0. identite
    .mockResolvedValueOnce(makeResult([achatsRowN]))         // 1. achats N
    .mockResolvedValueOnce(makeResult([achatsRowN1]))        // 2. achats N-1
    .mockResolvedValueOnce(makeResult(tendanceRows))         // 3. tendance
    .mockResolvedValueOnce(makeResult(topArticlesRows))      // 4. top_articles
    .mockResolvedValueOnce(makeResult([rfaRow]))             // 5. rfa
    .mockResolvedValueOnce(makeResult([fretsRowN]))          // 6. frets N
    .mockResolvedValueOnce(makeResult([fretsRowN1]));        // 7. frets N-1
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getFournisseur360Tool', () => {
  beforeEach(() => vi.clearAllMocks());

  // ---- identity gate -------------------------------------------------------

  describe('identity gate', () => {
    it('returns success:false when supplier not found', async () => {
      mockExecuteQuery.mockResolvedValueOnce(makeResult([]));

      const result = await getFournisseur360Tool({ cdsoc: '01', cdfou: 99999, annee: 2025 });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toMatch(/99999/);
    });

    it('returns success:false when DB throws on identity', async () => {
      mockExecuteQuery.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await getFournisseur360Tool({ cdsoc: '01', cdfou: 12345, annee: 2025 });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toMatch(/Connection refused/);
    });
  });

  // ---- full successful response -------------------------------------------

  describe('successful response', () => {
    beforeEach(setupFullMocks);

    it('returns success:true with all 6 blocs', async () => {
      const result = await getFournisseur360Tool({ cdsoc: '01', cdfou: 12345, annee: 2025 });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.cdsoc).toBe('01');
      expect(result.cdfou).toBe(12345);
      expect(result.annee).toBe(2025);
      expect(result.cdagel).toBeNull();
      expect(result.identite).toBeDefined();
      expect(result.achats_n_n1).toBeDefined();
      expect(result.tendance_mensuelle).toBeDefined();
      expect(result.top_articles).toBeDefined();
      expect(result.alertes).toBeDefined();
      expect(result.transport).toBeDefined();
    });

    it('maps identite correctly', async () => {
      const result = await getFournisseur360Tool({ cdsoc: '01', cdfou: 12345, annee: 2025 });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.identite.raison).toBe('PAPETERIES DU NORD');
      expect(result.identite.livdly).toBe(5);
      expect(result.identite.bloque).toBe('');
    });

    it('maps achats_n_n1 correctly', async () => {
      const result = await getFournisseur360Tool({ cdsoc: '01', cdfou: 12345, annee: 2025 });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.achats_n_n1.annee_n.annee).toBe(2025);
      expect(result.achats_n_n1.annee_n.achat_ht).toBe(87000);
      expect(result.achats_n_n1.annee_n.qte_livree).toBe(125000);
      expect(result.achats_n_n1.annee_n1.annee).toBe(2024);
      expect(result.achats_n_n1.annee_n1.achat_ht).toBe(79000);
    });

    it('maps tendance_mensuelle with annee/mois extracted from AAAAMM', async () => {
      const result = await getFournisseur360Tool({ cdsoc: '01', cdfou: 12345, annee: 2025 });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.tendance_mensuelle).toHaveLength(2);
      expect(result.tendance_mensuelle[0].annee).toBe(2025);
      expect(result.tendance_mensuelle[0].mois).toBe(6);
      expect(result.tendance_mensuelle[0].achat_ht).toBe(8200);
    });

    it('maps alertes with bloque and rfa fields', async () => {
      const result = await getFournisseur360Tool({ cdsoc: '01', cdfou: 12345, annee: 2025 });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.alertes.bloque).toBe('');
      expect(result.alertes.rfa_taux).toBe(2.0);
      expect(result.alertes.rfa_annee).toBe(2025);
      expect(result.alertes.rfa_obtenu).toBe(1700);
      expect(result.alertes.rfa_seuil).toBe(50000);
    });

    it('maps transport static conditions from FOURNIS row', async () => {
      const result = await getFournisseur360Tool({ cdsoc: '01', cdfou: 12345, annee: 2025 });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.transport.cdtport).toBe('F');
      expect(result.transport.ftarif).toBe('N');
      expect(result.transport.valfranc).toBe(150);
      expect(result.transport.palfranc).toBe(2);
      expect(result.transport.pdsfranc).toBe(500);
      expect(result.transport.carfranc).toBe(0);
      expect(result.transport.livdly).toBe(5);
    });

    it('maps transport frets_n with frais_port + frais_transport + total', async () => {
      const result = await getFournisseur360Tool({ cdsoc: '01', cdfou: 12345, annee: 2025 });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.transport.frets_n.annee).toBe(2025);
      expect(result.transport.frets_n.frais_port).toBe(320);
      expect(result.transport.frets_n.frais_transport).toBe(180);
      expect(result.transport.frets_n.frais_total).toBe(500);
    });

    it('maps transport frets_n1 correctly', async () => {
      const result = await getFournisseur360Tool({ cdsoc: '01', cdfou: 12345, annee: 2025 });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.transport.frets_n1.annee).toBe(2024);
      expect(result.transport.frets_n1.frais_port).toBe(290);
      expect(result.transport.frets_n1.frais_total).toBe(450);
    });

    it('top_articles pa_net_moyen is computed as achat_ht / qte_livree', async () => {
      const result = await getFournisseur360Tool({ cdsoc: '01', cdfou: 12345, annee: 2025 });

      expect(result.success).toBe(true);
      if (!result.success) return;
      const art = result.top_articles[0];
      expect(art.cdart).toBe('ART042');
      // pa_net_moyen is rounded to 4 decimal places in the tool
      expect(art.pa_net_moyen).toBeCloseTo(18500 / 45000, 4);
    });
  });

  // ---- cdagel filter -------------------------------------------------------

  describe('cdagel filter', () => {
    it('echoes cdagel in the result', async () => {
      setupFullMocks();

      const result = await getFournisseur360Tool({ cdsoc: '01', cdfou: 12345, annee: 2025, cdagel: '01' });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.cdagel).toBe('01');
    });

    it('passes cdagel bind value to achats query', async () => {
      setupFullMocks();

      await getFournisseur360Tool({ cdsoc: '01', cdfou: 12345, annee: 2025, cdagel: '02' });

      // After identite (call 0), calls 1+ are parallel queries — check any bind contains '02'
      const allBinds = mockExecuteQuery.mock.calls
        .slice(1)
        .flatMap(call => (call[1] as unknown[]) ?? []);
      expect(allBinds).toContain('02');
    });
  });

  // ---- error handling ------------------------------------------------------

  describe('error handling', () => {
    it('returns success:false when a parallel query rejects', async () => {
      mockExecuteQuery
        .mockResolvedValueOnce(makeResult([fournisRow]))     // identite OK
        .mockRejectedValueOnce(new Error('SQL0802 overflow')); // achats N fails

      const result = await getFournisseur360Tool({ cdsoc: '01', cdfou: 12345, annee: 2025 });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toMatch(/SQL0802/);
    });

    it('frets_n total is 0 when DB returns no rows', async () => {
      mockExecuteQuery
        .mockResolvedValueOnce(makeResult([fournisRow]))
        .mockResolvedValueOnce(makeResult([achatsRowN]))
        .mockResolvedValueOnce(makeResult([achatsRowN1]))
        .mockResolvedValueOnce(makeResult(tendanceRows))
        .mockResolvedValueOnce(makeResult(topArticlesRows))
        .mockResolvedValueOnce(makeResult([rfaRow]))
        .mockResolvedValueOnce(makeResult([]))    // frets N → empty row
        .mockResolvedValueOnce(makeResult([]));   // frets N-1 → empty row

      const result = await getFournisseur360Tool({ cdsoc: '01', cdfou: 12345, annee: 2025 });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.transport.frets_n.frais_total).toBe(0);
      expect(result.transport.frets_n1.frais_total).toBe(0);
    });
  });
});
