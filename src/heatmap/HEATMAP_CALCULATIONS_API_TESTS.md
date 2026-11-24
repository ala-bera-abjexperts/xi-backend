# Heatmap & Calculations API — Sample Data & Test Guide

## Real Database IDs (Local Supabase)

| Key | Value |
|-----|-------|
| **Organization ID** | `d31e8f83-2f0c-4008-9e59-fbbb53eb646d` (ABJ Experts) |
| **Primary User (owner)** | `267b6a1d-6a5e-4d63-b544-d869f85ee906` (prince@abjexperts.com) |
| **Space: Default** | `53f4d965-0eff-43c1-9f4e-0cd28acbd189` |
| **Space: NewSpace** | `b13dfe27-bfe9-4f68-8d9e-57798367d67e` |

### Existing Heatmap Config in DB

| Config ID | Title | Matrix Size | Coloring Mode | Show Count |
|-----------|-------|-------------|---------------|------------|
| `a12f11e4-eed6-4459-862b-9070aac71836` | ISMS Risk Assessment Matrix | 4 | individual-cells | true |

### Business Processes with CIA Values (heatmap-relevant)

Only processes with at least one non-zero `vuln_*` field appear in heatmap cells.

| Process ID | Title | Status | Request Type | Space | vuln values (all) |
|------------|-------|--------|--------------|-------|--------------------|
| `0cdcb9f7-a40b-43c1-812e-0872618d6c93` | p6556 | active | Geschäftsprozessbewertung | NewSpace | all = 4 → cell (4,4) |
| `0ece5d80-0f82-457a-9b8e-a91a8be9cad0` | p000 | active | Geschäftsprozessbewertung | NewSpace | all = 4 → cell (4,4) |
| `a5b3fd7c-a1d4-47fd-940e-4878c5bc8890` | test | active | Servicebewertung | Default | all = 3 → cell (3,3) |
| `3c19f958-34cc-4d2e-a783-e373d3f74e44` | after gdpr | **inactive** | Servicebewertung | Default | all = 2 → only with `status=inactive` |

