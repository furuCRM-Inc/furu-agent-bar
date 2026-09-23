public with sharing class FlashBarMassEditService {

    public class EditResult {
        @AuraEnabled public List<String> successIds = new List<String>();
        @AuraEnabled public List<RowError> errors   = new List<RowError>();
    }

    public class RowError {
        @AuraEnabled public String recordId;
        @AuraEnabled public String errorMessage;
    }

    public class ColumnMeta {
        @AuraEnabled public String  apiName;
        @AuraEnabled public String  label;
        @AuraEnabled public String  fieldType;
        @AuraEnabled public Boolean isEditable;
        @AuraEnabled public List<PicklistOpt> picklistOptions;
    }

    public class PicklistOpt {
        @AuraEnabled public String label;
        @AuraEnabled public String value;
    }

    /**
     * Returns field metadata (type, editability, picklist options) for the given fields.
     * Called once when the mass editor opens.
     */
    @AuraEnabled(cacheable=true)
    public static List<ColumnMeta> getEditSchema(String sObjectType, String fieldsJson) {
        List<String> fields = (List<String>) JSON.deserialize(fieldsJson, List<String>.class);
        Schema.SObjectType token = Schema.getGlobalDescribe().get(sObjectType);
        if (token == null) return new List<ColumnMeta>();

        Map<String, Schema.SObjectField> fieldMap = token.getDescribe().fields.getMap();
        List<ColumnMeta> result = new List<ColumnMeta>();
        for (String apiName : fields) {
            Schema.SObjectField sf = fieldMap.get(apiName);
            if (sf == null) continue;
            Schema.DescribeFieldResult fr = sf.getDescribe();
            if (!fr.isAccessible()) continue;
            ColumnMeta m = new ColumnMeta();
            m.apiName          = apiName;
            m.label            = fr.getLabel();
            m.fieldType        = String.valueOf(fr.getType());
            m.isEditable       = fr.isUpdateable();
            m.picklistOptions  = new List<PicklistOpt>();
            if (m.fieldType == 'PICKLIST' || m.fieldType == 'MULTIPICKLIST') {
                for (Schema.PicklistEntry pe : fr.getPicklistValues()) {
                    if (!pe.isActive()) continue;
                    PicklistOpt opt = new PicklistOpt();
                    opt.label = pe.getLabel();
                    opt.value = pe.getValue();
                    m.picklistOptions.add(opt);
                }
            }
            result.add(m);
        }
        return result;
    }

    /**
     * Bulk-updates records with partial failure support (allOrNone=false).
     * recordsJson: JSON array of objects, each containing 'Id' + changed fields only.
     */
    @AuraEnabled
    public static EditResult updateMassiveRecords(String sObjectType, String recordsJson) {
        EditResult result = new EditResult();
        if (String.isBlank(sObjectType) || String.isBlank(recordsJson)) return result;

        Schema.SObjectType token = Schema.getGlobalDescribe().get(sObjectType);
        if (token == null) throw new AuraHandledException('Unknown sObject: ' + sObjectType);

        Map<String, Schema.SObjectField> fieldMap = token.getDescribe().fields.getMap();
        List<Object> rawList = (List<Object>) JSON.deserializeUntyped(recordsJson);

        List<SObject> records = new List<SObject>();
        for (Object rawObj : rawList) {
            Map<String, Object> raw = (Map<String, Object>) rawObj;
            SObject rec = token.newSObject();
            for (String fieldName : raw.keySet()) {
                Object val = raw.get(fieldName);
                if (fieldName == 'Id') { rec.Id = (String) val; continue; }
                Schema.SObjectField sf = fieldMap.get(fieldName);
                if (sf == null) continue;
                Schema.DescribeFieldResult fr = sf.getDescribe();
                if (!fr.isUpdateable()) continue;
                if (val == null) { rec.put(fieldName, null); continue; }
                String typeStr = String.valueOf(fr.getType());
                if      (typeStr == 'BOOLEAN')                                                   rec.put(fieldName, Boolean.valueOf(String.valueOf(val)));
                else if (typeStr == 'CURRENCY' || typeStr == 'DOUBLE' || typeStr == 'PERCENT')   rec.put(fieldName, Decimal.valueOf(String.valueOf(val)));
                else if (typeStr == 'INTEGER')                                                    rec.put(fieldName, Integer.valueOf(String.valueOf(val)));
                else if (typeStr == 'DATE')                                                       rec.put(fieldName, Date.valueOf(String.valueOf(val)));
                else if (typeStr == 'DATETIME')                                                   rec.put(fieldName, Datetime.valueOf(String.valueOf(val)));
                else                                                                              rec.put(fieldName, String.valueOf(val));
            }
            records.add(rec);
        }

        // Strip any fields the running user cannot update (FLS enforcement)
        SObjectAccessDecision decision = Security.stripInaccessible(AccessType.UPDATABLE, records);
        records = decision.getRecords();
        Database.SaveResult[] saveResults = Database.update(records, false);
        for (Integer i = 0; i < saveResults.size(); i++) {
            Database.SaveResult sr = saveResults[i];
            if (sr.isSuccess()) {
                result.successIds.add(sr.getId());
            } else {
                RowError err = new RowError();
                err.recordId = records[i].Id;
                List<String> msgs = new List<String>();
                for (Database.Error de : sr.getErrors()) msgs.add(de.getMessage());
                err.errorMessage = String.join(msgs, '; ');
                result.errors.add(err);
            }
        }
        return result;
    }
}
