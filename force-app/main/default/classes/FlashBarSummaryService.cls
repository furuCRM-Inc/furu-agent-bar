/**
 * FlashBarSummaryService
 *
 * Builds a compact record summary card for furuAgentBar:
 *   - 100% of required fields (IsNillable=false, !DefaultedOnCreate)
 *   - Top 3 high-value optional fields (CURRENCY, DATE, PHONE, EMAIL, REFERENCE, PICKLIST)
 *   - Field selection persisted to FuruAgent_Knowledge__c for 24 hours (TTL)
 *     using Target_sObject__c = '__SUMMARY__:<ObjectApiName>'
 *
 * getRecordSummary() also fetches current values via a dynamic SOQL query so
 * the LWC renders an actual record snapshot, not just schema metadata.
 *
 * Admin/users can override the field selection via updateSummaryFields(); the
 * edit UI surfaces all candidate fields through getCandidateFields().
 */
public with sharing class FlashBarSummaryService {

    private static final Integer CACHE_TTL_HOURS = 24;
    private static final String  SUMMARY_PFX     = '__SUMMARY__:';
    private static final Integer MAX_OPTIONAL    = 3;

    private static final Set<String> HIGH_VALUE_TYPES = new Set<String>{
        'CURRENCY', 'DOUBLE', 'DATE', 'DATETIME', 'PHONE', 'EMAIL', 'REFERENCE', 'PICKLIST', 'BOOLEAN'
    };
    private static final Set<String> SYSTEM_FIELDS = new Set<String>{
        'id','isdeleted','createddate','createdbyid','lastmodifieddate',
        'lastmodifiedbyid','systemmodstamp','lastactivitydate',
        'lastvieweddate','lastreferenceddate','masterrecordid','ownerid',
        'currencyisocode'
    };
    private static final Set<String> EXCLUDE_TYPES = new Set<String>{
        'TEXTAREA','ENCRYPTEDSTRING','ADDRESS','LOCATION',
        'ANYTYPE','BASE64','COMPLEXVALUE','ID'
    };

    // ── Data model ────────────────────────────────────────────────────────────

    public class SummaryField {
        @AuraEnabled public String  apiName;
        @AuraEnabled public String  label;
        @AuraEnabled public String  fieldType;
        @AuraEnabled public Boolean isRequired;
        @AuraEnabled public String  value;      // current record value (null = not fetched)
        @AuraEnabled public Boolean isChecked;  // selection state in edit mode
    }

    public class SummaryResult {
        @AuraEnabled public List<SummaryField> fields;
        @AuraEnabled public Boolean            isEditable;
    }

    // ── Public interface ──────────────────────────────────────────────────────

    /**
     * Returns the summary field config + current values for a specific record.
     * On cache miss the field selection is generated and persisted asynchronously.
     */
    @AuraEnabled
    public static SummaryResult getRecordSummary(String sObjectApiName, String recordId) {
        SummaryResult result = new SummaryResult();
        result.isEditable = true;
        if (String.isBlank(sObjectApiName) || String.isBlank(recordId)) {
            result.fields = new List<SummaryField>();
            return result;
        }
        List<SummaryField> fieldDefs = getOrGenerateFields(sObjectApiName);
        result.fields = fetchValues(sObjectApiName, recordId, fieldDefs);
        return result;
    }

    /**
     * Returns all candidate fields for the summary field editor, annotated
     * with isChecked reflecting the current selection.
     */
    @AuraEnabled
    public static List<SummaryField> getCandidateFields(String sObjectApiName) {
        if (String.isBlank(sObjectApiName)) return new List<SummaryField>();

        Set<String> selected = new Set<String>();
        for (SummaryField f : getOrGenerateFields(sObjectApiName)) {
            selected.add(f.apiName);
        }

        Schema.SObjectType token = Schema.getGlobalDescribe().get(sObjectApiName);
        if (token == null) return new List<SummaryField>();

        List<SummaryField> out = new List<SummaryField>();
        for (Schema.SObjectField sf : token.getDescribe().fields.getMap().values()) {
            Schema.DescribeFieldResult fr = sf.getDescribe();
            String apiName = fr.getName();
            String typeStr = String.valueOf(fr.getType());
            if (fr.isDeprecatedAndHidden()) continue;
            if (!fr.isAccessible()) continue;
            if (SYSTEM_FIELDS.contains(apiName.toLowerCase())) continue;
            if (EXCLUDE_TYPES.contains(typeStr)) continue;
            SummaryField f = new SummaryField();
            f.apiName    = apiName;
            f.label      = fr.getLabel();
            f.fieldType  = typeStr;
            f.isRequired = fr.isNameField()
                || (!fr.isNillable() && !fr.isDefaultedOnCreate() && fr.isCreateable());
            f.isChecked  = selected.contains(apiName);
            out.add(f);
        }
        return out;
    }

    /**
     * Persists a custom field selection, overriding the auto-generated config.
     * Called when the user saves changes from the summary edit UI.
     */
    @AuraEnabled
    public static String updateSummaryFields(String sObjectApiName, String fieldsJson) {
        try {
            String key = SUMMARY_PFX + sObjectApiName;
            List<FuruAgent_Knowledge__c> recs = [
                SELECT Id FROM FuruAgent_Knowledge__c
                WHERE Target_sObject__c = :key
                WITH USER_MODE LIMIT 1
            ];
            FuruAgent_Knowledge__c rec = recs.isEmpty()
                ? new FuruAgent_Knowledge__c(Target_sObject__c = key)
                : new FuruAgent_Knowledge__c(Id = recs[0].Id);
            rec.Summary_Fields_JSON__c = fieldsJson;
            rec.Last_Cached_At__c      = DateTime.now();
            if (recs.isEmpty()) { insert rec; } else { update rec; }
            return 'OK';
        } catch (Exception e) {
            throw new AuraHandledException('Update failed: ' + e.getMessage());
        }
    }

    // ── Private — cache resolution ────────────────────────────────────────────

    private static List<SummaryField> getOrGenerateFields(String sObjectApiName) {
        String key = SUMMARY_PFX + sObjectApiName;
        try {
            List<FuruAgent_Knowledge__c> recs = [
                SELECT Summary_Fields_JSON__c, Last_Cached_At__c
                FROM FuruAgent_Knowledge__c
                WHERE Target_sObject__c = :key
                WITH USER_MODE LIMIT 1
            ];
            if (!recs.isEmpty()
                && String.isNotBlank(recs[0].Summary_Fields_JSON__c)
                && recs[0].Last_Cached_At__c != null
                && recs[0].Last_Cached_At__c.addHours(CACHE_TTL_HOURS) > DateTime.now()) {
                List<SummaryField> cached = (List<SummaryField>) JSON.deserialize(
                    recs[0].Summary_Fields_JSON__c, List<SummaryField>.class);
                if (!cached.isEmpty()) return cached;
            }
        } catch (Exception ignored) {}

        List<SummaryField> fresh = describeAndScore(sObjectApiName);
        try { cacheAsync(key, JSON.serialize(fresh)); } catch (Exception ignored) {}
        return fresh;
    }

    // ── Private — schema scoring ──────────────────────────────────────────────

    private static List<SummaryField> describeAndScore(String sObjectApiName) {
        Schema.SObjectType token = Schema.getGlobalDescribe().get(sObjectApiName);
        if (token == null) return new List<SummaryField>();

        List<SummaryField> required = new List<SummaryField>();
        List<SummaryField> optional = new List<SummaryField>();

        for (Schema.SObjectField sf : token.getDescribe().fields.getMap().values()) {
            Schema.DescribeFieldResult fr = sf.getDescribe();
            String apiName = fr.getName();
            String typeStr = String.valueOf(fr.getType());

            if (fr.isDeprecatedAndHidden()) continue;
            if (!fr.isAccessible()) continue;
            if (SYSTEM_FIELDS.contains(apiName.toLowerCase())) continue;
            if (EXCLUDE_TYPES.contains(typeStr)) continue;

            // isNameField() ensures Name always appears even for read-only users;
            // isCreateable() gates other required fields to exclude rollup/formula fields.
            Boolean isReq = fr.isNameField()
                || (!fr.isNillable() && !fr.isDefaultedOnCreate() && fr.isCreateable());
            SummaryField f = new SummaryField();
            f.apiName    = apiName;
            f.label      = fr.getLabel();
            f.fieldType  = typeStr;
            f.isRequired = isReq;

            if (isReq) {
                required.add(f);
            } else if (HIGH_VALUE_TYPES.contains(typeStr)) {
                optional.add(f);
            }
        }

        List<SummaryField> result = new List<SummaryField>(required);
        Integer count = 0;
        for (SummaryField f : optional) {
            if (count >= MAX_OPTIONAL) break;
            result.add(f);
            count++;
        }
        return result;
    }

    // ── Private — value fetch ─────────────────────────────────────────────────

    private static List<SummaryField> fetchValues(String sObjectApiName, String recordId, List<SummaryField> defs) {
        if (defs.isEmpty()) return defs;

        List<String> apiNames = new List<String>{'Id'};
        for (SummaryField f : defs) {
            if (!f.apiName.contains('.')) apiNames.add(f.apiName);
        }
        try {
            String soql = 'SELECT ' + String.join(apiNames, ', ')
                + ' FROM ' + sObjectApiName
                + ' WHERE Id = :recordId WITH USER_MODE LIMIT 1';
            List<SObject> recs = Database.query(soql);
            if (!recs.isEmpty()) {
                SObject rec = recs[0];
                for (SummaryField f : defs) {
                    if (f.apiName.contains('.')) continue;
                    Object raw = rec.get(f.apiName);
                    f.value = raw != null ? String.valueOf(raw) : null;
                }
            }
        } catch (Exception ignored) {}
        return defs;
    }

    // ── Private — async cache write ───────────────────────────────────────────

    @future
    private static void cacheAsync(String key, String fieldsJson) {
        try {
            List<FuruAgent_Knowledge__c> recs = [
                SELECT Id FROM FuruAgent_Knowledge__c
                WHERE Target_sObject__c = :key
                WITH USER_MODE LIMIT 1
            ];
            FuruAgent_Knowledge__c rec = recs.isEmpty()
                ? new FuruAgent_Knowledge__c(Target_sObject__c = key)
                : new FuruAgent_Knowledge__c(Id = recs[0].Id);
            rec.Summary_Fields_JSON__c = fieldsJson;
            rec.Last_Cached_At__c      = DateTime.now();
            if (recs.isEmpty()) { insert rec; } else { update rec; }
        } catch (Exception ignored) {}
    }
}