Processes with all-zero / null CIA values (filtered out by service, won't show in heatmap):
- `b36cb1f5` "dsdsa", `ee82159d` "Test Christian", `88beb314` "Test Prince", `4bb78757` "gdgdfgdfg", `497c2a5d` "dfgfdgfd"

**Calculation cache:** currently empty — all calculation calls go to the RPC.

---

## Auth — Get JWT Token

```bash
# Sign in as Prince (owner)
curl -X POST 'http://127.0.0.1:54321/auth/v1/token?grant_type=password' \
  -H 'apikey: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH' \
  -H 'Content-Type: application/json' \
  -d '{"email":"prince@abjexperts.com","password":"your_password_here"}'
```

```bash
TOKEN="<paste_access_token_here>"
BASE="http://localhost:3000/api/v1"
```

---

## Heatmap Endpoints

### 1. GET /heatmap — Generate via Query Params

Default (5×5 matrix, all active processes, risk-level coloring):

```bash
curl -X GET "$BASE/heatmap" \
  -H "Authorization: Bearer $TOKEN"
```

**Expected (active processes with CIA values = p6556, p000, test):**
```json
{
  "success": true,
  "heatMapData": {
    "matrix": {
      "1": { "1": { "count": 0, "processes": [], "color": "#4CAF50", "text": "Sehr gering" }, ... },
      "3": { "3": { "count": 1, "processes": [{ "id": "a5b3fd7c...", "title": "test" }], "color": "#FF9800", "text": "Hoch\n1" } },
      "4": { "4": { "count": 2, "processes": [{ "id": "0cdcb9f7...", "title": "p6556" }, { "id": "0ece5d80...", "title": "p000" }], "color": "#F44336", "text": "Kritisch\n2" } }
    },
    "stats": {
      "totalProcessed": 3,
      "excludedCount": 0,
      "maxCount": 2,
      "filledCells": 2,
      "emptyCells": 23,
      "averageProcessesPerCell": 1.5
    }
  },
  "configuration": { "matrixSize": 5, "showIssueCount": true, ... },
  "metadata": { "processedIssues": 3, "generatedAt": "2026-04-16T...", "organizationId": "d31e8f83..." }
}
```

> **Risk level labels are German:** Kritisch, Hoch, Mittel, Gering, Sehr gering  
> **`averageProcessesPerCell`** = totalProcessed ÷ filledCells (3 ÷ 2 = 1.5), not ÷ all 25 cells

---

**Filter to 4×4 matrix:**

```bash
curl -X GET "$BASE/heatmap?matrixSize=4" \
  -H "Authorization: Bearer $TOKEN"
```

---

**Filter by space (NewSpace — only p6556 and p000):**

```bash
curl -X GET "$BASE/heatmap?spaceId=b13dfe27-bfe9-4f68-8d9e-57798367d67e" \
  -H "Authorization: Bearer $TOKEN"
```

**Expected stats:** `totalProcessed: 2`, cell (4,4) has count 2

---

**Filter by specific requestTypes:**

```bash
curl -X GET "$BASE/heatmap?requestTypes=Servicebewertung" \
  -H "Authorization: Bearer $TOKEN"
```

**Expected:** Only "test" (vuln=3) → cell (3,3) count=1

---

**Include inactive processes:**

```bash
curl -X GET "$BASE/heatmap?status=inactive" \
  -H "Authorization: Bearer $TOKEN"
```

**Expected:** Only "after gdpr" (vuln=2) → cell (2,2) count=1

---

**Hide issue counts:**

```bash
curl -X GET "$BASE/heatmap?showIssueCount=false" \
  -H "Authorization: Bearer $TOKEN"
```

**Expected:** Cell text shows risk level only (no `\n2` suffix)

---

**Individual-cells coloring mode:**

```bash
curl -X GET "$BASE/heatmap?coloringMode=individual-cells" \
  -H "Authorization: Bearer $TOKEN"
```

---

**No matching processes (empty matrix):**

```bash
curl -X GET "$BASE/heatmap?requestTypes=Assetbewertung" \
  -H "Authorization: Bearer $TOKEN"
```

**Expected:**
```json
{
  "success": true,
  "heatMapData": {
    "matrix": { ... all zeros ... },
    "stats": { "totalProcessed": 0, "filledCells": 0, "emptyCells": 25 }
  }
}
```

---

### 2. POST /heatmap — Generate via Body Config

```bash
curl -X POST "$BASE/heatmap" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "matrixSize": 4,
    "showIssueCount": true,
    "title": "Custom Risk Matrix",
    "requestTypes": ["Servicebewertung", "Geschäftsprozessbewertung"],
    "status": ["active"],
    "coloringMode": "risk-level"
  }'
```

**Expected (200):** Same shape as GET /heatmap — matrix + stats + configuration + metadata

---

**With individual-cells coloring:**

```bash
curl -X POST "$BASE/heatmap" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "matrixSize": 4,
    "coloringMode": "individual-cells",
    "individualCellColors": {
      "1,1": "#d4edda",
      "4,4": "#dc3545"
    },
    "individualCellTexts": {
      "1,1": "Niedrig",
      "4,4": "Sehr Hoch"
    }
  }'
```

---

**Space-scoped + inactive status:**

```bash
curl -X POST "$BASE/heatmap" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "spaceId": "53f4d965-0eff-43c1-9f4e-0cd28acbd189",
    "status": ["active", "inactive"]
  }'
```

**Expected:** Includes "test" (active, vuln=3) + "after gdpr" (inactive, vuln=2) from Default space

---

**Validation error — matrixSize out of range:**

```bash
curl -X POST "$BASE/heatmap" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"matrixSize": 10}'
```

**Expected: 400**
```json
{ "statusCode": 400, "message": ["matrixSize must not be greater than 5"], "error": "Bad Request" }
```

---

### 3. GET /heatmap/risk-summary — Risk Summary Grouped

```bash
curl -X GET "$BASE/heatmap/risk-summary" \
  -H "Authorization: Bearer $TOKEN"
```

**Expected (active processes with CIA values):**
```json
{
  "success": true,
  "riskSummary": [
    {
      "key": "4,4",
      "maxProbability": 4,
      "maxImpact": 4,
      "grossProbability": 4,
      "grossFinancialImpact": 556250.0,
      "riskLevel": "Kritisch",
      "issues": [
        { "key": "0cdcb9f7-a40b-43c1-812e-0872618d6c93", "summary": "p6556", "description": null, "requestType": "Geschäftsprozessbewertung" },
        { "key": "0ece5d80-0f82-457a-9b8e-a91a8be9cad0", "summary": "p000", "description": null, "requestType": "Geschäftsprozessbewertung" }
      ]
    },
    {
      "key": "3,3",
      "maxProbability": 3,
      "maxImpact": 3,
      "grossProbability": 3,
      "grossFinancialImpact": 21153.85,
      "riskLevel": "Hoch",
      "issues": [
        { "key": "a5b3fd7c-a1d4-47fd-940e-4878c5bc8890", "summary": "test", "requestType": "Servicebewertung" }
      ]
    }
  ],
  "totalRisks": 2
}
```

Sorted descending by `maxProbability × maxImpact` (4×4=16 before 3×3=9).

> **`grossFinancialImpact`** = `probability_mappings[p] × impact_mappings[i]` from risk_configuration:  
> - (4,4): 0.65 × 855769.23 = **556250.00**  
> - (3,3): 0.2 × 105769.23 = **21153.85**  
> **`riskLevel`** uses German labels: Kritisch / Hoch / Mittel / Gering / Sehr gering

---

**Filter by space:**

```bash
curl -X GET "$BASE/heatmap/risk-summary?spaceId=b13dfe27-bfe9-4f68-8d9e-57798367d67e" \
  -H "Authorization: Bearer $TOKEN"
```

**Expected:** Only `p6556` + `p000` → 1 entry with 2 issues at (4,4)

---

**Filter by requestTypes:**

```bash
curl -X GET "$BASE/heatmap/risk-summary?requestTypes=Servicebewertung" \
  -H "Authorization: Bearer $TOKEN"
```

**Expected:** Only "test" → 1 entry at (3,3)

---

**No processes match → empty:**

```bash
curl -X GET "$BASE/heatmap/risk-summary?requestTypes=Assetbewertung" \
  -H "Authorization: Bearer $TOKEN"
```

**Expected:** `{ "success": true, "riskSummary": [], "totalRisks": 0 }`

---

### 4. GET /heatmap/config — Get Saved Config

```bash
curl -X GET "$BASE/heatmap/config" \
  -H "Authorization: Bearer $TOKEN"
```

**Expected (org has a saved config):**
```json
{
  "config": {
    "id": "a12f11e4-eed6-4459-862b-9070aac71836",
    "organization_id": "d31e8f83-2f0c-4008-9e59-fbbb53eb646d",
    "title": "ISMS Risk Assessment Matrix",
    "matrix_size": 4,
    "coloring_mode": "individual-cells",
    "show_issue_count": true,
    "cell_font_size": "medium",
    "status_filter": ["active"],
    "request_types": ["Assetbewertung", "Schwachstelle", "Servicebewertung", "Prozessbewertung", "Geschäftsprozessbewertung", "Risiko", "Assetgroup"],
    "individual_cell_colors": { "1,1": "#d4edda", "4,4": "#dc3545", ... },
    "individual_cell_texts": { "1,1": "Niedrig", "4,4": "Sehr Hoch", ... }
  },
  "isDefault": false
}
```

**After DELETE /heatmap/config → returns default:**
```json
{
  "config": {
    "organization_id": "d31e8f83...",
    "title": "ISMS Risk Assessment Matrix",
    "show_issue_count": true,
    "matrix_size": 5,
    "coloring_mode": "risk-level",
    "custom_colors": ["#4caf50", "#8bc34a", "#ffeb3b", "#ff9800", "#f44336"]
  },
  "isDefault": true
}
```

---

### 5. POST /heatmap/config — Create Config

> **Note:** Will fail with a duplicate-key error if a config already exists. Run `DELETE /heatmap/config` first to reset.

```bash
curl -X POST "$BASE/heatmap/config" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "NestJS Test Config",
    "matrix_size": 5,
    "show_issue_count": true,
    "cell_font_size": "medium",
    "coloring_mode": "risk-level",
    "status_filter": ["active"],
    "request_types": ["Servicebewertung", "Prozessbewertung"]
  }'
```

**Expected (201):**
```json
{
  "config": {
    "id": "<new-uuid>",
    "organization_id": "d31e8f83...",
    "title": "NestJS Test Config",
    "matrix_size": 5,
    "coloring_mode": "risk-level",
    "created_by": "267b6a1d...",
    "updated_by": "267b6a1d..."
  }
}
```

---

**Validation error — invalid matrix_size:**

```bash
curl -X POST "$BASE/heatmap/config" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"matrix_size": 7}'
```

**Expected: 400** `matrix_size must be one of the following values: 2, 3, 4, 5`

---

**Invalid cell_font_size:**

```bash
curl -X POST "$BASE/heatmap/config" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"cell_font_size": "huge"}'
```

**Expected: 400** `cell_font_size must be one of the following values: small, medium, large, xlarge`

---

### 6. PUT /heatmap/config — Upsert Config

Safe to call whether config exists or not (creates or updates):

```bash
curl -X PUT "$BASE/heatmap/config" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Updated Risk Matrix",
    "matrix_size": 5,
    "coloring_mode": "risk-level",
    "show_issue_count": false,
    "cell_font_size": "large",
    "status_filter": ["active", "inactive"],
    "request_types": ["Servicebewertung", "Prozessbewertung", "Geschäftsprozessbewertung"]
  }'
```

**Expected (200):** `{ "config": { ...updated row... } }`

---

**With individual-cells coloring:**

```bash
curl -X PUT "$BASE/heatmap/config" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "coloring_mode": "individual-cells",
    "individual_cell_colors": {
      "1,1": "#d4edda",
      "2,2": "#fff3cd",
      "3,3": "#fd7e14",
      "4,4": "#dc3545",
      "5,5": "#871f18"
    },
    "individual_cell_texts": {
      "1,1": "Low",
      "3,3": "Medium",
      "5,5": "Critical"
    }
  }'
```

---

### 7. DELETE /heatmap/config — Reset to Default

```bash
curl -X DELETE "$BASE/heatmap/config" \
  -H "Authorization: Bearer $TOKEN"
```

**Expected (200):**
```json
{ "success": true, "message": "Configuration reset to default" }
```

After this, `GET /heatmap/config` returns `isDefault: true`.

---

## Calculations Endpoints

### 8. POST /calculations/calculate — Calculate Risk (cached)

Uses `calculate_risk_values_cascade` RPC. Checks 1-hour cache first.

```bash
# Process with CIA values (p6556)
PROC_ID="0cdcb9f7-a40b-43c1-812e-0872618d6c93"

curl -X POST "$BASE/calculations/calculate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"process_id\": \"$PROC_ID\"}"
```

**Expected (200):** RPC result with calculated risk values
```json
{
  "net_risk": 16,
  "accumulated_risk": 16,
  "total_risk": 16,
  "probability": 4,
  "impact": 4
}
```
*(exact shape depends on RPC implementation)*

---

**With cascade_to_parents = false:**

```bash
curl -X POST "$BASE/calculations/calculate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"process_id": "0cdcb9f7-a40b-43c1-812e-0872618d6c93", "cascade_to_parents": false}'
```

---

**Second call (same process) — served from cache:**

```bash
# Run the same calculate call again — should return instantly from cache
curl -X POST "$BASE/calculations/calculate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"process_id": "0cdcb9f7-a40b-43c1-812e-0872618d6c93"}'
```

Then verify cache entry was created:
```bash
curl -X GET "$BASE/calculations/cache/0cdcb9f7-a40b-43c1-812e-0872618d6c93" \
  -H "Authorization: Bearer $TOKEN"
```

---

**Validation error — missing process_id:**

```bash
curl -X POST "$BASE/calculations/calculate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Expected: 400** `process_id must be a UUID`

---

**Invalid UUID:**

```bash
curl -X POST "$BASE/calculations/calculate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"process_id": "not-a-uuid"}'
```

**Expected: 400** `process_id must be a UUID`

---

### 9. POST /calculations/force-calculate — Bypass Cache

Clears cache first, then recalculates via RPC.

```bash
curl -X POST "$BASE/calculations/force-calculate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"process_id": "0cdcb9f7-a40b-43c1-812e-0872618d6c93"}'
```

**Expected (200):** Fresh RPC result (same shape as /calculate)

---

```bash
# Use "test" process (Servicebewertung, vuln=3)
curl -X POST "$BASE/calculations/force-calculate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"process_id": "a5b3fd7c-a1d4-47fd-940e-4878c5bc8890"}'
```

---

### 10. POST /calculations/recalculate-tree — Full Tree Bottom-Up

Uses `recalculate_tree_bottom_up` RPC starting from a root process.

```bash
# Use p6556 as root
curl -X POST "$BASE/calculations/recalculate-tree" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"root_process_id": "0cdcb9f7-a40b-43c1-812e-0872618d6c93"}'
```

**Expected (200):** RPC result (array of updated process IDs or success message)

---

```bash
# Use "test" as root (Servicebewertung)
curl -X POST "$BASE/calculations/recalculate-tree" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"root_process_id": "a5b3fd7c-a1d4-47fd-940e-4878c5bc8890"}'
```

---

**Validation error — missing root_process_id:**

```bash
curl -X POST "$BASE/calculations/recalculate-tree" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Expected: 400** `root_process_id must be a UUID`

