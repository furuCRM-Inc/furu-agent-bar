/**
 * FlashBarRecordCreateService
 *
 * Generic "create or update a record from a map of field values" service used
 * by furuAgentBar's prefill/review card (PREFILL, EXTRACT, EXTRACT_AND_PREFILL
 * intents — memo parsing, address autofill, and previously OCR). Handles type
 * coercion (Currency -> Decimal, Date -> Date, etc.) so the LWC doesn't need
 * to know each field's display type.
 *
 * Extracted from FlashBarOCRController, which is Einstein/Agentforce-Vision
 * -specific and excluded from the unlocked package (the packaging validation
 * org can't grant ConnectApi.EinsteinLLM access); this method has no such
 * dependency and needs to ship with the package.
 */
public with sharing class FlashBarRecordCreateService {

    /**
     * Creates or updates a Salesforce record from a map of field values.
     *
     * @param sObjectApiName  Target sObject API name (e.g., 'Lead', 'Opportunity')
     * @param fieldsJson      JSON object of { apiName: rawValue } pairs
     * @param recordId        Existing record Id for update; blank/null for create
     * @return                The Id of the created or updated record
     */
    @AuraEnabled
    public static String createRecordFromFields(String sObjectApiName, String fieldsJson, String recordId) {
        if (String.isBlank(sObjectApiName) || String.isBlank(fieldsJson)) {
            throw new AuraHandledException('sObjectApiName and fieldsJson are required.');
        }
        Schema.SObjectType token = Schema.getGlobalDescribe().get(sObjectApiName);
        if (token == null) throw new AuraHandledException('Unknown sObject: ' + sObjectApiName);

        Map<String, Object> rawFields = (Map<String, Object>) JSON.deserializeUntyped(fieldsJson);
        Map<String, Schema.SObjectField> fm = token.getDescribe().fields.getMap();
        Boolean isCreate = String.isBlank(recordId);
        SObject rec = isCreate ? token.newSObject() : token.newSObject(recordId);

        for (String apiName : rawFields.keySet()) {
            String lower = apiName.toLowerCase();
            if (!fm.containsKey(lower)) continue;
            Schema.DescribeFieldResult fr = fm.get(lower).getDescribe();
            if (isCreate  && !fr.isCreateable())  continue;
            if (!isCreate && !fr.isUpdateable())  continue;

            Object val    = rawFields.get(apiName);
            if (val == null) continue;
            String strVal = String.valueOf(val).trim();
            if (String.isBlank(strVal)) continue;

            Schema.DisplayType dt = fr.getType();
            try {
                if (dt == Schema.DisplayType.Currency || dt == Schema.DisplayType.Double
                 || dt == Schema.DisplayType.Percent) {
                    rec.put(fr.getName(), Decimal.valueOf(strVal.replaceAll('[^0-9.]', '')));
                } else if (dt == Schema.DisplayType.Integer) {
                    rec.put(fr.getName(), Integer.valueOf(strVal.replaceAll('[^0-9]', '')));
                } else if (dt == Schema.DisplayType.Date) {
                    rec.put(fr.getName(), Date.valueOf(strVal));
                } else if (dt == Schema.DisplayType.DateTime) {
                    rec.put(fr.getName(), DateTime.valueOf(strVal));
                } else if (dt == Schema.DisplayType.Boolean) {
                    rec.put(fr.getName(), 'true'.equalsIgnoreCase(strVal));
                } else {
                    rec.put(fr.getName(), strVal);
                }
            } catch (Exception typeErr) { /* incompatible value — skip silently */ }
        }

        try {
            if (isCreate) {
                Database.insert(rec, AccessLevel.USER_MODE);
            } else {
                Database.update(rec, AccessLevel.USER_MODE);
            }
            return rec.Id;
        } catch (DmlException dml) {
            throw new AuraHandledException(dml.getDmlMessage(0));
        }
    }
}
