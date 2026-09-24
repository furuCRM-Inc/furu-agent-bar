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
        @AuraEnabled public String  value;              // current record value (null = not fetched); raw Id for REFERENCE fields
        @AuraEnabled public String  displayValue;        // what to render — resolved parent Name for REFERENCE fields, else same as value
        @AuraEnabled public Boolean isReference;         // true for lookup/master-detail fields
        @AuraEnabled public String  referenceRecordId;   // navigation target for REFERENCE fields (same as value)
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

        Schema.SObjectType   selfToken = Schema.getGlobalDescribe().get(sObjectApiName);
        Map<String, Schema.SObjectField> selfFieldMap = selfToken != null
            ? selfToken.getDescribe().fields.getMap() : new Map<String, Schema.SObjectField>();

        List<String> apiNames = new List<String>{'Id'};
        // apiName -> 'RelationshipName.Name' — only populated when the reference's
        // target object has a resolvable "name-like" field to traverse to.
        Map<String, String> refPathByField = new Map<String, String>();

        for (SummaryField f : defs) {
            if (f.apiName.contains('.')) continue;
            apiNames.add(f.apiName);
            f.isReference = f.fieldType == 'REFERENCE';
            if (!f.isReference) continue;

            Schema.SObjectField sf = selfFieldMap.get(f.apiName);
            if (sf == null) continue;
            Schema.DescribeFieldResult fr = sf.getDescribe();
            List<Schema.SObjectType> refTargets = fr.getReferenceTo();
            String relName = fr.getRelationshipName();
            // Skip polymorphic lookups (e.g. OwnerId, WhoId) — ambiguous which
            // object's name field to traverse to; render the raw Id for those.
            if (refTargets.size() != 1 || String.isBlank(relName)) continue;

            String nameLikeField = resolveReferenceNameField(refTargets[0]);
            if (nameLikeField == null) continue;

            String path = relName + '.' + nameLikeField;
            refPathByField.put(f.apiName, path);
            apiNames.add(path);
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

                    if (f.isReference && f.value != null) {
                        f.referenceRecordId = f.value;
                        String path = refPathByField.get(f.apiName);
                        Object resolvedName = null;
                        if (path != null) {
                            List<String> parts = path.split('\\.');
                            SObject parent = rec.getSObject(parts[0]);
                            resolvedName = parent != null ? parent.get(parts[1]) : null;
                        }
                        f.displayValue = resolvedName != null ? String.valueOf(resolvedName) : f.value;
                    } else {
                        f.displayValue = f.value;
                    }
                }
            }
        } catch (Exception ignored) {}
        return defs;
    }

    /** The field to traverse to for a human-readable label on a lookup's target object. */
    private static String resolveReferenceNameField(Schema.SObjectType targetType) {
        if (targetType == null) return null;
        Map<String, Schema.SObjectField> fieldMap = targetType.getDescribe().fields.getMap();
        if (fieldMap.containsKey('Name'))       return 'Name';
        if (fieldMap.containsKey('Subject'))    return 'Subject';
        if (fieldMap.containsKey('CaseNumber')) return 'CaseNumber';
        return null;
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