---

### 11. GET /calculations/cache/:processId — Check Cache

```bash
# After running /calculate, check if result was cached
curl -X GET "$BASE/calculations/cache/0cdcb9f7-a40b-43c1-812e-0872618d6c93" \
  -H "Authorization: Bearer $TOKEN"
```

**Expected (200, after calculate):** Cached `calculated_values` object
**Expected (200, no cache):** `null`

---

```bash
# Process that has never been calculated — returns null
curl -X GET "$BASE/calculations/cache/0ece5d80-0f82-457a-9b8e-a91a8be9cad0" \
  -H "Authorization: Bearer $TOKEN"
```

---

**Invalid UUID:**

```bash
curl -X GET "$BASE/calculations/cache/not-a-uuid" \
  -H "Authorization: Bearer $TOKEN"
```

**Expected: 400** UUID parse error

---

### 12. DELETE /calculations/cache — Clear All Org Cache

```bash
curl -X DELETE "$BASE/calculations/cache" \
  -H "Authorization: Bearer $TOKEN"
```

**Expected (200):**
```json
{ "deleted": 0 }
```
(or the count of rows deleted if cache had entries)

---

### 13. DELETE /calculations/cache/:processId — Clear Process Cache

Uses `invalidate_calculation_cache_cascade` RPC (clears process + ancestors).

