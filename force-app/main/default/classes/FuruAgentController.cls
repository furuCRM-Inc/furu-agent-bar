/**
 * FuruAgentController
 * Orchestrates natural language → structured Salesforce action.
 *
 * Flow:
 *   1. Fetch field schema for the current sObject (so the LLM knows real API names)
 *   2. POST to Cloudflare Worker /v1/agent-action with user input + schema context
 *   3. Return structured AgentAction to the LWC
 *   4. Handle SEARCH intents server-side (SOSL)
 */
public with sharing class FuruAgentController {

    // ── Locale helpers ────────────────────────────────────────────────────────
    private static Boolean isJa(String lang) {
        return lang != null && lang.toLowerCase().startsWith('ja');
    }
    // Returns jaMsg when lang starts with 'ja', enMsg otherwise.
    private static String i18n(String enMsg, String jaMsg, String lang) {
        return isJa(lang) ? jaMsg : enMsg;
    }

    // Japanese sObject label → Salesforce API name (LLM sometimes returns Japanese labels)
    private static final Map<String, String> JA_SOBJECT_API = new Map<String, String>{
        '取引先'       => 'Account',
        '取引先責任者' => 'Contact',
        '連絡先'       => 'Contact',
        'リード'       => 'Lead',
        '商談'         => 'Opportunity',
        'ケース'       => 'Case',
        'キャンペーン' => 'Campaign',
        '行動'         => 'Task',
        'タスク'       => 'Task'
    };

    // Salesforce API name → Japanese display label (for clean status messages)
    private static final Map<String, String> JA_SOBJECT_LABEL = new Map<String, String>{
        'Account'     => '取引先',
        'Contact'     => '連絡先',
        'Lead'        => 'リード',
        'Opportunity' => '商談',
        'Case'        => 'ケース',
        'Campaign'    => 'キャンペーン',
        'Task'        => '行動'
    };

    // ── Field intelligence data type ──────────────────────────────────────────

    public class FieldInsight {
        @AuraEnabled public String       apiName;
        @AuraEnabled public String       label;
        @AuraEnabled public String       helpText;
        @AuraEnabled public Boolean      isRequired;
        @AuraEnabled public Boolean      isCalculated;
        @AuraEnabled public String       formulaLiteral;
        @AuraEnabled public String       fieldType;          // STRING | CURRENCY | DATE | PICKLIST …
        @AuraEnabled public Boolean      isUpdateable;
        // Metadata for limit-badge and input-example rendering
        @AuraEnabled public Integer      length;             // Max chars for STRING/TEXTAREA
        @AuraEnabled public Integer      precision;          // Total digits for NUMBER/CURRENCY
        @AuraEnabled public Integer      scale;              // Decimal places for NUMBER/CURRENCY
        @AuraEnabled public List<String> picklistOptions;    // First active values for PICKLIST
    }

    // ── Public result type ────────────────────────────────────────────────────

    public class AgentAction {
        @AuraEnabled public String intent;          // NAVIGATE | UPDATE_RECORD | PREFILL | EXTRACT | SEARCH | GUIDE_CREATE | EXPLAIN_FIELD | EXPLAIN_FORMULA | UNKNOWN
        @AuraEnabled public String message;         // Human-readable summary
        @AuraEnabled public String targetUrl;       // For NAVIGATE
        @AuraEnabled public String targetRecordId;  // For NAVIGATE to specific record
        @AuraEnabled public String targetSObject;   // For NAVIGATE to list view
        @AuraEnabled public String updateRecordId;  // For UPDATE_RECORD / PREFILL
        @AuraEnabled public String updateSObject;   // sObject API name
        @AuraEnabled public Map<String, Object> fields; // fieldApiName → value
        @AuraEnabled public Boolean shouldSave;     // true = DML commit, false = pre-fill only
        @AuraEnabled public List<Map<String, Object>> searchResults;
        @AuraEnabled public String errorMessage;
        // Field intelligence
        @AuraEnabled public List<FieldInsight> guideFields;      // GUIDE_CREATE: required + key fields
        @AuraEnabled public String             guideSObject;     // GUIDE_CREATE: target sObject label
        @AuraEnabled public FieldInsight       fieldInsight;     // EXPLAIN_FIELD / EXPLAIN_FORMULA
        @AuraEnabled public String             explanation;      // EXPLAIN_FORMULA: LLM plain-language text
        @AuraEnabled public String             warningMessage;   // Proactive missing required-field alert
        @AuraEnabled public List<String>       knowledgeWarnings;// Self-learned validation rule alerts
        @AuraEnabled public Integer            remainingCredits; // Free-trial credit balance from backend
        // SOQL_SEARCH / ADD_FIELDS
        @AuraEnabled public String             soqlFilterJson;   // raw filter JSON for LWC state persistence
        @AuraEnabled public List<Map<String, Object>> soqlRecords; // SOQL_SEARCH result rows
        // CREATE_REPORT / CREATE_DASHBOARD (optional premium — user must connect Claude)
        @AuraEnabled public String             analyticsRequest; // verbatim user request for report/dashboard
        // Confidence-based Multi-Tiered Threshold routing
        @AuraEnabled public Double             confidence;       // 0.0–1.0 from Worker
        @AuraEnabled public List<Map<String,Object>> candidates; // DISAMBIGUATE: interpretation options
        @AuraEnabled public Boolean            needsConfirmation; // DML confidence < 95% → diff preview
    }

    // ── Field insight — public cached read ───────────────────────────────────

    @AuraEnabled(cacheable=true)
    public static Map<String, FieldInsight> getObjectFieldInsights(String sObjectType) {
        Map<String, FieldInsight> out = new Map<String, FieldInsight>();
        // resolveReadOnly: SOQL-only, no DML — safe for cacheable=true context
        for (FieldInsight fi : FlashBarSchemaCacheService.getInsightsReadOnly(sObjectType)) {
            out.put(fi.apiName, fi);
        }
        return out;
    }

    // ── Approved rules — ambient context panel ────────────────────────────────

    @AuraEnabled(cacheable=true)
    public static List<String> getApprovedRules(String sObjectType) {
        if (String.isBlank(sObjectType)) return new List<String>();
        List<FuruAgent_Knowledge__c> recs = [
            SELECT Plain_English_Rule__c FROM FuruAgent_Knowledge__c
            WHERE Target_sObject__c = :sObjectType
            AND   Status__c = 'Approved'
            ORDER BY Occurrences__c DESC NULLS LAST
            LIMIT 5
        ];
        List<String> out = new List<String>();
        for (FuruAgent_Knowledge__c r : recs) {
            if (String.isNotBlank(r.Plain_English_Rule__c)) out.add(r.Plain_English_Rule__c);
        }
        return out;
    }

    // ── CSV Bulk Import ───────────────────────────────────────────────────────

    public class RowResult {
        @AuraEnabled public Integer csvRow;   // 1-based CSV row number (row 2 = first data row)
        @AuraEnabled public String  status;   // 'OK' or 'NG'
        @AuraEnabled public String  error;    // null when OK
    }

    public class BulkImportResult {
        @AuraEnabled public Integer totalInserted;
        @AuraEnabled public Integer totalFailed;
        @AuraEnabled public Integer totalUpserted;
        @AuraEnabled public List<Map<String, Object>> errors;      // [{ row, message }]
        @AuraEnabled public List<RowResult>           rowResults;  // one entry per input row
    }

    // Tracks a REFERENCE field whose value is a parent record Name (not a Salesforce ID)
    private class PendingLookup {
        Integer recIndex;
        String  fieldApiName;
        String  parentSObject;
        String  nameValue;
        String  extKeyField;   // null → lookup by Name; non-null → lookup by this field
        PendingLookup(Integer idx, String f, String s, String n) {
            recIndex = idx; fieldApiName = f; parentSObject = s; nameValue = n; extKeyField = null;
        }
        // Constructor for dotted-header parent lookup (Account.AccountNumber → resolve AccountId)
        PendingLookup(Integer idx, String fk, String s, String ekf, String ekv) {
            recIndex = idx; fieldApiName = fk; parentSObject = s; extKeyField = ekf; nameValue = ekv;
        }
    }

    /**
     * Upsert or insert up to 200 pre-mapped CSV records per call.
     *
     * @param sObjectType    API name of the target object (e.g. 'Account')
     * @param recordsJson    JSON array of field-maps  [{ "Name":"...", "AccountId":"株式会社A" }]
     * @param externalIdField  Optional. API name of the external-ID field for upsert mode
     *                         (e.g. 'External_Key__c').  Null / blank → plain insert.
     *
     * Auto-resolution: if a REFERENCE field (e.g. AccountId) holds a name string
     * instead of a Salesforce ID, the method batch-SOQLs the parent by Name and
     * substitutes the real ID before DML.
     */
    @AuraEnabled
    public static BulkImportResult bulkImportCsv(
        String sObjectType,
        String recordsJson,
        String externalIdField
    ) {
        BulkImportResult out = new BulkImportResult();
        out.errors       = new List<Map<String, Object>>();
        out.totalUpserted = 0;

        Schema.SObjectType token = Schema.getGlobalDescribe().get(sObjectType);
        if (token == null) throw new AuraHandledException('不明なオブジェクト: ' + sObjectType);

        List<Object> rawList;
        try { rawList = (List<Object>) JSON.deserializeUntyped(recordsJson); }
        catch (Exception ex) { throw new AuraHandledException('JSON解析エラー: ' + ex.getMessage()); }
        if (rawList == null || rawList.isEmpty()) {
            out.totalInserted = 0; out.totalFailed = 0; return out;
        }
        if (rawList.size() > 200) {
            List<Object> capped = new List<Object>();
            for (Integer k = 0; k < 200; k++) capped.add(rawList[k]);
            rawList = capped;
        }

        Map<String, Schema.SObjectField> fieldMap = token.getDescribe().fields.getMap();
        List<SObject>        toSave           = new List<SObject>();
        List<Integer>        originalIndices  = new List<Integer>();
        List<PendingLookup>  pendingLookups   = new List<PendingLookup>();

        for (Integer i = 0; i < rawList.size(); i++) {
            Map<String, Object> r = (Map<String, Object>) rawList[i];
            SObject obj = token.newSObject();
            Boolean hasValue   = false;
            List<PendingLookup> rowPending = new List<PendingLookup>();

            for (String apiName : r.keySet()) {
                Object raw = r.get(apiName);
                if (raw == null) continue;
                String strVal = String.valueOf(raw).trim();
                if (String.isBlank(strVal)) continue;

                // Dotted-header: "Account.AccountNumber" → resolve AccountId by AccountNumber value
                if (apiName.contains('.')) {
                    String relPart   = apiName.substringBefore('.').toLowerCase();
                    String extKeyFld = apiName.substringAfter('.');
                    String fkApiName = findWritableFkField(relPart, fieldMap);
                    if (String.isNotBlank(fkApiName)) {
                        Schema.DescribeFieldResult dfr = fieldMap.get(fkApiName.toLowerCase()).getDescribe();
                        if (!dfr.getReferenceTo().isEmpty()) {
                            String parentSObj = dfr.getReferenceTo()[0].getDescribe().getName();
                            rowPending.add(new PendingLookup(-1, fkApiName, parentSObj, extKeyFld, strVal));
                        }
                    }
                    continue;
                }

                Schema.SObjectField sf = fieldMap.get(apiName.toLowerCase());
                if (sf == null) continue;

                try {
                    Schema.DisplayType dt = sf.getDescribe().getType();
                    switch on dt {
                        when DATE {
                            obj.put(apiName, Date.valueOf(strVal.replace('/', '-')));
                            hasValue = true;
                        }
                        when DATETIME {
                            obj.put(apiName, DateTime.valueOf(strVal));
                            hasValue = true;
                        }
                        when DOUBLE, CURRENCY, PERCENT {
                            String num = strVal.replaceAll('[^0-9.\\-]', '');
                            if (String.isNotBlank(num)) { obj.put(apiName, Decimal.valueOf(num)); hasValue = true; }
                        }
                        when INTEGER, LONG {
                            String num = strVal.replaceAll('[^0-9\\-]', '');
                            if (String.isNotBlank(num)) { obj.put(apiName, Long.valueOf(num)); hasValue = true; }
                        }
                        when BOOLEAN {
                            obj.put(apiName, strVal.equalsIgnoreCase('true') ||
                                            strVal == '1' || strVal == 'はい' ||
                                            strVal.equalsIgnoreCase('yes'));
                            hasValue = true;
                        }
                        when REFERENCE {
                            // Valid SF ID: 15 or 18 alphanumeric chars
                            Boolean likeId = (strVal.length() == 15 || strVal.length() == 18)
                                             && strVal.isAlphanumeric();
                            if (likeId) {
                                obj.put(apiName, (Id) strVal);
                                hasValue = true;
                            } else {
                                // Queue for batch Name-based parent resolution
                                Schema.DescribeFieldResult dfr = sf.getDescribe();
                                if (!dfr.getReferenceTo().isEmpty()) {
                                    String parentSObjName = dfr.getReferenceTo()[0].getDescribe().getName();
                                    rowPending.add(new PendingLookup(-1, apiName, parentSObjName, strVal));
                                }
                            }
                        }
                        when else {
                            obj.put(apiName, strVal);
                            hasValue = true;
                        }
                    }
                } catch (Exception ignored) {}
            }

            if (hasValue || !rowPending.isEmpty()) {
                Integer objIdx = toSave.size();
                toSave.add(obj);
                originalIndices.add(i + 2);
                for (PendingLookup lp : rowPending) {
                    lp.recIndex = objIdx;
                    pendingLookups.add(lp);
                }
            }
        }

        // ── Batch-resolve REFERENCE values → Salesforce IDs ─────────────────
        // Groups by "ParentSObj|LookupField" so Name-based and external-key-based
        // lookups are batched separately and never collide in the result map.
        if (!pendingLookups.isEmpty()) {
            Map<String, Set<String>> valuesByKey = new Map<String, Set<String>>();
            for (PendingLookup lp : pendingLookups) {
                String lookupFld = lp.extKeyField != null ? lp.extKeyField : 'Name';
                String key = lp.parentSObject + '|' + lookupFld;
                if (!valuesByKey.containsKey(key)) {
                    valuesByKey.put(key, new Set<String>());
                }
                valuesByKey.get(key).add(lp.nameValue);
            }

            // resolvedMap key = "Account|AccountNumber:ACC-001" → Id
            Map<String, Id> resolvedMap = new Map<String, Id>();
            for (String key : valuesByKey.keySet()) {
                String parentSObj = key.substringBefore('|');
                String lookupFld  = key.substringAfter('|');
                Set<String> vals  = valuesByKey.get(key);
                try {
                    String sobjSafe  = String.escapeSingleQuotes(parentSObj);
                    String fieldSafe = String.escapeSingleQuotes(lookupFld);
                    List<SObject> parents = Database.query(
                        'SELECT Id, ' + fieldSafe + ' FROM ' + sobjSafe +
                        ' WHERE ' + fieldSafe + ' IN :vals WITH USER_MODE LIMIT 200'
                    );
                    for (SObject p : parents) {
                        resolvedMap.put(key + ':' + String.valueOf(p.get(lookupFld)), (Id) p.get('Id'));
                    }
                } catch (Exception ignored) {}
            }

            for (PendingLookup lp : pendingLookups) {
                String lookupFld = lp.extKeyField != null ? lp.extKeyField : 'Name';
                Id resolved = resolvedMap.get(lp.parentSObject + '|' + lookupFld + ':' + lp.nameValue);
                if (resolved != null && lp.recIndex < toSave.size()) {
                    toSave[lp.recIndex].put(lp.fieldApiName, resolved);
                }
            }
        }

        // ── Per-row result tracking (all input rows start as NG/skipped) ─────
        RowResult[] allRowResults = new RowResult[rawList.size()];
        for (Integer i = 0; i < rawList.size(); i++) {
            RowResult rr = new RowResult();
            rr.csvRow = i + 2;          // header = row 1, first data row = 2
            rr.status = 'NG';
            rr.error  = '対応フィールドなし';
            allRowResults[i] = rr;
        }

        // ── DML: upsert (external key) or insert ─────────────────────────────
        Integer inserted = 0, failed = 0;
        Boolean isUpsert = String.isNotBlank(externalIdField);

        if (isUpsert) {
            Schema.SObjectField extFld = fieldMap.get(externalIdField.toLowerCase());
            if (extFld == null) throw new AuraHandledException('外部キーフィールドが見つかりません: ' + externalIdField);
            List<Database.UpsertResult> uResults = Database.upsert(toSave, extFld, false);
            for (Integer i = 0; i < uResults.size(); i++) {
                Integer rawIdx = originalIndices[i] - 2;
                RowResult rr   = allRowResults[rawIdx];
                if (uResults[i].isSuccess()) {
                    inserted++;
                    if (!uResults[i].isCreated()) out.totalUpserted++;
                    rr.status = 'OK';
                    rr.error  = null;
                } else {
                    failed++;
                    String msg = uResults[i].getErrors().isEmpty()
                        ? 'Unknown error'
                        : uResults[i].getErrors()[0].getMessage();
                    rr.status = 'NG';
                    rr.error  = msg;
                    if (out.errors.size() < 50) {
                        out.errors.add(new Map<String, Object>{ 'row' => originalIndices[i], 'message' => msg });
                    }
                }
            }
        } else {
            List<Database.SaveResult> results = Database.insert(toSave, false);
            for (Integer i = 0; i < results.size(); i++) {
                Integer rawIdx = originalIndices[i] - 2;
                RowResult rr   = allRowResults[rawIdx];
                if (results[i].isSuccess()) {
                    inserted++;
                    rr.status = 'OK';
                    rr.error  = null;
                } else {
                    failed++;
                    String msg = results[i].getErrors().isEmpty()
                        ? 'Unknown error'
                        : results[i].getErrors()[0].getMessage();
                    rr.status = 'NG';
                    rr.error  = msg;
                    if (out.errors.size() < 50) {
                        out.errors.add(new Map<String, Object>{ 'row' => originalIndices[i], 'message' => msg });
                    }
                }
            }
        }

        out.totalInserted = inserted;
        out.totalFailed   = failed;
        out.rowResults    = allRowResults;
        return out;
    }

    // ── Semantic SOQL query executor ─────────────────────────────────────────
    //
    // Accepts a structured conditions array from the LLM / LWC state and builds
    // a safe, FLS-respecting SOQL query using WITH USER_MODE.

    // Cache: "ParentSObj:ChildSObj" → lookup field API name, resolved dynamically via Schema.
    private static final Map<String, String> PARENT_CHILD_LOOKUP_CACHE = new Map<String, String>();

    private static final Set<String> DATE_LITERALS = new Set<String>{
        'TODAY','YESTERDAY','TOMORROW',
        'THIS_WEEK','LAST_WEEK','NEXT_WEEK',
        'THIS_MONTH','LAST_MONTH','NEXT_MONTH',
        'THIS_QUARTER','LAST_QUARTER',
        'THIS_YEAR','LAST_YEAR'
    };

    // Default display fields per sObject (returned when LWC has not customised yet)
    private static final Map<String, List<String>> DEFAULT_SELECT_FIELDS = new Map<String, List<String>>{
        'Opportunity' => new List<String>{'Name','Amount','StageName','CloseDate','Account.Name','LastActivityDate'},
        'Account'     => new List<String>{'Name','Industry','AnnualRevenue','BillingCity','LastActivityDate'},
        'Contact'     => new List<String>{'Name','Email','Phone','Title','Account.Name','LastActivityDate'},
        'Lead'        => new List<String>{'Name','Company','Email','Status','LastActivityDate'},
        'Case'        => new List<String>{'CaseNumber','Subject','Status','Priority','Account.Name'}
    };

    // Dynamic column defaults for objects not in DEFAULT_SELECT_FIELDS.
    // Picks the first 5 accessible, non-system, non-formula fields from Schema describe.
    private static List<String> getDefaultSelectForObject(String sObjType, Map<String, Schema.SObjectField> fieldMap) {
        if (DEFAULT_SELECT_FIELDS.containsKey(sObjType)) return DEFAULT_SELECT_FIELDS.get(sObjType);
        Set<String> skip = new Set<String>{
            'id','isdeleted','ownerid','createddate','createdbyid',
            'lastmodifieddate','lastmodifiedbyid','systemmodstamp',
            'lastvieweddate','lastreferenceddate','currencyisocode'
        };
        List<String> fields = new List<String>();
        if (fieldMap.containsKey('name')) {
            Schema.DescribeFieldResult n = fieldMap.get('name').getDescribe();
            if (n.isAccessible()) fields.add(n.getName());
        }
        for (Schema.SObjectField sf : fieldMap.values()) {
            if (fields.size() >= 5) break;
            Schema.DescribeFieldResult dfr = sf.getDescribe();
            if (!dfr.isAccessible() || dfr.isCalculated() || dfr.isAutoNumber()) continue;
            String fn = dfr.getName().toLowerCase();
            if (skip.contains(fn) || fn == 'name') continue;
            Schema.DisplayType dt = dfr.getType();
            if (dt == Schema.DisplayType.REFERENCE || dt == Schema.DisplayType.BASE64 ||
                dt == Schema.DisplayType.ID || dt == Schema.DisplayType.ADDRESS) continue;
            fields.add(dfr.getName());
        }
        return fields.isEmpty() ? new List<String>{'Name'} : fields;
    }

    // Returns the Schema-derived display label for any sObject (dynamic fallback for custom objects).
    private static String getSObjectLabel(String sObjectType) {
        if (String.isBlank(sObjectType)) return sObjectType;
        if (JA_SOBJECT_LABEL.containsKey(sObjectType)) return JA_SOBJECT_LABEL.get(sObjectType);
        try {
            Schema.SObjectType token = Schema.getGlobalDescribe().get(sObjectType);
            if (token != null) return token.getDescribe().getLabel();
        } catch (Exception ignored) {}
        return sObjectType;
    }

    // Dynamically finds a useful secondary field for SOSL parent-search display.
    // Prefers well-known identifier fields; falls back to the first accessible string field.
    private static String findSecondaryField(String sObjectType) {
        try {
            Schema.SObjectType token = Schema.getGlobalDescribe().get(sObjectType);
            if (token == null) return null;
            Map<String, Schema.SObjectField> fm = token.getDescribe().fields.getMap();
            for (String preferred : new List<String>{
                'Email','Phone','BillingCity','Industry','Company',
                'Title','Department','Status','Subject','Type','Website'
            }) {
                Schema.SObjectField sf = fm.get(preferred.toLowerCase());
                if (sf != null && sf.getDescribe().isAccessible()) return sf.getDescribe().getName();
            }
            for (Schema.SObjectField sf : fm.values()) {
                Schema.DescribeFieldResult dfr = sf.getDescribe();
                if (!dfr.isAccessible()) continue;
                String fn = dfr.getName();
                if (fn == 'Id' || fn == 'Name' || fn.endsWith('Id')) continue;
                if (dfr.getType() == Schema.DisplayType.STRING || dfr.getType() == Schema.DisplayType.EMAIL
                    || dfr.getType() == Schema.DisplayType.PHONE) {
                    return fn;
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    @AuraEnabled
    public static List<Map<String, Object>> executeSoqlQuery(
        String sObjectType,
        String conditionsJson,      // JSON: [{field, op, value}]
        String selectApiNamesJson,  // JSON: ["Name","Amount","Account.Name"] — null → use defaults
        String orderBy,
        Integer maxRows,
        Integer offsetRows          // null / 0 = first page; >0 = load-more offset
    ) {
        Schema.SObjectType token = Schema.getGlobalDescribe().get(sObjectType);
        if (token == null) throw new AuraHandledException('不明なオブジェクト: ' + sObjectType);
        Map<String, Schema.SObjectField> fieldMap = token.getDescribe().fields.getMap();

        // ── Build SELECT list ─────────────────────────────────────────────
        List<String> rawSelect;
        if (String.isNotBlank(selectApiNamesJson)) {
            try { rawSelect = (List<String>)(List<Object>) JSON.deserializeUntyped(selectApiNamesJson); }
            catch (Exception ex) { rawSelect = new List<String>(); }
        }
        if (rawSelect == null || rawSelect.isEmpty()) {
            rawSelect = getDefaultSelectForObject(sObjectType, fieldMap);
        }

        Set<String> seen = new Set<String>{'id'};
        List<String> selectClause = new List<String>{'Id'};
        for (String fn : rawSelect) {
            fn = fn.trim();
            if (String.isBlank(fn) || seen.contains(fn.toLowerCase())) continue;
            if (fn.contains('.')) {
                // Relationship field — check parent ref field exists (standard or custom __r)
                String rel = fn.split('\\.')[0].toLowerCase();
                Boolean relOk = fieldMap.containsKey(rel + 'id')
                    || fieldMap.containsKey(rel)
                    || (rel.endsWith('__r') && fieldMap.containsKey(rel.removeEnd('__r') + '__c'));
                if (relOk) {
                    selectClause.add(fn);
                    seen.add(fn.toLowerCase());
                }
            } else if (fieldMap.containsKey(fn.toLowerCase())) {
                Schema.DescribeFieldResult dfr = fieldMap.get(fn.toLowerCase()).getDescribe();
                if (dfr.isAccessible()) {
                    selectClause.add(dfr.getName());
                    seen.add(fn.toLowerCase());
                }
            }
        }

        // ── Build WHERE from structured conditions ─────────────────────────
        List<Object> conditions;
        try { conditions = (List<Object>) JSON.deserializeUntyped(conditionsJson ?? '[]'); }
        catch (Exception ex) { conditions = new List<Object>(); }

        List<String> whereParts = new List<String>();
        for (Object cRaw : conditions) {
            Map<String, Object> cond = (Map<String, Object>) cRaw;
            String field = String.valueOf(cond.get('field') ?? '').trim();
            String op    = String.valueOf(cond.get('op')    ?? '').trim().toLowerCase();
            Object val   = cond.get('value');
            if (String.isBlank(field) || String.isBlank(op)) continue;

            // Validate field (direct or relationship like Account.Name / MyParent__r.Name)
            String lookupKey = field.contains('.')
                ? field.split('\\.')[0].toLowerCase()
                : field.toLowerCase();
            Boolean fieldOk = fieldMap.containsKey(lookupKey)
                || fieldMap.containsKey(lookupKey + 'id')
                || (lookupKey.endsWith('__r') && fieldMap.containsKey(lookupKey.removeEnd('__r') + '__c'));
            if (!fieldOk) continue;

            String clause = buildSoqlCondition(field, op, val);
            if (clause != null) whereParts.add(clause);
        }

        // ── Assemble and execute ────────────────────────────────────────────
        Integer lim = (maxRows != null && maxRows > 0 && maxRows <= 50) ? maxRows : 20;
        Integer off = (offsetRows != null && offsetRows > 0) ? offsetRows : 0;
        String soqlOrderBy = buildSafeOrderBy(orderBy, fieldMap);

        String soql = 'SELECT ' + String.join(selectClause, ', ')
            + ' FROM ' + sObjectType
            + (whereParts.isEmpty() ? '' : ' WHERE ' + String.join(whereParts, ' AND '))
            + ' WITH USER_MODE'
            + (String.isNotBlank(soqlOrderBy) ? ' ORDER BY ' + soqlOrderBy : '')
            + ' LIMIT ' + lim
            + (off > 0 ? ' OFFSET ' + off : '');

        List<Map<String, Object>> rows = new List<Map<String, Object>>();
        try {
            for (SObject rec : Database.query(soql)) {
                Map<String, Object> row = new Map<String, Object>{ 'Id' => rec.Id, '_type' => sObjectType };
                for (String fn : selectClause) {
                    if (fn == 'Id') continue;
                    if (fn.contains('.')) {
                        String[] parts = fn.split('\\.');
                        SObject relObj = (SObject) rec.getSObject(parts[0]);
                        if (relObj != null) row.put(fn, relObj.get(parts[1]));
                    } else {
                        Object v = rec.get(fn);
                        if (v != null) row.put(fn, v);
                    }
                }
                rows.add(row);
            }
        } catch (Exception e) {
            throw new AuraHandledException('検索エラー: ' + e.getMessage());
        }
        return rows;
    }

    private static String buildSoqlCondition(String field, String op, Object val) {
        if (op == 'is_null')  return field + ' = NULL';
        if (op == 'not_null') return field + ' != NULL';
        if (val == null) return null;

        String valStr = String.valueOf(val).trim();
        String upper  = valStr.toUpperCase();

        // Safe Salesforce date literals
        if (DATE_LITERALS.contains(upper)) return field + ' ' + opSymbol(op) + ' ' + upper;
        if (upper.startsWith('LAST_N_DAYS:') || upper.startsWith('NEXT_N_DAYS:') ||
            upper.startsWith('LAST_N_MONTHS:') || upper.startsWith('NEXT_N_MONTHS:')) {
            Pattern np = Pattern.compile('(?i)(LAST|NEXT)_N_(DAYS|MONTHS):(\\d+)');
            if (np.matcher(valStr).matches()) return field + ' ' + opSymbol(op) + ' ' + upper;
        }

        // Numeric check
        Boolean isNum = false; Decimal numVal = null;
        try { numVal = Decimal.valueOf(valStr); isNum = true; } catch (Exception ignored) {}

        if (op == 'in' || op == 'not_in') {
            List<Object> listVal = val instanceof List<Object> ? (List<Object>) val : new List<Object>{ val };
            List<String> items = new List<String>();
            for (Object item : listVal) {
                String s = String.valueOf(item).trim();
                Decimal d = null;
                try { d = Decimal.valueOf(s); } catch (Exception ignored) {}
                items.add(d != null ? String.valueOf(d) : '\'' + String.escapeSingleQuotes(s) + '\'');
            }
            String setStr = '(' + String.join(items, ', ') + ')';
            return field + (op == 'in' ? ' IN ' : ' NOT IN ') + setStr;
        }

        if (op == 'like') return field + ' LIKE \'' + String.escapeSingleQuotes(valStr) + '\'';

        String sym = opSymbol(op);
        if (sym == null) return null;

        // Numeric-only ops (gt, gte, lt, lte) must have a number value
        Boolean numOnlyOp = (op == 'gt' || op == 'gte' || op == 'lt' || op == 'lte');
        if (numOnlyOp && !isNum) return null;

        // Boolean literals — must not be quoted in SOQL
        if (valStr.equalsIgnoreCase('true') || valStr.equalsIgnoreCase('false')) {
            return field + ' ' + sym + ' ' + valStr.toLowerCase();
        }

        return isNum
            ? field + ' ' + sym + ' ' + numVal
            : field + ' ' + sym + ' \'' + String.escapeSingleQuotes(valStr) + '\'';
    }

    private static String opSymbol(String op) {
        switch on op {
            when 'eq'  { return '=';  }
            when 'neq' { return '!='; }
            when 'gt'  { return '>';  }
            when 'gte' { return '>='; }
            when 'lt'  { return '<';  }
            when 'lte' { return '<='; }
            when else  { return null; }
        }
    }

    private static String buildSafeOrderBy(String orderBy, Map<String, Schema.SObjectField> fieldMap) {
        if (String.isBlank(orderBy)) return null;
        Pattern p = Pattern.compile('(?i)([A-Za-z][A-Za-z0-9_.]*?)(?:\\s+(ASC|DESC))?\\s*$');
        Matcher m = p.matcher(orderBy.trim());
        if (!m.matches()) return null;
        String field = m.group(1);
        String dir   = String.isNotBlank(m.group(2)) ? m.group(2).toUpperCase() : 'DESC';
        // Allow relationship fields (e.g. Account.Name) and direct fields
        if (field.contains('.')) return field + ' ' + dir;
        if (fieldMap.containsKey(field.toLowerCase())) {
            return fieldMap.get(field.toLowerCase()).getDescribe().getName() + ' ' + dir;
        }
        return null;
    }

    /**
     * When the user is on a parent record page (e.g. Account / Dickenson plc) and
     * asks for child records (e.g. Opportunities), the Worker may return an empty
     * filter or use Account.Name = '...' which can miss records.  This helper
     * injects AccountId = recordId (or the appropriate lookup field) so the query
     * is always scoped to the current parent — unless the filter already contains
     * that lookup field.
     */
    /**
     * Dynamically resolves which field on childSObj is a REFERENCE to parentSObj.
     * Returns the first matching lookup API name, or null if none found.
     * Result is cached per transaction to avoid repeated describe calls.
     */
    private static String resolveParentLookupField(String parentSObj, String childSObj) {
        String cacheKey = parentSObj + ':' + childSObj;
        if (PARENT_CHILD_LOOKUP_CACHE.containsKey(cacheKey)) {
            return PARENT_CHILD_LOOKUP_CACHE.get(cacheKey);
        }
        Schema.SObjectType childToken = Schema.getGlobalDescribe().get(childSObj);
        if (childToken == null) {
            PARENT_CHILD_LOOKUP_CACHE.put(cacheKey, null);
            return null;
        }
        String parentLower = parentSObj.toLowerCase();
        for (Schema.SObjectField sf : childToken.getDescribe().fields.getMap().values()) {
            Schema.DescribeFieldResult dfr = sf.getDescribe();
            if (dfr.getType() != Schema.DisplayType.REFERENCE) continue;
            for (Schema.SObjectType ref : dfr.getReferenceTo()) {
                if (ref.getDescribe().getName().toLowerCase() == parentLower) {
                    String found = dfr.getName();
                    PARENT_CHILD_LOOKUP_CACHE.put(cacheKey, found);
                    return found;
                }
            }
        }
        PARENT_CHILD_LOOKUP_CACHE.put(cacheKey, null);
        return null;
    }

    /**
     * When the user is on a parent record page (e.g. Account / Dickenson plc) and
     * asks for child records (e.g. Opportunities), the Worker may return an empty
     * filter or use Account.Name = '...' which can miss records.  This helper
     * injects the parent lookup field = recordId so the query is always scoped to
     * the current parent — unless the filter already contains that lookup field.
     * Works for any parent/child object pair by resolving the lookup dynamically.
     */
    private static String injectParentFilter(
        String condJson,
        String parentSObj,
        String childSObj,
        String parentRecordId
    ) {
        if (String.isBlank(parentRecordId) || String.isBlank(parentSObj) || String.isBlank(childSObj)) return condJson;
        if (parentSObj == childSObj) return condJson;

        String lookupField = resolveParentLookupField(parentSObj, childSObj);
        if (String.isBlank(lookupField)) return condJson;

        List<Object> conditions;
        try { conditions = (List<Object>) JSON.deserializeUntyped(condJson ?? '[]'); }
        catch (Exception ex) { conditions = new List<Object>(); }

        // Skip injection if Worker already filtered by this lookup or by the parent's Name field
        String lookupLower = lookupField.toLowerCase();
        String parentLower = parentSObj.toLowerCase();
        for (Object cRaw : conditions) {
            if (!(cRaw instanceof Map<String, Object>)) continue;
            String f = String.valueOf(((Map<String, Object>) cRaw).get('field') ?? '').toLowerCase();
            if (f == lookupLower || f.startsWith(parentLower + '.')) return condJson;
        }

        // Inject the parent record ID as a filter condition
        conditions.add(new Map<String, Object>{
            'field' => lookupField,
            'op'    => 'eq',
            'value' => parentRecordId
        });
        return JSON.serialize(conditions);
    }

    // ── Parent record search (for GUIDE_CREATE parent selector) ─────────────

    public class ParentCandidate {
        @AuraEnabled public String id;
        @AuraEnabled public String name;
        @AuraEnabled public String sub;
    }

    @AuraEnabled
    public static List<ParentCandidate> searchParentRecords(String parentSObjectType, String searchTerm) {
        if (String.isBlank(parentSObjectType) || String.isBlank(searchTerm)) {
            return new List<ParentCandidate>();
        }
        // Strip SOSL special chars except wildcard-friendly chars; append wildcard
        String safeTerm = searchTerm.trim().replaceAll('[\'\"\\\\\\[\\]{}()!&|^~:+\\-]', ' ').trim();
        if (String.isBlank(safeTerm)) return new List<ParentCandidate>();
        safeTerm = String.escapeSingleQuotes(safeTerm) + '*';

        String sObjSafe = String.escapeSingleQuotes(parentSObjectType);
        String subField = findSecondaryField(parentSObjectType);
        String returningFields = subField != null ? 'Id, Name, ' + subField : 'Id, Name';

        String sosl = 'FIND \'' + safeTerm + '\' IN NAME FIELDS RETURNING ' +
                      sObjSafe + '(' + returningFields + ' LIMIT 3)';
        List<List<SObject>> raw;
        try {
            raw = Search.query(sosl);
        } catch (Exception e) {
            return new List<ParentCandidate>();
        }
        List<ParentCandidate> out = new List<ParentCandidate>();
        if (!raw.isEmpty()) {
            for (SObject rec : raw[0]) {
                ParentCandidate c = new ParentCandidate();
                c.id   = String.valueOf(rec.get('Id'));
                c.name = String.valueOf(rec.get('Name') ?? '');
                Object sub = subField != null ? rec.get(subField) : null;
                c.sub  = sub != null ? String.valueOf(sub) : '';
                out.add(c);
            }
        }
        return out;
    }

    // ── Field snapshot for undo ───────────────────────────────────────────────

    @AuraEnabled
    public static Map<String, Object> getFieldSnapshot(String recordId, List<String> fieldNames) {
        if (String.isBlank(recordId) || fieldNames == null || fieldNames.isEmpty()) {
            return new Map<String, Object>();
        }
        try {
            String sObjName = ((Id) recordId).getSObjectType().getDescribe().getName();

            // FLS check — only include fields the running user can read
            Schema.SObjectType token = Schema.getGlobalDescribe().get(sObjName);
            Map<String, Schema.SObjectField> fm = token?.getDescribe().fields.getMap();
            List<String> accessible = new List<String>();
            if (fm != null) {
                for (String f : fieldNames) {
                    Schema.SObjectField fld = fm.get(f.toLowerCase());
                    if (fld != null && fld.getDescribe().isAccessible()) accessible.add(f);
                }
            }
            if (accessible.isEmpty()) return new Map<String, Object>();

            String safe = String.escapeSingleQuotes(recordId);
            List<SObject> recs = Database.query(
                'SELECT ' + String.join(accessible, ', ') + ' FROM ' + sObjName + ' WHERE Id = \'' + safe + '\' WITH USER_MODE LIMIT 1'
            );
            if (recs.isEmpty()) return new Map<String, Object>();
            SObject rec = recs[0];
            Map<String, Object> snapshot = new Map<String, Object>();
            for (String f : accessible) {
                snapshot.put(f, rec.get(f));   // null fields included so undo can clear them
            }
            return snapshot;
        } catch (Exception e) {
            return new Map<String, Object>();
        }
    }

    // ── Japanese postal code lookup ───────────────────────────────────────────

    @AuraEnabled(cacheable=true)
    public static Map<String, String> getJapaneseAddress(String zipcode) {
        if (String.isBlank(zipcode)) return null;
        String clean = zipcode.replaceAll('[^0-9]', '');
        if (clean.length() != 7) return null;
        try {
            HttpRequest req = new HttpRequest();
            req.setEndpoint('callout:FuruAgent_Backend/v1/jp-address');
            req.setMethod('POST');
            req.setHeader('Content-Type', 'application/json');
            req.setHeader('X-Salesforce-Org-Id', UserInfo.getOrganizationId());
            req.setTimeout(8000);
            req.setBody('{"zipcode":"' + clean + '"}');
            HttpResponse res = new Http().send(req);
            if (res.getStatusCode() == 200) {
                Map<String, Object> raw = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
                Map<String, String> out = new Map<String, String>();
                for (String k : raw.keySet()) {
                    Object v = raw.get(k);
                    if (v != null) out.put(k, String.valueOf(v));
                }
                return out;
            }
        } catch (Exception e) { /* silent — LWC will surface the empty result */ }
        return null;
    }

    // ── Main entry point ──────────────────────────────────────────────────────

    @AuraEnabled
    public static AgentAction processIntent(
        String userInput,
        String sObjectType,
        String recordId,
        String pageType,        // 'record_detail' | 'list_view' | 'home' | 'other'
        String userLanguage     // e.g. 'ja', 'en_US' — passed from LWC @salesforce/i18n/lang
    ) {
        AgentAction result = new AgentAction();
        try {
            // 1. Get field schema for context
            List<String> fieldLabels = getFieldLabels(sObjectType);

            // Detect user language from UserInfo if LWC didn't supply it
            String lang = String.isNotBlank(userLanguage)
                ? userLanguage
                : UserInfo.getLanguage();

            // 2. Call Cloudflare Worker
            Map<String, Object> workerResponse = callWorker(userInput, sObjectType, recordId, pageType, fieldLabels, lang);

            // Flush any schema cache writes deferred to avoid DML-before-callout
            FlashBarSchemaCacheService.flushPendingWrites();

            // 3. Map response to AgentAction
            result = mapToAction(workerResponse, sObjectType, recordId);

            // ── 3a. Multi-Tiered Confidence Threshold (Raycast / Linear pattern) ──────
            //
            //   ≥ 85%  →  Direct execution  (proceed as normal)
            //  50–84%  →  DISAMBIGUATE: show "Did You Mean?" candidates, no data written
            //   < 50%  →  SOSL keyword fallback: discard AI intent entirely
            //  DML < 95% → needsConfirmation = true → diff-preview guard before write
            {
                Double conf = result.confidence != null ? result.confidence : 1.0;
                Boolean isDml = (result.intent == 'UPDATE_RECORD');

                if (conf < 0.5) {
                    // Low confidence — abandon AI interpretation, run SOSL
                    String rawQ = String.isNotBlank((String) workerResponse.get('search_query'))
                        ? (String) workerResponse.get('search_query')
                        : userInput;
                    result.intent        = 'SEARCH';
                    result.searchResults = runSearch(rawQ, null, null);
                    result.message = i18n(
                        'Low confidence — showing keyword results for "' + userInput + '"',
                        '確信度が低いため「' + userInput + '」のキーワード検索に切り替えました',
                        lang
                    );
                } else if (conf < 0.85 && !isDml
                           && result.candidates != null && !result.candidates.isEmpty()) {
                    // Medium confidence with candidates — ask user to choose
                    result.intent = 'DISAMBIGUATE';
                    if (String.isBlank(result.message)) {
                        result.message = i18n(
                            'Did you mean…? Tap to select',
                            'もしかしてこちらですか？（選んで実行）',
                            lang
                        );
                    }
                } else if (isDml && conf < 0.95) {
                    // DML below 95% — require user confirmation (diff preview in LWC)
                    result.needsConfirmation = true;
                }
            }

            // 3b. Resolve __copyAddress signal (e.g. copy billing → shipping)
            if (result.fields != null && result.fields.containsKey('__copyAddress')) {
                String copyDir = (String) result.fields.remove('__copyAddress');
                result.fields.putAll(resolveAddressCopy(copyDir, result.updateRecordId, result.updateSObject));
            }

            // 3c. Resolve __relativeOps (e.g. "Add 10% to Amount", "Push Close Date by 2 weeks")
            if (result.fields != null && result.fields.containsKey('__relativeOps')) {
                List<Object> ops = (List<Object>) result.fields.remove('__relativeOps');
                resolveRelativeOps(ops, result.updateRecordId, result.updateSObject, result.fields);
            }

            // 3d. Guard: strip fields the LLM hallucinated as writable (formula, roll-up, etc.)
            if (result.fields != null && !result.fields.isEmpty()
                && String.isNotBlank(result.updateSObject)
                && (result.intent == 'UPDATE_RECORD' || result.intent == 'PREFILL' || result.intent == 'EXTRACT')) {
                result = filterUpdateableFields(result, lang);
            }

            // 3d-ii. Override generic "Action processed." with a localized field-count message
            if ((result.intent == 'EXTRACT' || result.intent == 'EXTRACT_AND_PREFILL')
                && result.fields != null && !result.fields.isEmpty()) {
                Integer n = result.fields.size();
                result.message = i18n(
                    n + ' field' + (n == 1 ? '' : 's') + ' extracted',
                    n + '件のフィールドを抽出しました',
                    lang
                );
            }

            // 3e. Field intelligence intents — served from Apex schema describe (no extra LLM call)
            if (result.intent == 'CLARIFY') {
                // Model wasn't confident — surface its question to the user as-is.
                // message is already set by mapToAction from the LLM output.
                result.intent = 'UNKNOWN'; // LWC treats CLARIFY same as UNKNOWN (info status)
            } else if (result.intent == 'GUIDE_CREATE') {
                // Resolve Japanese sObject labels → API names (LLM sometimes returns Japanese)
                String rawSObj = (String) workerResponse.get('guide_sobject');
                String resolved = String.isNotBlank(rawSObj)
                    ? (JA_SOBJECT_API.containsKey(rawSObj) ? JA_SOBJECT_API.get(rawSObj) : rawSObj)
                    : null;
                // Cascade: LLM guide_sobject → page sObjectType → give up
                String targetSObj = String.isNotBlank(resolved)  ? resolved
                                  : String.isNotBlank(sObjectType) ? sObjectType
                                  : null;
                result.guideSObject = targetSObj;
                result.guideFields  = getObjectFieldInsightsInternal(targetSObj);
                // Second chance: LLM returned wrong name, try page context sObjectType
                if ((result.guideFields == null || result.guideFields.isEmpty())
                    && String.isNotBlank(sObjectType) && sObjectType != targetSObj) {
                    result.guideSObject = sObjectType;
                    result.guideFields  = getObjectFieldInsightsInternal(sObjectType);
                }
                // Always use the clean Apex template — never the LLM's raw message string
                String sobjLabel = isJa(lang) ? getSObjectLabel(targetSObj) : targetSObj;
                result.message = i18n(
                    'Field guide for ' + sobjLabel,
                    sobjLabel + ' のフィールドガイド',
                    lang
                );
            } else if (result.intent == 'EXPLAIN_FIELD' || result.intent == 'EXPLAIN_FORMULA') {
                String fn = (String) workerResponse.get('field_name');
                String targetSObj = String.isNotBlank(result.updateSObject)
                    ? result.updateSObject
                    : sObjectType;
                result.fieldInsight = findFieldInsight(targetSObj, fn);
                if (result.intent == 'EXPLAIN_FORMULA'
                    && result.fieldInsight != null
                    && result.fieldInsight.isCalculated == true
                    && String.isNotBlank(result.fieldInsight.formulaLiteral)) {
                    result.explanation = callWorkerExplain(
                        result.fieldInsight.formulaLiteral,
                        result.fieldInsight.label,
                        targetSObj,
                        lang
                    );
                }
            }

            // 3f. Proactive missing-field warning for UPDATE_RECORD / PREFILL
            if ((result.intent == 'UPDATE_RECORD' || result.intent == 'PREFILL')
                && String.isNotBlank(result.updateSObject)
                && String.isNotBlank(result.updateRecordId)
                && result.fields != null && !result.fields.isEmpty()) {
                result.warningMessage = buildMissingFieldWarning(
                    result.updateSObject, result.updateRecordId, result.fields
                );
            }

            // 3g. Knowledge pre-check — warn about learned validation rules
            if ((result.intent == 'UPDATE_RECORD' || result.intent == 'PREFILL')
                && String.isNotBlank(result.updateSObject)
                && result.fields != null && !result.fields.isEmpty()) {
                try {
                    List<String> kWarns = checkKnowledgeRulesInternal(result.updateSObject);
                    if (!kWarns.isEmpty()) {
                        result.knowledgeWarnings = kWarns;
                        // For PREFILL: surface first rule as warningMessage for companion display
                        if (result.intent == 'PREFILL' && String.isBlank(result.warningMessage)) {
                            result.warningMessage = kWarns[0];
                        }
                    }
                } catch (Exception e) { /* non-critical */ }
            }

            // 3h. NAVIGATE_SETUP — build Lightning Setup URL; fall back to Setup home + hint
            if (result.intent == 'NAVIGATE_SETUP') {
                String node       = (String) workerResponse.get('setup_node');
                String searchTerm = (String) workerResponse.get('setup_search_term');
                if (String.isNotBlank(node)) {
                    result.targetUrl = '/lightning/setup/' + node + '/home';
                } else {
                    result.targetUrl = '/lightning/setup/SetupOneHome/home';
                    // Surface search term as a hint in the message so the user knows what to type
                    if (String.isNotBlank(searchTerm)) {
                        result.message = (isJa(lang)
                            ? 'Salesforce設定を開きました。検索バーで「' + searchTerm + '」を検索してください。'
                            : 'Opened Salesforce Setup. Search for "' + searchTerm + '" in the search bar.');
                    }
                }
                result.intent = 'NAVIGATE'; // LWC existing NAVIGATE handler picks this up
            }

            // 4. If SEARCH — run SOSL server-side
            // Guard: skip if 3a already populated searchResults (low-confidence fallback path)
            if (result.intent == 'SEARCH' && result.searchResults == null) {
                result.searchResults = runSearch(
                    (String) workerResponse.get('search_query'),
                    (String) workerResponse.get('search_sobject'),
                    (List<Object>) workerResponse.get('search_fields')
                );
            }

            // 4b. SOQL_SEARCH — structured SOQL filter → execute with USER_MODE
            if (result.intent == 'SOQL_SEARCH') {
                Object filterRaw = workerResponse.get('soql_filter');
                String targetObj = String.isNotBlank((String) workerResponse.get('search_sobject'))
                    ? (String) workerResponse.get('search_sobject')
                    : sObjectType;
                result.updateSObject = targetObj;

                // Route Data Cloud objects (DMO/DLO) through the DC Query API instead of SOQL
                if (FlashBarDataCloudService.isDataCloudObject(targetObj)) {
                    String dcSql = (String) workerResponse.get('search_query');
                    if (String.isNotBlank(dcSql)) {
                        FlashBarDataCloudService.QueryResult dcResult =
                            FlashBarDataCloudService.executeDataCloudQuery(dcSql);
                        if (dcResult.success) {
                            result.soqlRecords = dcResult.records;
                            result.message = (result.message ?? '') + ' [Data Cloud]';
                        } else {
                            result.intent       = 'UNKNOWN';
                            result.errorMessage = dcResult.errorMessage;
                        }
                    }
                } else if (filterRaw instanceof Map<String, Object>) {
                    Map<String, Object> filterMap = (Map<String, Object>) filterRaw;
                    String condJson  = JSON.serialize(filterMap.get('conditions') ?? new List<Object>());
                    String orderByRaw = filterMap.get('order_by') != null
                        ? String.valueOf(filterMap.get('order_by'))
                        : null;
                    Integer limitVal = filterMap.get('limit') instanceof Integer
                        ? (Integer) filterMap.get('limit')
                        : 20;
                    // Honour explicit "top N / 上位N" in user input
                    Matcher topM = Pattern.compile('(?i)top\\s*(\\d+)|上位\\s*(\\d+)').matcher(userInput ?? '');
                    if (topM.find()) {
                        String nStr = topM.group(1) != null ? topM.group(1) : topM.group(2);
                        if (nStr != null) { Integer n = Integer.valueOf(nStr); if (n > 0) limitVal = n; }
                    }
                    condJson = injectParentFilter(condJson, sObjectType, targetObj, recordId);
                    result.soqlFilterJson = condJson;
                    result.soqlRecords = executeSoqlQuery(targetObj, condJson, null, orderByRaw, limitVal, 0);
                } else {
                    // filterRaw is null — unconditional query (e.g. "show top revenue opportunities"
                    // with no WHERE conditions, or query for child records from a parent page).
                    String condJson = injectParentFilter('[]', sObjectType, targetObj, recordId);
                    result.soqlFilterJson = condJson;
                    // If parent filter was injected the ORDER BY should not force Amount DESC
                    Boolean hasInjected = (condJson != null && condJson != '[]');
                    String defaultOrder = hasInjected ? null : 'Amount DESC';
                    // Honour explicit "top N / 上位N" in user input
                    Integer effectiveLimit = 20;
                    Matcher topM2 = Pattern.compile('(?i)top\\s*(\\d+)|上位\\s*(\\d+)').matcher(userInput ?? '');
                    if (topM2.find()) {
                        String nStr = topM2.group(1) != null ? topM2.group(1) : topM2.group(2);
                        if (nStr != null) { Integer n = Integer.valueOf(nStr); if (n > 0) effectiveLimit = n; }
                    }
                    result.soqlRecords = executeSoqlQuery(targetObj, condJson, null, defaultOrder, effectiveLimit, 0);
                }
            }

            // 4b-fix. SOQL_SEARCH: correct misclassified date-field conditions.
            // The Worker sometimes uses CreatedDate when the user means CloseDate (Opportunity),
            // especially for close-date keywords (完了予定, クローズ) paired with time periods.
            if (result.intent == 'SOQL_SEARCH' && result.soqlRecords != null && result.soqlFilterJson != null) {
                String lower = (userInput ?? '').toLowerCase();
                Boolean hasCloseDateKeyword =
                    lower.contains('完了予定') || lower.contains('クローズ') || lower.contains('期限')
                    || lower.contains('close') || lower.contains('due') || lower.contains('契約予定');
                // Map time-period keywords → target SOQL date literal
                String targetDateLiteral = null;
                if (lower.contains('今月') || lower.contains('this month'))       targetDateLiteral = 'THIS_MONTH';
                else if (lower.contains('来月') || lower.contains('next month'))  targetDateLiteral = 'NEXT_MONTH';
                else if (lower.contains('今週') || lower.contains('this week'))   targetDateLiteral = 'THIS_WEEK';
                else if (lower.contains('来週') || lower.contains('next week'))   targetDateLiteral = 'NEXT_WEEK';
                else if (lower.contains('今四半期') || lower.contains('this quarter')) targetDateLiteral = 'THIS_QUARTER';
                else if (lower.contains('来四半期') || lower.contains('next quarter')) targetDateLiteral = 'NEXT_QUARTER';
                Boolean wantsCloseDate = hasCloseDateKeyword && targetDateLiteral != null;
                if (wantsCloseDate) {
                    try {
                        List<Object> conds = (List<Object>) JSON.deserializeUntyped(result.soqlFilterJson);
                        Boolean hasCloseDate = false;
                        Boolean hasCreatedDate = false;
                        for (Object raw : conds) {
                            Map<String, Object> cm = (Map<String, Object>) raw;
                            if ('CloseDate'.equalsIgnoreCase(String.valueOf(cm.get('field')))) hasCloseDate = true;
                            if ('CreatedDate'.equalsIgnoreCase(String.valueOf(cm.get('field')))) hasCreatedDate = true;
                        }
                        if (!hasCloseDate && hasCreatedDate) {
                            // Replace all CreatedDate conditions with CloseDate = <targetDateLiteral>
                            List<Object> fixed = new List<Object>();
                            for (Object raw : conds) {
                                Map<String, Object> cm = (Map<String, Object>) raw;
                                if (!'CreatedDate'.equalsIgnoreCase(String.valueOf(cm.get('field')))) {
                                    fixed.add(cm);
                                }
                            }
                            fixed.add(new Map<String, Object>{ 'field' => 'CloseDate', 'op' => 'eq', 'value' => targetDateLiteral });
                            String fixedJson = JSON.serialize(fixed);
                            result.soqlFilterJson = fixedJson;
                            result.soqlRecords = executeSoqlQuery(
                                result.updateSObject ?? sObjectType, fixedJson, null, null, 20, 0);
                        }
                    } catch (Exception ignored) {}
                }
            }

            // 4c. NAVIGATE with no targetRecordId + ranking/listing intent → SOQL_SEARCH
            // The Worker occasionally misclassifies "show me top N highest X" as a list-view
            // navigation instead of a ranked query.  Intercept here and execute the query.
            if (result.intent == 'NAVIGATE' && String.isBlank(result.targetRecordId)) {
                String lower = userInput.toLowerCase();
                Pattern rankPat = Pattern.compile(
                    'top\\s*\\d|highest|lowest|most|least|biggest|smallest|ranking|order by|sort by' +
                    '|上位|最高|最低|最大|最小|金額順|件上位|トップ\\s*\\d'
                );
                if (rankPat.matcher(lower).find()) {
                    String rankObj = String.isNotBlank(result.targetSObject) ? result.targetSObject : sObjectType;
                    result.intent        = 'SOQL_SEARCH';
                    result.updateSObject = rankObj;
                    // Determine ORDER BY from keywords
                    String rankOrder = null;
                    if (lower.contains('amount') || lower.contains('金額') || lower.contains('売上')) {
                        rankOrder = (lower.contains('lowest') || lower.contains('least') || lower.contains('最低') || lower.contains('最小'))
                            ? 'Amount ASC NULLS LAST' : 'Amount DESC NULLS LAST';
                    } else if (rankObj == 'Opportunity') {
                        rankOrder = (lower.contains('lowest') || lower.contains('least') || lower.contains('最低') || lower.contains('最小'))
                            ? 'Amount ASC NULLS LAST' : 'Amount DESC NULLS LAST';
                    }
                    // Extract "top N" limit
                    Matcher limitM = Pattern.compile('top\\s*(\\d+)').matcher(lower);
                    Integer rankLimit = limitM.find() ? Integer.valueOf(limitM.group(1)) : 20;
                    String rankCond = injectParentFilter('[]', sObjectType, rankObj, recordId);
                    result.soqlFilterJson = rankCond;
                    result.soqlRecords = executeSoqlQuery(rankObj, rankCond, null, rankOrder, rankLimit, 0);
                }
            }

        } catch (Exception e) {
            String lang = String.isNotBlank(userLanguage) ? userLanguage : UserInfo.getLanguage();
            result.intent       = 'UNKNOWN';
            result.errorMessage = e.getMessage();
            result.message      = i18n(
                'Could not process request. Please try again.',
                'リクエストを処理できませんでした。もう一度お試しください。',
                lang
            );
        }
        return result;
    }

    // ── Field schema fetcher (cache-backed) ──────────────────────────────────

    private static List<String> getFieldLabels(String sObjectType) {
        // Delegates to FlashBarSchemaCacheService (L1 static → L2 SOQL → L3 describe).
        // DML may occur on first call per org/24 h window, always before the callout.
        return FlashBarSchemaCacheService.getLabelsForWorker(sObjectType);
    }

    // ── Cloudflare Worker call ────────────────────────────────────────────────

    private static Map<String, Object> callWorker(
        String userInput,
        String sObjectType,
        String recordId,
        String pageType,
        List<String> fieldLabels,
        String userLanguage
    ) {
        Map<String, Object> payload = new Map<String, Object>{
            'user_input'    => userInput,
            'sObjectType'   => sObjectType,
            'recordId'      => recordId,
            'pageType'      => pageType,
            'field_schema'  => fieldLabels,
            'userLanguage'  => userLanguage,
            // Expose relationship metadata so the Worker can generate parent-scoped
            // SOQL conditions directly (e.g. AccountId = recordId) when the user
            // asks for child records from a parent record page.
            'parent_context' => String.isNotBlank(recordId) ? new Map<String, Object>{
                'sObjectType' => sObjectType,
                'recordId'    => recordId
            } : null
        };

        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:FuruAgent_Backend/v1/agent-action');
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setHeader('X-Salesforce-Org-Id',       UserInfo.getOrganizationId());
        req.setHeader('X-Salesforce-User-Id',      UserInfo.getUserId());
        req.setHeader('X-Salesforce-Instance-Url', System.Url.getOrgDomainUrl().toExternalForm());
        req.setHeader('X-User-Language', userLanguage ?? 'en');
        req.setTimeout(55000);
        req.setBody(JSON.serialize(payload));

        HttpResponse res = new Http().send(req);
        if (res.getStatusCode() != 200) {
            throw new CalloutException('Worker returned HTTP ' + res.getStatusCode());
        }
        return (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
    }

    // ── Response mapper ───────────────────────────────────────────────────────

    private static AgentAction mapToAction(Map<String, Object> r, String sObjectType, String recordId) {
        AgentAction a = new AgentAction();
        a.intent        = (String)  r.get('intent');
        a.message       = (String)  r.get('message');
        a.shouldSave    = r.get('should_save') == true;
        a.updateSObject = String.isNotBlank((String) r.get('sObjectType'))
                          ? (String) r.get('sObjectType')
                          : sObjectType;
        a.updateRecordId = String.isNotBlank((String) r.get('recordId'))
                           ? (String) r.get('recordId')
                           : recordId;

        // Field values
        Object rawFields = r.get('fields');
        if (rawFields instanceof Map<String, Object>) {
            a.fields = (Map<String, Object>) rawFields;
        }

        // Navigation — LLM may use target_sobject or search_sobject or sObjectType
        a.targetRecordId = (String) r.get('target_record_id');
        a.targetUrl      = (String) r.get('target_url');
        String navSObj = (String) r.get('target_sobject');
        if (String.isBlank(navSObj)) navSObj = (String) r.get('search_sobject');
        if (String.isBlank(navSObj)) navSObj = (String) r.get('sObjectType');
        if (String.isBlank(navSObj)) navSObj = sObjectType;
        a.targetSObject = navSObj;

        // Analytics request (CREATE_REPORT / CREATE_DASHBOARD)
        a.analyticsRequest = (String) r.get('analytics_request');

        // Free-trial credit balance (populated by Worker for FREE_TRIAL plan)
        Object rc = r.get('remaining_credits');
        if (rc instanceof Integer)      a.remainingCredits = (Integer) rc;
        else if (rc instanceof Long)    a.remainingCredits = ((Long) rc).intValue();
        else if (rc instanceof Decimal) a.remainingCredits = ((Decimal) rc).intValue();

        // Confidence score (0.0–1.0)
        Object confRaw = r.get('confidence');
        if      (confRaw instanceof Decimal) a.confidence = ((Decimal) confRaw).doubleValue();
        else if (confRaw instanceof Double)  a.confidence = (Double)  confRaw;
        else if (confRaw instanceof Integer) a.confidence = ((Integer) confRaw) + 0.0;

        // Disambiguation candidates (medium-confidence path)
        Object candsRaw = r.get('candidates');
        if (candsRaw instanceof List<Object>) {
            a.candidates = new List<Map<String,Object>>();
            for (Object c : (List<Object>) candsRaw) {
                if (c instanceof Map<String, Object>) a.candidates.add((Map<String,Object>) c);
            }
        }

        // No recordId yet — run SOQL by name to resolve it.
        // If LLM didn't specify sObject, try Account first (most common navigation target).
        if (a.intent == 'NAVIGATE' && String.isBlank(a.targetRecordId)) {
            String searchName = (String) r.get('search_name');
            if (String.isNotBlank(searchName)) {
                String lookupObj = String.isNotBlank(navSObj) ? navSObj : 'Account';
                a.targetRecordId = findRecordId(lookupObj, searchName);
                // If not found in Account, try Contact and Lead as fallback
                if (String.isBlank(a.targetRecordId) && lookupObj == 'Account') {
                    a.targetRecordId = findRecordId('Contact', searchName);
                }
                if (String.isBlank(a.targetRecordId)) {
                    a.targetRecordId = findRecordId('Lead', searchName);
                }
            }
        }
        return a;
    }

    // ── SOSL search ───────────────────────────────────────────────────────────

    private static List<Map<String, Object>> runSearch(String query, String sObjType, List<Object> fields) {
        if (String.isBlank(query)) return new List<Map<String, Object>>();
        String safeQuery = String.escapeSingleQuotes(query);
        String sObj = String.isNotBlank(sObjType) ? sObjType : 'Account,Contact,Lead,Opportunity,Case';

        List<List<SObject>> results = [
            FIND :safeQuery IN ALL FIELDS
            RETURNING
                Account(Id, Name, Phone, BillingCity LIMIT 5),
                Contact(Id, Name, Email, AccountId LIMIT 5),
                Lead(Id, Name, Company, Email LIMIT 5),
                Opportunity(Id, Name, StageName, Amount, CloseDate LIMIT 5),
                Case(Id, Subject, Status, Priority LIMIT 5)
            LIMIT 20
        ];

        List<Map<String, Object>> rows = new List<Map<String, Object>>();
        for (List<SObject> soslGroup : results) {
            for (SObject rec : soslGroup) {
                Map<String, Object> row = new Map<String, Object>{
                    'id'   => rec.Id,
                    'type' => rec.getSObjectType().getDescribe().getLabel()
                };
                row.putAll(rec.getPopulatedFieldsAsMap());
                rows.add(row);
            }
        }
        return rows;
    }

    // ── Field writeability guard ──────────────────────────────────────────────
    // Strips formula / roll-up / read-only fields the LLM invented from training data.
    // Returns the same result with only truly updateable fields remaining.

    private static AgentAction filterUpdateableFields(AgentAction result, String lang) {
        Schema.SObjectType token = Schema.getGlobalDescribe().get(result.updateSObject);
        if (token == null) return result;

        Map<String, Schema.SObjectField> fm = token.getDescribe().fields.getMap();
        Map<String, Object> safe     = new Map<String, Object>();
        List<String>        rejected = new List<String>(); // exists on object, but read-only

        for (String key : result.fields.keySet()) {
            String lower = key.toLowerCase();

            if (!fm.containsKey(lower)) {
                // Field does not exist on this sObject at all — AI used wrong object's fields.
                // Silently skip: there is nothing the user can do, and surfacing it is confusing.
                continue;
            }

            Schema.DescribeFieldResult f = fm.get(lower).getDescribe();

            if (f.isUpdateable()) {
                // FLS + field state check passed — safe to DML
                safe.put(f.getName(), result.fields.get(key));
                continue;
            }

            // Field exists but is not updateable. Check if it is a relationship traversal
            // that can be redirected to its writable FK counterpart:
            //   Standard: Account  → AccountId   (append 'id')
            //   Custom:   Foo__r   → Foo__c       (swap '__r' → '__c')
            String writableApiName = findWritableFkField(lower, fm);
            if (writableApiName != null) {
                Object val    = result.fields.get(key);
                String valStr = val != null ? String.valueOf(val).trim() : '';
                // Redirect only when the value is already a Salesforce record ID.
                if (valStr.length() == 15 || valStr.length() == 18) {
                    safe.put(writableApiName, val);
                }
                // Name-string value → cannot set a FK without a lookup query, silently skip
            } else {
                // Field truly exists on this object but is read-only (formula, rollup, system).
                // Worth reporting so the user understands why the value wasn't saved.
                rejected.add(f.getLabel() + ' (' + key + ')');
            }
        }

        result.fields = safe;

        if (safe.isEmpty() && !rejected.isEmpty()) {
            result.intent       = 'UNKNOWN';
            result.errorMessage = i18n(
                'Read-only field(s) cannot be updated: ' + String.join(rejected, ', ') + '. Try updating a related writable field.',
                '読み取り専用のため更新できませんでした: ' + String.join(rejected, ', ') + '。別の入力可能な項目をお試しください。',
                lang
            );
            result.message = result.errorMessage;
        } else if (!rejected.isEmpty()) {
            String skipped = i18n(
                ' [Skipped read-only: ' + String.join(rejected, ', ') + ']',
                ' [読み取り専用をスキップ: ' + String.join(rejected, ', ') + ']',
                lang
            );
            result.message = (result.message != null ? result.message : '') + skipped;
        }

        return result;
    }

    // Returns the writable FK field API name for a relationship traversal field, or null.
    // Handles both standard (Account → AccountId) and custom (Lookup__r → Lookup__c) patterns.
    private static String findWritableFkField(String lowerFieldName, Map<String, Schema.SObjectField> fm) {
        // Standard relationship: append 'id'
        String candidate = lowerFieldName + 'id';
        if (fm.containsKey(candidate)) {
            Schema.DescribeFieldResult d = fm.get(candidate).getDescribe();
            if (d.isUpdateable()) return d.getName();
        }
        // Custom relationship: swap __r suffix for __c
        if (lowerFieldName.endsWith('__r')) {
            candidate = lowerFieldName.substring(0, lowerFieldName.length() - 3) + '__c';
            if (fm.containsKey(candidate)) {
                Schema.DescribeFieldResult d = fm.get(candidate).getDescribe();
                if (d.isUpdateable()) return d.getName();
            }
        }
        return null;
    }

    // ── Relative ops resolver ─────────────────────────────────────────────────

    private static void resolveRelativeOps(
        List<Object> ops, String recordId, String sObjType, Map<String, Object> fields
    ) {
        if (ops == null || ops.isEmpty() || String.isBlank(recordId)) return;

        List<String> toFetch = new List<String>();
        for (Object raw : ops) {
            String fn = (String)((Map<String,Object>) raw).get('field');
            if (String.isNotBlank(fn) && !toFetch.contains(fn)) toFetch.add(fn);
        }
        if (toFetch.isEmpty()) return;

        try {
            String sObj = String.isNotBlank(sObjType)
                ? sObjType
                : ((Id) recordId).getSObjectType().getDescribe().getName();
            String safe = String.escapeSingleQuotes(recordId);
            List<SObject> recs = Database.query(
                'SELECT ' + String.join(toFetch, ',') + ' FROM ' + sObj + ' WHERE Id = \'' + safe + '\' WITH USER_MODE LIMIT 1'
            );
            if (recs.isEmpty()) return;
            SObject rec = recs[0];

            for (Object raw : ops) {
                Map<String,Object> op = (Map<String,Object>) raw;
                String fn     = (String)  op.get('field');
                String opType = ((String) op.get('op')).toLowerCase();
                Object rv     = op.get('value');
                Decimal amt   = rv instanceof Decimal ? (Decimal) rv
                              : rv instanceof Integer ? Decimal.valueOf((Integer) rv)
                              : rv instanceof Long    ? Decimal.valueOf((Long)    rv)
                              : Decimal.valueOf(String.valueOf(rv));

                Object cur = rec.get(fn);
                Decimal curNum = cur instanceof Decimal ? (Decimal) cur
                               : cur instanceof Integer ? Decimal.valueOf((Integer) cur)
                               : cur instanceof Long    ? Decimal.valueOf((Long)    cur)
                               : null;

                if (opType == 'percent_add' && curNum != null) {
                    fields.put(fn, (curNum * (1 + amt / 100)).setScale(2, RoundingMode.HALF_UP));
                } else if (opType == 'add' && curNum != null) {
                    fields.put(fn, curNum + amt);
                } else if (opType == 'subtract' && curNum != null) {
                    fields.put(fn, curNum - amt);
                } else if (opType == 'add_days' && cur instanceof Date) {
                    fields.put(fn, ((Date) cur).addDays(Integer.valueOf(amt)));
                } else if (opType == 'subtract_days' && cur instanceof Date) {
                    fields.put(fn, ((Date) cur).addDays(-Integer.valueOf(amt)));
                } else if (opType == 'add_weeks' && cur instanceof Date) {
                    fields.put(fn, ((Date) cur).addDays(Integer.valueOf(amt) * 7));
                } else if (opType == 'subtract_weeks' && cur instanceof Date) {
                    fields.put(fn, ((Date) cur).addDays(-Integer.valueOf(amt) * 7));
                } else if (opType == 'add_months' && cur instanceof Date) {
                    fields.put(fn, ((Date) cur).addMonths(Integer.valueOf(amt)));
                } else if (opType == 'subtract_months' && cur instanceof Date) {
                    fields.put(fn, ((Date) cur).addMonths(-Integer.valueOf(amt)));
                }
            }
        } catch (Exception e) { /* unresolved ops simply don't appear in fields */ }
    }

    // ── Address copy resolver ─────────────────────────────────────────────────

    private static Map<String, Object> resolveAddressCopy(String direction, String recordId, String sObjType) {
        Map<String, Object> out = new Map<String, Object>();
        if (String.isBlank(recordId) || String.isBlank(sObjType)) return out;

        Schema.SObjectType token = Schema.getGlobalDescribe().get(sObjType);
        if (token == null) return out;
        Map<String, Schema.SObjectField> fm = token.getDescribe().fields.getMap();

        // When State/Country Picklists are enabled, Country/State label fields are read-only;
        // the writable fields are *CountryCode and *StateCode.
        Boolean hasSCP = fm.containsKey('billingcountrycode');

        List<String> srcFields;
        List<String> tgtFields;

        if (sObjType == 'Account') {
            if (direction == 'BillingToShipping') {
                srcFields = new List<String>{'BillingStreet','BillingCity','BillingPostalCode'};
                tgtFields = new List<String>{'ShippingStreet','ShippingCity','ShippingPostalCode'};
            } else {
                srcFields = new List<String>{'ShippingStreet','ShippingCity','ShippingPostalCode'};
                tgtFields = new List<String>{'BillingStreet','BillingCity','BillingPostalCode'};
            }
            if (hasSCP) {
                // Picklist-enabled org: use Code fields
                if (direction == 'BillingToShipping') {
                    srcFields.addAll(new List<String>{'BillingStateCode','BillingCountryCode'});
                    tgtFields.addAll(new List<String>{'ShippingStateCode','ShippingCountryCode'});
                } else {
                    srcFields.addAll(new List<String>{'ShippingStateCode','ShippingCountryCode'});
                    tgtFields.addAll(new List<String>{'BillingStateCode','BillingCountryCode'});
                }
            } else {
                if (direction == 'BillingToShipping') {
                    srcFields.addAll(new List<String>{'BillingState','BillingCountry'});
                    tgtFields.addAll(new List<String>{'ShippingState','ShippingCountry'});
                } else {
                    srcFields.addAll(new List<String>{'ShippingState','ShippingCountry'});
                    tgtFields.addAll(new List<String>{'BillingState','BillingCountry'});
                }
            }
        } else if (sObjType == 'Contact') {
            Boolean hasMailingSCP = fm.containsKey('mailingcountrycode');
            if (direction == 'BillingToShipping') {
                srcFields = new List<String>{'MailingStreet','MailingCity','MailingPostalCode'};
                tgtFields = new List<String>{'OtherStreet','OtherCity','OtherPostalCode'};
                if (hasMailingSCP) {
                    srcFields.addAll(new List<String>{'MailingStateCode','MailingCountryCode'});
                    tgtFields.addAll(new List<String>{'OtherStateCode','OtherCountryCode'});
                } else {
                    srcFields.addAll(new List<String>{'MailingState','MailingCountry'});
                    tgtFields.addAll(new List<String>{'OtherState','OtherCountry'});
                }
            } else {
                srcFields = new List<String>{'OtherStreet','OtherCity','OtherPostalCode'};
                tgtFields = new List<String>{'MailingStreet','MailingCity','MailingPostalCode'};
                if (hasMailingSCP) {
                    srcFields.addAll(new List<String>{'OtherStateCode','OtherCountryCode'});
                    tgtFields.addAll(new List<String>{'MailingStateCode','MailingCountryCode'});
                } else {
                    srcFields.addAll(new List<String>{'OtherState','OtherCountry'});
                    tgtFields.addAll(new List<String>{'MailingState','MailingCountry'});
                }
            }
        } else {
            return out;
        }

        try {
            String safe = String.escapeSingleQuotes(recordId);
            String soql = 'SELECT ' + String.join(srcFields, ',') + ' FROM ' + sObjType + ' WHERE Id = \'' + safe + '\' WITH USER_MODE LIMIT 1';
            List<SObject> recs = Database.query(soql);
            if (!recs.isEmpty()) {
                Map<String, Object> populated = recs[0].getPopulatedFieldsAsMap();
                for (Integer i = 0; i < srcFields.size(); i++) {
                    out.put(tgtFields[i], populated.get(srcFields[i]));
                }
            }
        } catch (Exception e) { /* silent — caller gets empty map */ }
        return out;
    }

    // ── Single record lookup for navigation ───────────────────────────────────

    // Objects with no standard Name field — "open this <object> <text>" needs a
    // different identifier field to search against. Extend this map rather than
    // hardcoding 'Name' if you add NAVIGATE support for another Name-less object.
    private static final Map<String, String> NAME_LIKE_FIELD_OVERRIDES = new Map<String, String>{
        'Case'  => 'Subject',
        'Task'  => 'Subject',
        'Event' => 'Subject'
    };

    @TestVisible
    private static String resolveNameLikeField(String sObjType) {
        if (NAME_LIKE_FIELD_OVERRIDES.containsKey(sObjType)) return NAME_LIKE_FIELD_OVERRIDES.get(sObjType);
        Schema.SObjectType targetType = Schema.getGlobalDescribe().get(sObjType);
        if (targetType == null) return null;
        Map<String, Schema.SObjectField> fieldMap = targetType.getDescribe().fields.getMap();
        if (fieldMap.containsKey('Name'))    return 'Name';
        if (fieldMap.containsKey('Subject')) return 'Subject';
        return null;
    }

    @TestVisible
    private static String findRecordId(String sObjType, String nameValue) {
        if (String.isBlank(sObjType) || String.isBlank(nameValue)) return null;
        String lookupField = resolveNameLikeField(sObjType);
        if (lookupField == null) return null;
        try {
            String safe = String.escapeSingleQuotes(nameValue);
            String soql = 'SELECT Id FROM ' + sObjType + ' WHERE ' + lookupField
                + ' LIKE \'%' + safe + '%\' WITH USER_MODE LIMIT 1';
            List<SObject> recs = Database.query(soql);
            return recs.isEmpty() ? null : recs[0].Id;
        } catch (Exception e) {
            return null;
        }
    }

    // ── Self-learning knowledge base ──────────────────────────────────────────

    @AuraEnabled
    public static void learnFromValidationError(String sObjType, String errorMessage, String fieldApiNamesJson) {
        if (String.isBlank(sObjType) || String.isBlank(errorMessage)) return;
        // Only learn from actual validation / integrity failures
        if (!errorMessage.containsIgnoreCase('FIELD_CUSTOM_VALIDATION_EXCEPTION')
            && !errorMessage.containsIgnoreCase('FIELD_INTEGRITY_EXCEPTION')
            && !errorMessage.containsIgnoreCase('REQUIRED_FIELD_MISSING')) return;
        if (!Test.isRunningTest()) {
            translateAndSaveRuleAsync(sObjType, errorMessage.left(10000), fieldApiNamesJson ?? '[]');
        }
    }

    @future(callout=true)
    private static void translateAndSaveRuleAsync(String sObjType, String rawError, String fieldNamesJson) {
        try {
            // Deduplicate: LongTextArea can't be filtered in SOQL WHERE, so fetch recent records and compare in Apex
            String errPrefix = rawError.left(60);
            List<FuruAgent_Knowledge__c> recent = [
                SELECT Id, Occurrences__c, Error_Message__c
                FROM FuruAgent_Knowledge__c
                WHERE Target_sObject__c = :sObjType
                ORDER BY Occurrences__c DESC NULLS LAST
                LIMIT 10
            ];
            FuruAgent_Knowledge__c dup = null;
            for (FuruAgent_Knowledge__c r : recent) {
                if (r.Error_Message__c != null && r.Error_Message__c.startsWith(errPrefix)) {
                    dup = r; break;
                }
            }
            if (dup != null) {
                dup.Occurrences__c = (dup.Occurrences__c ?? 0) + 1;
                update dup;
                return;
            }

            // Parse field names from JSON
            List<Object> rawFields = (List<Object>) JSON.deserializeUntyped(fieldNamesJson);
            List<String> fieldNames = new List<String>();
            for (Object f : rawFields) fieldNames.add(String.valueOf(f));

            // Translate with LLM
            String friendlyRule = callWorkerTranslate(sObjType, rawError, fieldNames);

            // Build field label (up to 3, without subList which isn't available)
            List<String> limited = new List<String>();
            for (Integer i = 0; i < fieldNames.size() && i < 3; i++) limited.add(fieldNames[i]);

            // Insert new knowledge record as Pending — requires admin approval before it appears in warnings
            FuruAgent_Knowledge__c k = new FuruAgent_Knowledge__c();
            k.Target_sObject__c     = sObjType;
            k.Trigger_Field__c      = limited.isEmpty() ? null : String.join(limited, ', ').left(255);
            k.Error_Message__c      = rawError.left(32768);
            k.Plain_English_Rule__c = (friendlyRule != null ? friendlyRule : rawError.left(255)).left(32768);
            k.Occurrences__c        = 1;
            k.Status__c             = 'Pending';
            insert k;
        } catch (Exception e) { /* non-critical — silent fail */ }
    }

    @TestVisible
    private static List<String> checkKnowledgeRulesInternal(String sObjType) {
        // Only surface Approved rules — Pending/Rejected/Disabled are invisible to end users
        // LongTextArea (Plain_English_Rule__c) cannot be filtered in SOQL WHERE — filter in Apex loop
        List<FuruAgent_Knowledge__c> rules = [
            SELECT Plain_English_Rule__c
            FROM FuruAgent_Knowledge__c
            WHERE Target_sObject__c = :sObjType
            AND (Status__c = 'Approved' OR Status__c = null)
            ORDER BY Occurrences__c DESC NULLS LAST
            LIMIT 6
        ];
        List<String> out = new List<String>();
        for (FuruAgent_Knowledge__c r : rules) {
            if (String.isNotBlank(r.Plain_English_Rule__c)) {
                out.add(r.Plain_English_Rule__c);
                if (out.size() >= 3) break;
            }
        }
        return out;
    }

    private static String callWorkerTranslate(String sObjType, String rawError, List<String> fieldNames) {
        try {
            Map<String, Object> payload = new Map<String, Object>{
                'sObjectType'     => sObjType,
                'raw_error'       => rawError,
                'fields_involved' => fieldNames
            };
            HttpRequest req = new HttpRequest();
            req.setEndpoint('callout:FuruAgent_Backend/v1/translate-rule');
            req.setMethod('POST');
            req.setHeader('Content-Type', 'application/json');
            req.setHeader('X-Salesforce-Org-Id',       UserInfo.getOrganizationId());
            req.setHeader('X-Salesforce-Instance-Url', System.Url.getOrgDomainUrl().toExternalForm());
            req.setTimeout(55000);
            req.setBody(JSON.serialize(payload));
            HttpResponse res = new Http().send(req);
            if (res.getStatusCode() == 200) {
                Map<String, Object> r = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
                return (String) r.get('friendly_rule');
            }
        } catch (Exception e) { /* silent */ }
        return null;
    }

    // ── Field insights builder (delegated to cache service) ──────────────────

    private static List<FieldInsight> getObjectFieldInsightsInternal(String sObjectType) {
        // Kept for internal callers; getObjectFieldInsights now calls the service directly.
        return FlashBarSchemaCacheService.getInsightsReadOnly(sObjectType);
    }

    private static FieldInsight findFieldInsight(String sObjType, String nameOrLabel) {
        // Uses cache service (L1 static → L2 SOQL → L3 describe).
        // Called after getFieldLabels in processIntent, so txnCache is already warm.
        return FlashBarSchemaCacheService.findInsight(sObjType, nameOrLabel);
    }

    // ── Formula explanation via Worker ────────────────────────────────────────

    private static String callWorkerExplain(String formula, String fieldLabel, String sObjType, String lang) {
        try {
            Map<String, Object> payload = new Map<String, Object>{
                'formula'      => formula,
                'field_label'  => fieldLabel,
                'sobject_type' => sObjType,
                'userLanguage' => lang
            };
            HttpRequest req = new HttpRequest();
            req.setEndpoint('callout:FuruAgent_Backend/v1/explain-formula');
            req.setMethod('POST');
            req.setHeader('Content-Type', 'application/json');
            req.setHeader('X-Salesforce-Org-Id', UserInfo.getOrganizationId());
            req.setTimeout(55000);
            req.setBody(JSON.serialize(payload));
            HttpResponse res = new Http().send(req);
            if (res.getStatusCode() == 200) {
                Map<String, Object> r = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
                return (String) r.get('explanation');
            }
        } catch (Exception e) { /* non-critical */ }
        return null;
    }

    // ── Proactive missing required-field warning ──────────────────────────────

    private static String buildMissingFieldWarning(String sObjType, String recordId, Map<String, Object> updatedFields) {
        try {
            Schema.SObjectType token = Schema.getGlobalDescribe().get(sObjType);
            if (token == null) return null;

            Map<String, Schema.SObjectField> fm = token.getDescribe().fields.getMap();
            Set<String> updatingLower = new Set<String>();
            for (String k : updatedFields.keySet()) updatingLower.add(k.toLowerCase());

            Set<String> skipAlways = new Set<String>{
                'ownerid','currencyisocode','name','id','recordtypeid'
            };

            List<String> toCheck  = new List<String>();
            Map<String, String>  labelMap  = new Map<String, String>();

            for (String apiName : fm.keySet()) {
                if (skipAlways.contains(apiName.toLowerCase())) continue;
                if (updatingLower.contains(apiName.toLowerCase()))  continue;
                Schema.DescribeFieldResult f = fm.get(apiName).getDescribe();
                if (f.isDeprecatedAndHidden() || f.isCalculated() || !f.isUpdateable()) continue;
                if (!f.isNillable() && !f.isDefaultedOnCreate() && f.isCreateable()) {
                    toCheck.add(f.getName());
                    labelMap.put(f.getName(), f.getLabel());
                    if (toCheck.size() >= 8) break;
                }
            }
            if (toCheck.isEmpty()) return null;

            String safe  = String.escapeSingleQuotes(recordId);
            List<SObject> recs = Database.query(
                'SELECT ' + String.join(toCheck, ', ') + ' FROM ' + sObjType
                + ' WHERE Id = \'' + safe + '\' WITH USER_MODE LIMIT 1'
            );
            if (recs.isEmpty()) return null;

            SObject rec = recs[0];
            List<String> emptyLabels = new List<String>();
            for (String fn : toCheck) {
                Object v = rec.get(fn);
                if (v == null || (v instanceof String && String.isBlank((String) v))) {
                    emptyLabels.add(labelMap.get(fn));
                }
            }

            if (!emptyLabels.isEmpty()) {
                return 'Required field(s) still empty: ' + String.join(emptyLabels, ', ')
                    + '. Consider filling before saving.';
            }
        } catch (Exception e) { /* non-critical */ }
        return null;
    }
}
