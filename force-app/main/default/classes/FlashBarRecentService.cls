public with sharing class FlashBarRecentService {

    public class RecentRecord {
        @AuraEnabled public String id;
        @AuraEnabled public String name;
        @AuraEnabled public String type;
        @AuraEnabled public String icon;
    }

    private static final Map<String, String> ICONS = new Map<String, String>{
        'Account'     => '🏢',
        'Opportunity' => '💼',
        'Contact'     => '👤',
        'Lead'        => '🪪',
        'Case'        => '🎫'
    };

    @AuraEnabled(cacheable=true)
    public static List<RecentRecord> getRecentRecords() {
        List<RecentRecord> result = new List<RecentRecord>();
        try {
            for (RecentlyViewed rv : [
                SELECT Id, Name, Type
                FROM RecentlyViewed
                WHERE Type IN ('Account', 'Opportunity', 'Contact', 'Lead', 'Case')
                ORDER BY LastViewedDate DESC
                LIMIT 5
            ]) {
                RecentRecord r = new RecentRecord();
                r.id   = rv.Id;
                r.name = rv.Name ?? '(no name)';
                r.type = rv.Type;
                r.icon = ICONS.containsKey(rv.Type) ? ICONS.get(rv.Type) : '📄';
                result.add(r);
            }
        } catch (Exception ignored) {}
        return result;
    }
}
