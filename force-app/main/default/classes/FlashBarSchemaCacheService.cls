/**
 * FlashBarSchemaCacheService
 *
 * Provides a two-level cache for Salesforce object field metadata so that
 * FuruAgentController.processIntent never calls Schema.getGlobalDescribe()
 * more than once per 24 hours per sObject:
 *
 *   L1 — static Map (within-transaction, ~0 ms)
 *   L2 — FuruAgent_Knowledge__c records keyed "__CACHE__:<SObjectApiName>"
 *         with Last_Cached_At__c TTL of 24 hours (~1 ms SOQL)
 *   L3 — Live Schema.getGlobalDescribe() on cold start or expiry (tens of ms)
 *
 * Cache records use a "__CACHE__:" prefix on Target_sObject__c so they are
 * invisible to all existing rule-lookup queries (which filter for exact object
 * names like "Opportunity").
 */
public with sharing class FlashBarSchemaCacheService {

    private static final Integer CACHE_TTL_HOURS = 24;
    private static final String  KEY_PFX         = '__CACHE__:';

    // L1: within-transaction static cache — reset per Apex execution context
    @TestVisible
    private static Map<String, List<CachedField>> txnCache = new Map<String, List<CachedField>>();

    // ── Data model ───────────────────────────────────────────────────────────

    public class CachedField {
        public String  n;    // apiName
        public String  l;    // label
        public String  h;    // inlineHelpText (may be null)
        public String  t;    // displayType string (e.g. "STRING", "CURRENCY")
        public Boolean r;    // isRequired  = !nillable && !defaultedOnCreate && createable
        public Boolean ca;   // isCalculated (formula field)
        public String  fm;   // formulaLiteral (null unless calculated)
        public Boolean upd;  // isUpdateable
        public Boolean cr;   // isCreateable
        public Boolean dep;  // isDeprecatedAndHidden
        public Boolean skip; // true for Address / Location compound types
        public Integer len;  // length  (String / TextArea / Email / Phone / Url)
        public Integer pre;  // precision (Currency / Double / Integer / Percent)
        public Integer sc;   // scale     (Currency / Double / Percent)
        public List<String> pk; // first 5 active picklist values (null when not picklist)
    }

    // ── Public interface ─────────────────────────────────────────────────────

    /**
     * Returns "label=apiName" list for Cloudflare Worker context.
     * Replaces FuruAgentController.getFieldLabels().
     * Safe for non-cacheable Apex methods — may do DML to warm the L2 cache.
     */
    public static List<String> getLabelsForWorker(String sObjApiName) {
        List<String> out = new List<String>();
        if (String.isBlank(sObjApiName)) return out;
        for (CachedField cf : resolve(sObjApiName)) {
            if (cf.dep != true && cf.upd == true && cf.skip != true) {
                out.add(cf.l + '=' + cf.n);
            }
        }
        return out;
    }

    /**
     * Returns FieldInsight list for the ambient context panel.
     * Replaces FuruAgentController.getObjectFieldInsightsInternal().
     * READ-ONLY — safe for cacheable=true Apex methods (no DML).
     */
    public static List<FuruAgentController.FieldInsight> getInsightsReadOnly(String sObjApiName) {
        if (String.isBlank(sObjApiName)) return new List<FuruAgentController.FieldInsight>();
        return buildInsightList(resolveReadOnly(sObjApiName));
    }

    /**
     * Finds a single FieldInsight by API name or label.
     * Replaces FuruAgentController.findFieldInsight().
     * Safe for non-cacheable methods.
     */
    public static FuruAgentController.FieldInsight findInsight(String sObjApiName, String nameOrLabel) {
        if (String.isBlank(sObjApiName) || String.isBlank(nameOrLabel)) return null;
        String search = nameOrLabel.toLowerCase().trim();
        for (CachedField cf : resolve(sObjApiName)) {
            if (cf.n.toLowerCase() == search
                || cf.l.toLowerCase().contains(search)
                || cf.n.toLowerCase().contains(search)) {
                return toInsight(cf);
            }
        }
        return null;
    }

    /**
     * Admin-triggered forced refresh — bypasses TTL and re-describes immediately.
     * Called from the ⚙️ settings panel in furuAgentBar.
     */
    @AuraEnabled
    public static String refreshSchemaCache(String sObjApiName) {
        try {
            if (String.isBlank(sObjApiName)) throw new AuraHandledException('sObjectApiName required');
            txnCache.remove(sObjApiName);
            List<CachedField> fresh = describeFields(sObjApiName);
            txnCache.put(sObjApiName, fresh);
            persistCache(sObjApiName, JSON.serialize(fresh), findExistingId(sObjApiName));
            return 'OK';
        } catch (AuraHandledException ahe) {
            throw ahe;
        } catch (Exception e) {
            throw new AuraHandledException('Cache refresh failed: ' + e.getMessage());
        }
    }

    // ── Private — cache resolution ────────────────────────────────────────────

    /**
     * Full resolve: L1 → L2 SOQL → L3 describe + L2 write.
     * Call from non-cacheable methods only (DML may occur on miss).
     */
    private static List<CachedField> resolve(String sObjApiName) {
        // L1 hit
        if (txnCache.containsKey(sObjApiName)) return txnCache.get(sObjApiName);

        // L2 lookup
        Id existingId = null;
        try {
            String key = KEY_PFX + sObjApiName;
            List<FuruAgent_Knowledge__c> recs = [
                SELECT Id, Schema_JSON__c, Last_Cached_At__c
                FROM FuruAgent_Knowledge__c
                WHERE Target_sObject__c = :key
                WITH USER_MODE
                LIMIT 1
            ];
            if (!recs.isEmpty()) {
                existingId = recs[0].Id;
                FuruAgent_Knowledge__c rec = recs[0];
                if (String.isNotBlank(rec.Schema_JSON__c)
                    && rec.Last_Cached_At__c != null
                    && rec.Last_Cached_At__c.addHours(CACHE_TTL_HOURS) > DateTime.now()) {
                    List<CachedField> hit = (List<CachedField>) JSON.deserialize(
                        rec.Schema_JSON__c, List<CachedField>.class);
                    txnCache.put(sObjApiName, hit);
                    return hit;
                }
            }
        } catch (Exception ignored) { /* fall through to describe */ }

        // L3 describe + async write — @future avoids DML-before-callout exception
        List<CachedField> fresh = describeFields(sObjApiName);
        txnCache.put(sObjApiName, fresh);
        try { persistCacheAsync(sObjApiName, JSON.serialize(fresh)); } catch (Exception ignored) {}
        return fresh;
    }

    @future
    private static void persistCacheAsync(String sObjApiName, String jsonBody) {
        persistCache(sObjApiName, jsonBody, findExistingId(sObjApiName));
    }

    /**
     * Read-only resolve: L1 → L2 SOQL → L3 describe (no DML).
     * Safe for cacheable=true Apex methods.
     */
    private static List<CachedField> resolveReadOnly(String sObjApiName) {
        if (txnCache.containsKey(sObjApiName)) return txnCache.get(sObjApiName);

        try {
            String key = KEY_PFX + sObjApiName;
            List<FuruAgent_Knowledge__c> recs = [
                SELECT Schema_JSON__c, Last_Cached_At__c
                FROM FuruAgent_Knowledge__c
                WHERE Target_sObject__c = :key
                WITH USER_MODE
                LIMIT 1
            ];
            if (!recs.isEmpty()
                && String.isNotBlank(recs[0].Schema_JSON__c)
                && recs[0].Last_Cached_At__c != null
                && recs[0].Last_Cached_At__c.addHours(CACHE_TTL_HOURS) > DateTime.now()) {
                List<CachedField> hit = (List<CachedField>) JSON.deserialize(
                    recs[0].Schema_JSON__c, List<CachedField>.class);
                txnCache.put(sObjApiName, hit);
                return hit;
            }
        } catch (Exception ignored) {}

        List<CachedField> fresh = describeFields(sObjApiName);
        txnCache.put(sObjApiName, fresh);
        return fresh; // no DML — caller is cacheable
    }

    // ── Private — describe & persist ─────────────────────────────────────────

    private static List<CachedField> describeFields(String sObjApiName) {
        Schema.SObjectType token = Schema.getGlobalDescribe().get(sObjApiName);
        if (token == null) return new List<CachedField>();
        Map<String, Schema.SObjectField> fm = token.getDescribe().fields.getMap();
        List<CachedField> out = new List<CachedField>();
        for (Schema.SObjectField sf : fm.values()) {
            Schema.DescribeFieldResult fr = sf.getDescribe();
            Schema.DisplayType dt = fr.getType();
            CachedField cf = new CachedField();
            cf.n    = fr.getName();
            cf.l    = fr.getLabel();
            cf.h    = fr.getInlineHelpText();
            cf.t    = String.valueOf(dt);
            cf.r    = !fr.isNillable() && !fr.isDefaultedOnCreate() && fr.isCreateable();
            cf.ca   = fr.isCalculated();
            cf.fm   = fr.getCalculatedFormula();
            cf.upd  = fr.isUpdateable();
            cf.cr   = fr.isCreateable();
            cf.dep  = fr.isDeprecatedAndHidden();
            cf.skip = (dt == Schema.DisplayType.Address || dt == Schema.DisplayType.Location);
            if (dt == Schema.DisplayType.String    || dt == Schema.DisplayType.TextArea
             || dt == Schema.DisplayType.Email     || dt == Schema.DisplayType.Phone
             || dt == Schema.DisplayType.Url) {
                cf.len = fr.getLength();
            }
            if (dt == Schema.DisplayType.Currency  || dt == Schema.DisplayType.Double
             || dt == Schema.DisplayType.Integer   || dt == Schema.DisplayType.Percent) {
                cf.pre = fr.getPrecision();
                cf.sc  = fr.getScale();
            }
            if (dt == Schema.DisplayType.Picklist  || dt == Schema.DisplayType.MultiPicklist) {
                cf.pk = new List<String>();
                for (Schema.PicklistEntry pe : fr.getPicklistValues()) {
                    if (pe.isActive() && cf.pk.size() < 5) cf.pk.add(pe.getValue());
                }
            }
            out.add(cf);
        }
        return out;
    }

    private static Id findExistingId(String sObjApiName) {
        try {
            String key = KEY_PFX + sObjApiName;
            List<FuruAgent_Knowledge__c> recs = [
                SELECT Id FROM FuruAgent_Knowledge__c
                WHERE Target_sObject__c = :key
                WITH USER_MODE LIMIT 1
            ];
            return recs.isEmpty() ? null : recs[0].Id;
        } catch (Exception e) { return null; }
    }

    private static void persistCache(String sObjApiName, String jsonBody, Id existingId) {
        try {
            String key = KEY_PFX + sObjApiName;
            FuruAgent_Knowledge__c rec = existingId != null
                ? new FuruAgent_Knowledge__c(Id = existingId)
                : new FuruAgent_Knowledge__c(Target_sObject__c = key);
            rec.Schema_JSON__c    = jsonBody;
            rec.Last_Cached_At__c = DateTime.now();
            if (existingId != null) { update rec; } else { insert rec; }
        } catch (Exception ignored) {
            // Cache write is non-fatal — next request will re-describe
        }
    }

    // ── Private — insight builders ────────────────────────────────────────────

    private static List<FuruAgentController.FieldInsight> buildInsightList(List<CachedField> fields) {
        Set<String> systemFields = new Set<String>{
            'id','isdeleted','createddate','createdbyid','lastmodifieddate',
            'lastmodifiedbyid','systemmodstamp','lastactivitydate',
            'lastvieweddate','lastreferenceddate','masterrecordid'
        };
        List<FuruAgentController.FieldInsight> required   = new List<FuruAgentController.FieldInsight>();
        List<FuruAgentController.FieldInsight> optional   = new List<FuruAgentController.FieldInsight>();
        List<FuruAgentController.FieldInsight> calculated = new List<FuruAgentController.FieldInsight>();

        for (CachedField cf : fields) {
            if (cf.dep == true || cf.skip == true
                || systemFields.contains(cf.n.toLowerCase())) continue;
            FuruAgentController.FieldInsight fi = toInsight(cf);
            if (fi.isCalculated == true) {
                if (calculated.size() < 4) calculated.add(fi);
            } else if (fi.isRequired == true) {
                required.add(fi);
            } else if (optional.size() < 8) {
                optional.add(fi);
            }
        }
        List<FuruAgentController.FieldInsight> all = new List<FuruAgentController.FieldInsight>();
        all.addAll(required); all.addAll(optional); all.addAll(calculated);
        return all;
    }

    private static FuruAgentController.FieldInsight toInsight(CachedField cf) {
        FuruAgentController.FieldInsight fi = new FuruAgentController.FieldInsight();
        fi.apiName        = cf.n;
        fi.label          = cf.l;
        fi.helpText       = cf.h;
        fi.isCalculated   = cf.ca == true;
        fi.formulaLiteral = cf.fm;
        fi.fieldType      = cf.t;
        fi.isUpdateable   = cf.upd == true || cf.cr == true;
        fi.isRequired     = cf.r == true;
        String t = cf.t ?? '';
        if (t == 'STRING' || t == 'TEXTAREA' || t == 'EMAIL' || t == 'PHONE' || t == 'URL') {
            fi.length = cf.len;
        }
        if (t == 'CURRENCY' || t == 'DOUBLE' || t == 'INTEGER' || t == 'PERCENT') {
            fi.precision = cf.pre;
            fi.scale     = cf.sc;
        }
        if (t == 'PICKLIST' || t == 'MULTIPICKLIST') {
            fi.picklistOptions = cf.pk;
        }
        return fi;
    }
}