```bash
curl -X DELETE "$BASE/calculations/cache/0cdcb9f7-a40b-43c1-812e-0872618d6c93" \
  -H "Authorization: Bearer $TOKEN"
```

**Expected (200):**
```json
{ "success": true }
```

---

## SQL — Seed Test Data for Calculations Testing

Run in Supabase Studio (`http://127.0.0.1:54323`):

```sql
-- Seed a calculation cache entry (simulate a prior calculation)
INSERT INTO calculation_results (
  organization_id,
  business_process_id,
  calculated_values,
  calculation_metadata,
  expires_at
) VALUES (
  'd31e8f83-2f0c-4008-9e59-fbbb53eb646d',
  '0cdcb9f7-a40b-43c1-812e-0872618d6c93',
  '{"net_risk": 16, "accumulated_risk": 16, "total_risk": 16, "probability": 4, "impact": 4}',
  '{"source": "manual_seed", "version": 1}',
  NOW() + INTERVAL '1 hour'
)
ON CONFLICT (business_process_id) DO NOTHING;
```

Use this ID to test the cache hit path in `/calculations/calculate`.

Reset after:
```sql
DELETE FROM calculation_results
WHERE business_process_id = '0cdcb9f7-a40b-43c1-812e-0872618d6c93';
```

---

