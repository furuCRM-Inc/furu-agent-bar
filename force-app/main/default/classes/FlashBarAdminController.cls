/**
 * FlashBarAdminController
 * Admin-only methods for the inline rule approval and management UI.
 * All DML is guarded by isFlashBarAdmin() — non-admins receive empty results or AuraHandledException.
 */
public with sharing class FlashBarAdminController {

    // ── Public types ──────────────────────────────────────────────────────────

    public class AdminContext {
        @AuraEnabled public Boolean isAdmin;
        @AuraEnabled public Integer pendingCount;
    }

    public class KnowledgeRule {
        @AuraEnabled public String  id;
        @AuraEnabled public String  sObjectType;
        @AuraEnabled public String  ruleText;
        @AuraEnabled public String  errorMessage;  // raw DML error, fallback when ruleText is null
        @AuraEnabled public String  status;        // Pending | Approved | Rejected | Disabled
        @AuraEnabled public Integer occurrences;
        @AuraEnabled public String  createdDate;
        @AuraEnabled public Boolean isEnabled;
        @AuraEnabled public String  triggerField;
    }

    // ── Read methods ──────────────────────────────────────────────────────────

    @AuraEnabled(cacheable=true)
    public static AdminContext getAdminContext() {
        AdminContext ctx = new AdminContext();
        ctx.isAdmin      = isFlashBarAdmin();
        ctx.pendingCount = 0;
        if (ctx.isAdmin) {
            try {
                ctx.pendingCount = Database.countQuery(
                    'SELECT COUNT() FROM FuruAgent_Knowledge__c WHERE Status__c = \'Pending\'');
            } catch (Exception e) {
                // Fires on every component mount for admin users — never let a schema
                // gap here mask itself as the platform's generic cacheable-method
                // "Script-thrown exception" toast on top of an unrelated action.
            }
        }
        return ctx;
    }

    @AuraEnabled(cacheable=true)
    public static List<KnowledgeRule> getPendingRules(String sObjectType) {
        if (!isFlashBarAdmin()) return new List<KnowledgeRule>();
        try {
            List<FuruAgent_Knowledge__c> recs = [
                SELECT Id, Target_sObject__c, Plain_English_Rule__c, Error_Message__c, Status__c,
                       Occurrences__c, CreatedDate, Trigger_Field__c
                FROM FuruAgent_Knowledge__c
                WHERE Status__c = 'Pending'
                ORDER BY Occurrences__c DESC NULLS LAST, CreatedDate DESC
                LIMIT 5
            ];
            // Prioritise records matching current sObject, then others
            List<FuruAgent_Knowledge__c> priority = new List<FuruAgent_Knowledge__c>();
            List<FuruAgent_Knowledge__c> rest     = new List<FuruAgent_Knowledge__c>();
            for (FuruAgent_Knowledge__c r : recs) {
                if (r.Target_sObject__c == sObjectType) priority.add(r);
                else rest.add(r);
            }
            List<FuruAgent_Knowledge__c> sorted = new List<FuruAgent_Knowledge__c>();
            sorted.addAll(priority);
            sorted.addAll(rest);
            return toRuleList(sorted);
        } catch (Exception e) {
            return new List<KnowledgeRule>();
        }
    }

    @AuraEnabled(cacheable=true)
    public static List<KnowledgeRule> getAllRules(String sObjectType) {
        if (!isFlashBarAdmin()) return new List<KnowledgeRule>();
        try {
            String filter = String.isNotBlank(sObjectType) ? sObjectType : null;
            List<FuruAgent_Knowledge__c> recs = filter != null
                ? [SELECT Id, Target_sObject__c, Plain_English_Rule__c, Error_Message__c, Status__c,
                          Occurrences__c, CreatedDate, Trigger_Field__c
                   FROM FuruAgent_Knowledge__c
                   WHERE Target_sObject__c = :filter AND Status__c != 'Rejected'
                   WITH USER_MODE
                   ORDER BY Status__c, Occurrences__c DESC NULLS LAST LIMIT 50]
                : [SELECT Id, Target_sObject__c, Plain_English_Rule__c, Error_Message__c, Status__c,
                          Occurrences__c, CreatedDate, Trigger_Field__c
                   FROM FuruAgent_Knowledge__c
                   WHERE Status__c != 'Rejected'
                   WITH USER_MODE
                   ORDER BY Status__c, Occurrences__c DESC NULLS LAST LIMIT 50];
            return toRuleList(recs);
        } catch (Exception e) {
            return new List<KnowledgeRule>();
        }
    }

    // ── Write methods ─────────────────────────────────────────────────────────

    @AuraEnabled
    public static void approveRule(String ruleId) {
        requireAdmin();
        Database.update(new FuruAgent_Knowledge__c(Id = ruleId, Status__c = 'Approved'), AccessLevel.USER_MODE);
    }

    @AuraEnabled
    public static void rejectRule(String ruleId) {
        requireAdmin();
        Database.update(new FuruAgent_Knowledge__c(Id = ruleId, Status__c = 'Rejected'), AccessLevel.USER_MODE);
    }

    @AuraEnabled
    public static void toggleRule(String ruleId, Boolean enable) {
        requireAdmin();
        Database.update(new FuruAgent_Knowledge__c(Id = ruleId, Status__c = enable ? 'Approved' : 'Disabled'), AccessLevel.USER_MODE);
    }

    @AuraEnabled
    public static void deleteRule(String ruleId) {
        requireAdmin();
        Database.delete(new FuruAgent_Knowledge__c(Id = ruleId), AccessLevel.USER_MODE);
    }

    @AuraEnabled
    public static void updateRuleText(String ruleId, String newText) {
        requireAdmin();
        if (String.isBlank(newText)) throw new AuraHandledException('ルール内容を入力してください。');
        Database.update(new FuruAgent_Knowledge__c(Id = ruleId, Plain_English_Rule__c = newText.trim().left(32768)), AccessLevel.USER_MODE);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    public static Boolean isFlashBarAdmin() {
        try {
            if (FeatureManagement.checkPermission('FlashBar_Admin_Access')) return true;
        } catch (Exception e) { /* custom permission not deployed — fall through */ }
        return [SELECT PermissionsModifyAllData FROM Profile
                WHERE Id = :UserInfo.getProfileId()
                WITH USER_MODE LIMIT 1].PermissionsModifyAllData;
    }

    private static void requireAdmin() {
        if (!isFlashBarAdmin()) throw new AuraHandledException('管理者権限が必要です。');
    }

    private static List<KnowledgeRule> toRuleList(List<FuruAgent_Knowledge__c> recs) {
        List<KnowledgeRule> out = new List<KnowledgeRule>();
        for (FuruAgent_Knowledge__c r : recs) {
            KnowledgeRule kr  = new KnowledgeRule();
            kr.id             = r.Id;
            kr.sObjectType    = r.Target_sObject__c;
            kr.ruleText       = r.Plain_English_Rule__c;
            kr.errorMessage   = r.Error_Message__c != null ? r.Error_Message__c.left(300) : null;
            kr.status         = r.Status__c != null ? r.Status__c : 'Approved';
            kr.occurrences    = (Integer)(r.Occurrences__c ?? 1);
            kr.createdDate    = r.CreatedDate?.format('yyyy/MM/dd');
            kr.isEnabled      = (kr.status == 'Approved');
            kr.triggerField   = r.Trigger_Field__c;
            out.add(kr);
        }
        return out;
    }
}
