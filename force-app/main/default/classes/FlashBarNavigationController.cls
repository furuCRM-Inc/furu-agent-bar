public with sharing class FlashBarNavigationController {

    /**
     * Returns the logged-in user's pinned navigation items, ordered by Sort_Order__c.
     */
    @AuraEnabled(cacheable=true)
    public static List<FlashBar_Nav_Item__c> getUserNavItems() {
        // Fires unconditionally on every component mount for every user — never let
        // a schema gap here mask itself as the platform's generic cacheable-method
        // "Script-thrown exception" toast before the user has done anything.
        try {
            return [
                SELECT Id, Label__c, Target_Type__c, Target_SOQL_Filter__c,
                       Target_URL_Page__c, Icon_Name__c, Sort_Order__c
                FROM FlashBar_Nav_Item__c
                WHERE User__c = :UserInfo.getUserId()
                WITH USER_MODE
                ORDER BY Sort_Order__c ASC NULLS LAST, CreatedDate DESC
                LIMIT 20
            ];
        } catch (Exception e) {
            return new List<FlashBar_Nav_Item__c>();
        }
    }

    /**
     * Pins the user's current SOQL query as a named navigation shortcut.
     * soqlJson encodes { sObject, conditions, orderBy, limit, selectFields } to match
     * the existing savedQuery format used in furuAgentBar.js.
     */
    @AuraEnabled
    public static FlashBar_Nav_Item__c pinQuery(String label, String soqlJson, String iconName) {
        if (String.isBlank(label) || String.isBlank(soqlJson)) {
            throw new AuraHandledException('Label and query are required.');
        }
        FlashBar_Nav_Item__c item = new FlashBar_Nav_Item__c();
        item.User__c                = UserInfo.getUserId();
        item.Label__c               = label.left(80);
        item.Target_Type__c         = 'ListEditor';
        item.Target_SOQL_Filter__c  = soqlJson;
        item.Icon_Name__c           = String.isNotBlank(iconName) ? iconName.left(50) : '📌';
        Integer maxOrder = 0;
        List<AggregateResult> agg = [
            SELECT MAX(Sort_Order__c) maxOrd
            FROM FlashBar_Nav_Item__c
            WHERE User__c = :UserInfo.getUserId()
            WITH USER_MODE
        ];
        if (!agg.isEmpty() && agg[0].get('maxOrd') != null) {
            maxOrder = Integer.valueOf(agg[0].get('maxOrd'));
        }
        item.Sort_Order__c = maxOrder + 1;
        Database.insert(item, AccessLevel.USER_MODE);
        return [
            SELECT Id, Label__c, Target_Type__c, Target_SOQL_Filter__c,
                   Target_URL_Page__c, Icon_Name__c, Sort_Order__c
            FROM FlashBar_Nav_Item__c
            WHERE Id = :item.Id
            WITH USER_MODE
        ];
    }

    /**
     * Creates a page-navigation nav item (e.g. a report URL or Lightning page).
     */
    @AuraEnabled
    public static FlashBar_Nav_Item__c pinPage(String label, String url, String iconName) {
        if (String.isBlank(label) || String.isBlank(url)) {
            throw new AuraHandledException('Label and URL are required.');
        }
        FlashBar_Nav_Item__c item = new FlashBar_Nav_Item__c();
        item.User__c             = UserInfo.getUserId();
        item.Label__c            = label.left(80);
        item.Target_Type__c      = 'Page';
        item.Target_URL_Page__c  = url.left(255);
        item.Icon_Name__c        = String.isNotBlank(iconName) ? iconName.left(50) : '🔗';
        Database.insert(item, AccessLevel.USER_MODE);
        return [
            SELECT Id, Label__c, Target_Type__c, Target_SOQL_Filter__c,
                   Target_URL_Page__c, Icon_Name__c, Sort_Order__c
            FROM FlashBar_Nav_Item__c
            WHERE Id = :item.Id
            WITH USER_MODE
        ];
    }

    /**
     * Deletes a nav item (user can only delete their own).
     */
    @AuraEnabled
    public static void deleteNavItem(String itemId) {
        List<FlashBar_Nav_Item__c> toDelete = [
            SELECT Id FROM FlashBar_Nav_Item__c
            WHERE Id = :itemId AND User__c = :UserInfo.getUserId()
            WITH USER_MODE
            LIMIT 1
        ];
        if (toDelete.isEmpty()) throw new AuraHandledException('Nav item not found or access denied.');
        Database.delete(toDelete, AccessLevel.USER_MODE);
    }
}