## Test Order (Happy Path)

```
Heatmap:
1.  GET    /heatmap/config                     → get saved config (isDefault: false)
2.  GET    /heatmap                             → generate matrix (3 active processes)
3.  GET    /heatmap?matrixSize=4               → 4×4 matrix
4.  GET    /heatmap?spaceId=b13dfe27...        → space-filtered (2 processes)
5.  GET    /heatmap/risk-summary               → grouped summary (sorted by P×I desc)
6.  GET    /heatmap/risk-summary?spaceId=b13dfe27...  → space-scoped summary
7.  POST   /heatmap                            → body config (requestTypes filter)
8.  PUT    /heatmap/config                     → upsert new config
9.  GET    /heatmap/config                     → verify updated (isDefault: false)
10. DELETE /heatmap/config                     → reset to default
11. GET    /heatmap/config                     → verify isDefault: true
12. POST   /heatmap/config                     → create fresh config

Calculations:
13. GET    /calculations/cache/0cdcb9f7...     → null (no cache yet)
14. POST   /calculations/calculate             → { process_id: "0cdcb9f7..." }  → runs RPC
15. GET    /calculations/cache/0cdcb9f7...     → cached result (non-null)
16. POST   /calculations/calculate             → same call → returned from cache
17. POST   /calculations/force-calculate       → clears cache + fresh RPC result
18. POST   /calculations/recalculate-tree      → { root_process_id: "0cdcb9f7..." }
19. DELETE /calculations/cache/0cdcb9f7...     → { success: true }
20. DELETE /calculations/cache                 → { deleted: 0 } (already cleared)
```

---

## Error Cases to Verify

| Scenario | Endpoint | Expected |
|----------|----------|----------|
| `matrixSize: 10` | POST /heatmap | 400 — must not be greater than 5 |
| `matrixSize: 1` | POST /heatmap | 400 — must not be less than 2 |
| `cell_font_size: "huge"` | POST /heatmap/config | 400 — must be one of small, medium, large, xlarge |
| `matrix_size: 7` | POST /heatmap/config | 400 — must be one of 2, 3, 4, 5 |
| `coloring_mode: "rainbow"` | PUT /heatmap/config | 400 — must be risk-level or individual-cells |
| Missing `process_id` | POST /calculations/calculate | 400 — process_id must be a UUID |
| Invalid UUID `process_id` | POST /calculations/calculate | 400 — process_id must be a UUID |
| Missing `root_process_id` | POST /calculations/recalculate-tree | 400 — root_process_id must be a UUID |
| Non-existent process | POST /calculations/calculate | 400 — Risk calculation failed: ... |
| Invalid cache UUID | GET /calculations/cache/bad | 400 — UUID parse error |
| No JWT | Any endpoint | 401 Unauthorized |
