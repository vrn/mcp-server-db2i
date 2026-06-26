/**
 * Unit tests for calculateCaMarginTool
 *
 * DB2 queries are mocked via vi.mock('../../src/db/connection.js').
 * Tests verify: SQL construction correctness, row mapping, totals computation,
 * date format (AAAAMMJJ), CDSOC in WHERE, axis routing, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QueryResult } from '../../src/db/connection.js';

// Mock executeQuery before importing the tool
const mockExecuteQuery = vi.fn<() => Promise<QueryResult>>();
vi.mock('../../src/db/connection.js', () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
  initializePool: vi.fn(),
}));

import { calculateCaMarginTool } from '../../src/tools/caMargin.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal QueryResult with the given rows */
function makeResult(rows: Record<string, unknown>[]): QueryResult {
  return { rows };
}

/** Returns the SQL string passed to the first mockExecuteQuery call */
function capturedSql(): string {
  return String(mockExecuteQuery.mock.calls[0][0]);
}

/** Returns the bind array passed to the first mockExecuteQuery call */
function capturedBinds(): unknown[] {
  return mockExecuteQuery.mock.calls[0][1] as unknown[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('calculateCaMarginTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- axis: society -------------------------------------------------------

  describe('axis = society', () => {
    it('returns success:true with mapped rows', async () => {
      mockExecuteQuery.mockResolvedValueOnce(makeResult([
        { CDSOC: '01', CA_HT: 150000, COUT_ACHAT_HT: 110000, MARGE_HT: 40000, TAUX_MARGE_PCT: 26.67 },
        { CDSOC: '03', CA_HT:  80000, COUT_ACHAT_HT:  60000, MARGE_HT: 20000, TAUX_MARGE_PCT: 25.00 },
      ]));

      const result = await calculateCaMarginTool({
        axis: 'society',
        date_debut: '20250101',
        date_fin: '20251231',
        cdsoc: ['01', '03'],
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.axis).toBe('society');
      expect(result.row_count).toBe(2);
      expect(result.rows[0].cdsoc).toBe('01');
      expect(result.rows[0].ca_ht).toBe(150000);
      expect(result.rows[0].marge_ht).toBe(40000);
      expect(result.rows[0].taux_marge_pct).toBe(26.67);
    });

    it('places date_debut / date_fin as AAAAMMJJ integers in binds', async () => {
      mockExecuteQuery.mockResolvedValueOnce(makeResult([]));

      await calculateCaMarginTool({
        axis: 'society',
        date_debut: '20250101',
        date_fin: '20251231',
        cdsoc: '01',
      });

      const binds = capturedBinds();
      expect(binds).toContain('20250101');
      expect(binds).toContain('20251231');
    });

    it('includes CDSOC in the WHERE clause', async () => {
      mockExecuteQuery.mockResolvedValueOnce(makeResult([]));

      await calculateCaMarginTool({
        axis: 'society',
        date_debut: '20250101',
        date_fin: '20251231',
        cdsoc: '01',
      });

      expect(capturedSql()).toMatch(/E\.CDSOC\s+IN/i);
    });

    it('computes aggregate totals correctly', async () => {
      mockExecuteQuery.mockResolvedValueOnce(makeResult([
        { CDSOC: '01', CA_HT: 100, COUT_ACHAT_HT: 70, MARGE_HT: 30, TAUX_MARGE_PCT: 30 },
        { CDSOC: '03', CA_HT: 200, COUT_ACHAT_HT: 140, MARGE_HT: 60, TAUX_MARGE_PCT: 30 },
      ]));

      const result = await calculateCaMarginTool({
        axis: 'society',
        date_debut: '20250101',
        date_fin: '20251231',
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.totals.ca_ht).toBe(300);
      expect(result.totals.cout_achat_ht).toBe(210);
      expect(result.totals.marge_ht).toBe(90);
      expect(result.totals.taux_marge_pct).toBe(30);
    });

    it('returns taux_marge_pct: null when CA = 0', async () => {
      mockExecuteQuery.mockResolvedValueOnce(makeResult([
        { CDSOC: '01', CA_HT: 0, COUT_ACHAT_HT: 0, MARGE_HT: 0, TAUX_MARGE_PCT: null },
      ]));

      const result = await calculateCaMarginTool({
        axis: 'society',
        date_debut: '20250101',
        date_fin: '20251231',
        cdsoc: '01',
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.totals.taux_marge_pct).toBeNull();
    });
  });

  // ---- axis: client --------------------------------------------------------

  describe('axis = client', () => {
    it('maps CDCLI and RAISON from result rows', async () => {
      mockExecuteQuery.mockResolvedValueOnce(makeResult([
        { CDSOC: '01', CDCLI: 12345, RAISON: 'DUPONT SAS   ', CDREP: 'COM',
          CA_HT: 45000, COUT_ACHAT_HT: 32000, MARGE_HT: 13000, TAUX_MARGE_PCT: 28.89 },
      ]));

      const result = await calculateCaMarginTool({
        axis: 'client',
        date_debut: '20250101',
        date_fin: '20251231',
        cdsoc: '01',
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.rows[0].cdcli).toBe(12345);
      expect(result.rows[0].raison).toBe('DUPONT SAS');   // trimmed
      expect(result.rows[0].cdrep).toBe('COM');
    });

    it('adds cdcli bind when cdcli filter is provided', async () => {
      mockExecuteQuery.mockResolvedValueOnce(makeResult([]));

      await calculateCaMarginTool({
        axis: 'client',
        date_debut: '20250101',
        date_fin: '20251231',
        cdsoc: '01',
        cdcli: 99999,
      });

      expect(capturedBinds()).toContain(99999);
    });
  });

  // ---- axis: article -------------------------------------------------------

  describe('axis = article', () => {
    it('maps CDART, ARTLIB, ARTFAM and QTE_FACTUREE', async () => {
      mockExecuteQuery.mockResolvedValueOnce(makeResult([
        { CDSOC: '01', CDART: 'ART001    ', ARTLIB: 'SACS 110L  ', ARTFAM: 'HYGIEN',
          QTE_FACTUREE: 5000, CA_HT: 18000, COUT_ACHAT_HT: 12000, MARGE_HT: 6000, TAUX_MARGE_PCT: 33.33 },
      ]));

      const result = await calculateCaMarginTool({
        axis: 'article',
        date_debut: '20250101',
        date_fin: '20251231',
        cdsoc: '01',
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.rows[0].cdart).toBe('ART001');
      expect(result.rows[0].artlib).toBe('SACS 110L');
      expect(result.rows[0].qte_facturee).toBe(5000);
    });
  });

  // ---- error handling ------------------------------------------------------

  describe('error handling', () => {
    it('returns success:false when executeQuery throws', async () => {
      mockExecuteQuery.mockRejectedValueOnce(new Error('DB2 connection lost'));

      const result = await calculateCaMarginTool({
        axis: 'society',
        date_debut: '20250101',
        date_fin: '20251231',
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('DB2 connection lost');
    });
  });
});
