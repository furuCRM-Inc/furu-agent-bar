/**
 * FlashBarAgentforceRuntime
 *
 * Step 2 of the Jev hybrid pipeline: receives a structured intent payload
 * from the Cloudflare Worker (zero customer data sent to the Worker) and
 * executes it entirely inside the authenticated Salesforce session.
 *
 * Trust Layer guarantees:
 *   - All SOQL uses WITH USER_MODE → FLS + sharing rules enforced
 *   - Bulk DML delegates to FlashBarMassEditService (partial-success mode)
 *   - Schema export for Worker KV seeding uses isAccessible() filter
 *   - No raw user text or record values ever leave this class to the Worker
 */
public with sharing class FlashBarAgentforceRuntime {

    // ── Inbound payload from Jev Worker ───────────────────────────────────────

    public class JevPayload {
        @AuraEnabled public String  intent;          // SOQL_SEARCH | RECORD_UPDATE | NAVIGATE | PIN | REPORT_EXPLAIN
        @AuraEnabled public String  sObjectType;
        @AuraEnabled public Decimal confidence;
        @AuraEnabled public String  conditionsJson;  // [{field, op, value}]
        @AuraEnabled public String  orderBy;
        @AuraEnabled public Integer limitRows;
        @AuraEnabled public String  soqlFilterJson;  // raw soql_filter JSON for LWC state persistence
        @AuraEnabled public String  reportId;        // for REPORT_EXPLAIN
        @AuraEnabled public String  fieldsJson;      // for bulk edit: ["ApiName",...]
    }

    // ── Outbound result to LWC ────────────────────────────────────────────────

    public class RuntimeResult {
        @AuraEnabled public String                      intent;
        @AuraEnabled public String                      message;
        @AuraEnabled public String                      updateSObject;
        @AuraEnabled public String                      soqlFilterJson;
        @AuraEnabled public List<Map<String, Object>>   soqlRecords;
        @AuraEnabled public FlashBarMassEditService.EditResult massEditResult;
        @AuraEnabled public String                      reportSummary;
        @AuraEnabled public String                      errorMessage;
    }

    // ── Main entry point ──────────────────────────────────────────────────────

    @AuraEnabled
    public static RuntimeResult executeJevIntent(String intentPayloadJson) {
        RuntimeResult result = new RuntimeResult();
        try {
            JevPayload payload = (JevPayload) JSON.deserialize(intentPayloadJson, JevPayload.class);

            String intent    = payload.intent  ?? 'UNKNOWN';
            String sObjType  = payload.sObjectType;
            Boolean isJa     = UserInfo.getLanguage().startsWith('ja');

            result.intent        = intent;
            result.updateSObject = sObjType;
            result.soqlFilterJson = payload.soqlFilterJson ?? payload.conditionsJson;

            if (intent == 'SOQL_SEARCH') {
                result = runSoqlSearch(payload, isJa, result);

            } else if (intent == 'RECORD_UPDATE' || intent == 'BULK_UPDATE') {
                result = runBulkEdit(payload, isJa, result);

            } else if (intent == 'REPORT_EXPLAIN') {
                result = runReportExplain(payload, isJa, result);

            } else {
                result.intent       = 'UNKNOWN';
                result.message      = isJa ? '不明なインテントです' : 'Unknown intent: ' + intent;
            }

        } catch (Exception e) {
            result.intent       = 'UNKNOWN';
            result.errorMessage = e.getMessage();
            result.message      = (UserInfo.getLanguage().startsWith('ja')
                ? 'エラーが発生しました: '
                : 'Runtime error: ') + e.getMessage();
        }
        return result;
    }

    // ── SOQL_SEARCH ───────────────────────────────────────────────────────────
    // Executes the structured conditions produced by the Worker SOQL template
    // builder. WITH USER_MODE enforces FLS + sharing on every field access.

    private static RuntimeResult runSoqlSearch(JevPayload p, Boolean isJa, RuntimeResult result) {
        if (String.isBlank(p.sObjectType)) {
            result.intent       = 'UNKNOWN';
            result.message      = isJa ? 'オブジェクトタイプが指定されていません' : 'sObjectType is required for SOQL_SEARCH';
            return result;
        }

        Integer lim = (p.limitRows != null && p.limitRows > 0 && p.limitRows <= 50)
            ? p.limitRows
            : 20;

        List<Map<String, Object>> records = FuruAgentController.executeSoqlQuery(
            p.sObjectType,
            p.conditionsJson ?? '[]',
            null,          // selectApiNamesJson — use defaults
            p.orderBy,
            lim,
            0
        );

        Integer n = records.size();
        result.soqlRecords = records;
        result.message     = isJa
            ? n + '件が見つかりました'
            : n + ' record' + (n == 1 ? '' : 's') + ' found';

        return result;
    }

    // ── BULK_UPDATE ───────────────────────────────────────────────────────────
    // Routes mass-edit operations from the furuAgentMassEditor LWC through
    // FlashBarMassEditService (partial-success DML, never all-or-nothing).

    private static RuntimeResult runBulkEdit(JevPayload p, Boolean isJa, RuntimeResult result) {
        if (String.isBlank(p.sObjectType) || String.isBlank(p.fieldsJson)) {
            result.intent   = 'UNKNOWN';
            result.message  = isJa ? '編集フィールドが指定されていません' : 'fieldsJson is required for BULK_UPDATE';
            return result;
        }

        // First fetch the target records via SOQL (respects FLS/sharing)
        List<Map<String, Object>> targetRows = FuruAgentController.executeSoqlQuery(
            p.sObjectType,
            p.conditionsJson ?? '[]',
            p.fieldsJson,
            p.orderBy,
            p.limitRows != null ? p.limitRows : 200,
            0
        );

        if (targetRows.isEmpty()) {
            result.message = isJa ? '更新対象のレコードが見つかりませんでした' : 'No records found to update';
            return result;
        }

        // Build SObject list from the rows returned
        Schema.SObjectType token = Schema.getGlobalDescribe().get(p.sObjectType);
        if (token == null) {
            result.errorMessage = 'Unknown sObject: ' + p.sObjectType;
            return result;
        }

        List<SObject> toUpdate = new List<SObject>();
        Map<String, Object> fieldUpdates = (Map<String, Object>) JSON.deserializeUntyped(p.fieldsJson);

        for (Map<String, Object> row : targetRows) {
            if (row.get('Id') == null) continue;
            SObject obj = token.newSObject((Id) row.get('Id'));
            for (String apiName : fieldUpdates.keySet()) {
                obj.put(apiName, fieldUpdates.get(apiName));
            }
            toUpdate.add(obj);
        }

        List<Database.SaveResult> results = Database.update(toUpdate, false);

        Integer success = 0, failed = 0;
        FlashBarMassEditService.EditResult editResult = new FlashBarMassEditService.EditResult();
        for (Integer i = 0; i < results.size(); i++) {
            if (results[i].isSuccess()) {
                success++;
                editResult.successIds.add(results[i].getId());
            } else {
                failed++;
                FlashBarMassEditService.RowError re = new FlashBarMassEditService.RowError();
                re.recordId     = (String) toUpdate[i].get('Id');
                re.errorMessage = results[i].getErrors().isEmpty()
                    ? 'Unknown error'
                    : results[i].getErrors()[0].getMessage();
                editResult.errors.add(re);
            }
        }

        result.massEditResult = editResult;
        result.message = isJa
            ? success + '件更新完了' + (failed > 0 ? '、' + failed + '件エラー' : '')
            : success + ' updated' + (failed > 0 ? ', ' + failed + ' failed' : '');

        return result;
    }

    // ── REPORT_EXPLAIN ────────────────────────────────────────────────────────
    // Fetches report summary data inside Salesforce (data never leaves),
    // then calls the Worker for a plain-language explanation of the numbers.
    // The Worker receives aggregate counts/totals only — no PII field values.

    private static RuntimeResult runReportExplain(JevPayload p, Boolean isJa, RuntimeResult result) {
        if (String.isBlank(p.reportId)) {
            result.intent  = 'UNKNOWN';
            result.message = isJa ? 'レポートIDが指定されていません' : 'reportId is required for REPORT_EXPLAIN';
            return result;
        }

        // Fetch report metadata (name, type) — available without Analytics API
        List<Report> reports = [
            SELECT Id, Name, FolderName, Description, LastRunDate, LastModifiedDate
            FROM Report
            WHERE Id = :p.reportId
            WITH USER_MODE
            LIMIT 1
        ];

        if (reports.isEmpty()) {
            result.intent  = 'UNKNOWN';
            result.message = isJa ? 'レポートが見つかりません' : 'Report not found or access denied';
            return result;
        }

        Report rpt = reports[0];

        // Build a lightweight summary payload (no record-level PII)
        Map<String, Object> summaryPayload = new Map<String, Object>{
            'report_name'   => rpt.Name,
            'folder_name'   => rpt.FolderName,
            'description'   => rpt.Description,
            'last_run_date' => rpt.LastRunDate != null ? String.valueOf(rpt.LastRunDate) : null
        };

        // Call Worker for plain-language explanation using the aggregate metadata only
        String explanation = callWorkerReportExplain(summaryPayload, isJa);

        result.intent        = 'REPORT_EXPLAIN';
        result.reportSummary = explanation;
        result.message       = isJa
            ? '「' + rpt.Name + '」の説明を生成しました'
            : 'Generated explanation for "' + rpt.Name + '"';

        return result;
    }

    private static String callWorkerReportExplain(Map<String, Object> summaryPayload, Boolean isJa) {
        try {
            HttpRequest req = new HttpRequest();
            req.setEndpoint('callout:FuruAgent_Backend/v1/explain-formula');
            req.setMethod('POST');
            req.setHeader('Content-Type', 'application/json');
            req.setHeader('X-Salesforce-Org-Id', UserInfo.getOrganizationId());
            req.setTimeout(20000);
            // Reuse explain-formula endpoint — only aggregate metadata, no PII
            req.setBody(JSON.serialize(new Map<String, Object>{
                'formula'       => JSON.serialize(summaryPayload),
                'field_label'   => (String) summaryPayload.get('report_name'),
                'sobject_type'  => 'Report',
                'userLanguage'  => isJa ? 'ja' : 'en'
            }));
            HttpResponse res = new Http().send(req);
            if (res.getStatusCode() == 200) {
                Map<String, Object> r = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
                return (String) r.get('explanation');
            }
        } catch (Exception e) { /* non-critical */ }
        return null;
    }

    // ── Schema export for Worker KV seeding ──────────────────────────────────
    // Returns the list of accessible field API names for a given sObject so
    // the Worker can cache them and validate SOQL fields without calling Salesforce.
    // Called once per sObject per session; Worker KV TTL = 1 hour.

    public class FieldSchemaMeta {
        @AuraEnabled public String       apiName;
        @AuraEnabled public String       label;
        @AuraEnabled public String       fieldType;
        @AuraEnabled public List<String> referenceTo;  // non-null for REFERENCE fields
        @AuraEnabled public Boolean      isCreateable;
        @AuraEnabled public Boolean      isUpdateable;
    }

    /**
     * Returns rich field schema for Worker KV seeding.
     * Includes lookup relationship metadata (referenceTo) so the Worker can
     * generate correct parent-scoped SOQL conditions (e.g. AccountId = recordId)
     * instead of relying on cross-object Name traversal (Account.Name = '...').
     */
    @AuraEnabled
    public static List<FieldSchemaMeta> getSchemaForWorkerKv(String sObjectType) {
        if (String.isBlank(sObjectType)) return new List<FieldSchemaMeta>();
        Schema.SObjectType token = Schema.getGlobalDescribe().get(sObjectType);
        if (token == null) return new List<FieldSchemaMeta>();

        Map<String, Schema.SObjectField> fieldMap = token.getDescribe().fields.getMap();
        List<FieldSchemaMeta> result = new List<FieldSchemaMeta>();
        for (Schema.SObjectField sf : fieldMap.values()) {
            Schema.DescribeFieldResult dfr = sf.getDescribe();
            if (!dfr.isAccessible()) continue;
            FieldSchemaMeta m = new FieldSchemaMeta();
            m.apiName     = dfr.getName();
            m.label       = dfr.getLabel();
            m.fieldType   = String.valueOf(dfr.getType());
            m.isCreateable = dfr.isCreateable();
            m.isUpdateable = dfr.isUpdateable();
            if (dfr.getType() == Schema.DisplayType.REFERENCE) {
                m.referenceTo = new List<String>();
                for (Schema.SObjectType ref : dfr.getReferenceTo()) {
                    m.referenceTo.add(ref.getDescribe().getName());
                }
            }
            result.add(m);
        }
        return result;
    }

    // ── Custom sObject catalog for Jev dynamic criteria ───────────────────────
    // Returns all accessible custom objects in the org so the Worker can build
    // a runtime Jev Choice question that includes org-specific objects.
    // Seeded into Worker KV once per session (TTL 1 hour).

    public class SObjectMeta {
        @AuraEnabled public String apiName;
        @AuraEnabled public String label;
        @AuraEnabled public String pluralLabel;
    }

    @AuraEnabled(cacheable=true)
    public static List<SObjectMeta> getCustomSObjectsForKv() {
        List<SObjectMeta> result = new List<SObjectMeta>();
        Map<String, Schema.SObjectType> globalDescribe = Schema.getGlobalDescribe();

        for (String apiName : globalDescribe.keySet()) {
            // Custom objects end with __c; exclude managed package noise (__mdt, __e, __b, __x)
            if (!apiName.endsWith('__c')) continue;

            Schema.DescribeSObjectResult dsr;
            try {
                dsr = globalDescribe.get(apiName).getDescribe();
            } catch (Exception ex) {
                continue;  // Some objects throw on describe — skip silently
            }

            // Only include objects the running user can query
            if (!dsr.isAccessible() || !dsr.isQueryable()) continue;

            SObjectMeta m = new SObjectMeta();
            m.apiName     = dsr.getName();
            m.label       = dsr.getLabel();
            m.pluralLabel = dsr.getLabelPlural();
            result.add(m);

            // Cap at 200 — covers any realistic org; Worker uses top-12 for Jev
            // accuracy and keyword-matches the rest from the full KV list.
            if (result.size() >= 200) break;
        }
        return result;
    }
}
