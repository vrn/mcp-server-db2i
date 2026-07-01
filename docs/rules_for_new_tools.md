# Rules for New Tools

This document outlines the core coding standards, database mapping constraints, and formatting requirements established for all tools.

---

## 1. Financial Amounts & Percentages Formatting

* **Requirement**: All monetary values (e.g., turnover, margins, outstanding balance, shipping costs, order amounts) and percentage metrics (e.g., margin rate, RFA rate) must be returned as **strings with exactly 2 decimal places** (e.g., `"1500.50"`, `"45.00"`).
* **Rationale**: Standard JSON float/number serialization drops trailing non-significant zeros (converting `1500.50` to `1500.5` or `45.00` to `45`). Converting to string fields using `.toFixed(2)` ensures UI consistency.
* **Exceptions**: Physical counts, delivery occurrences, or quantities (e.g., number of sites, delivery count) must remain as standard JS `number` types.

---

## 2. Deterministic Sorting & JSON Responses

* **Requirement**: Objects containing lists that must be returned sorted (e.g., `sites_par_departement` sorted by site count descending) must be structured as **ordered arrays of objects** (e.g., `[{ departement: string, quantite: number }]`) rather than standard dictionary objects.
* **Rationale**: The JSON specification and JavaScript engines do not preserve key insertion order for integer-like keys (e.g., `"75"`, `"92"`) during parsing, automatically sorting them numerically. Using arrays guarantees the sorting order remains intact for AI consumers and UIs.

---

## 3. Dynamic Database Mappings

* **Requirement**: Industry classifications and business codes must be resolved dynamically using translations present in the Db2 database rather than hardcoded heuristics.
* **Category Code (`cdcatcli`)**: Must be joined against the table `PARAM` (using `MOTCLE = 'CATEG-CLI'`) to extract the long description from column **`PARLIBL`**, outputting the format `Code - Description` (ex: `"UTIL - Utilisateur final"`).

---

## 4. Identity Formatting Rules

* **Representative Name (`cdrep`)**: Must be formatted as `FirstName LASTNAME (Code)`.
  * The name is parsed from the professional email address located at index 20 (base 0) of column `PARDATA` in table `PARAM` (using `MOTCLE = 'REPRES'`).
  * The first name must have the first letter capitalized for each word segment, including after hyphens (e.g., `Jean-Philippe`).
  * The last name must be entirely in **UPPERCASE**.
* **Siren (`siren`)**: Must be formatted with spaces every 3 characters (e.g., `"775 722 218"`).
* **Country (`cdpays`)**: Numerical country codes must be mapped to their full French names (e.g., `"001"` maps to `"France"`).
* **Order Status (`cmdetat`)**: Order states must be outputted as full French descriptions (e.g., `"E"` -> `"En cours"`, `"P"` -> `"En préparation"`).
