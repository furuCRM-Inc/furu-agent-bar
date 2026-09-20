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

    // ── Public result type ────────────────────────────────────────────────────

    public class AgentAction {
        @AuraEnabled public String intent;          // NAVIGATE | UPDATE_RECORD | PREFILL | SEARCH | UNKNOWN
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
    }

    // ── Main entry point ──────────────────────────────────────────────────────

    @AuraEnabled
    public static AgentAction processIntent(
        String userInput,
        String sObjectType,
        String recordId,
        String pageType        // 'record_detail' | 'list_view' | 'home' | 'other'
    ) {
        AgentAction result = new AgentAction();
        try {
            // 1. Get field schema for context
            List<String> fieldLabels = getFieldLabels(sObjectType);

            // 2. Call Cloudflare Worker
            Map<String, Object> workerResponse = callWorker(userInput, sObjectType, recordId, pageType, fieldLabels);

            // 3. Map response to AgentAction
            result = mapToAction(workerResponse, sObjectType, recordId);

            // 4. If SEARCH — run SOSL server-side
            if (result.intent == 'SEARCH') {
                result.searchResults = runSearch(
                    (String) workerResponse.get('search_query'),
                    (String) workerResponse.get('search_sobject'),
                    (List<Object>) workerResponse.get('search_fields')
                );
            }

        } catch (Exception e) {
            result.intent       = 'UNKNOWN';
            result.errorMessage = e.getMessage();
            result.message      = 'Could not process request. Please try again.';
        }
        return result;
    }

    // ── Field schema fetcher ──────────────────────────────────────────────────

    private static List<String> getFieldLabels(String sObjectType) {
        if (String.isBlank(sObjectType)) return new List<String>();
        try {
            Map<String, Schema.SObjectField> fieldMap =
                Schema.getGlobalDescribe().get(sObjectType)?.getDescribe().fields.getMap();
            if (fieldMap == null) return new List<String>();
            List<String> labels = new List<String>();
            for (String apiName : fieldMap.keySet()) {
                Schema.DescribeFieldResult f = fieldMap.get(apiName).getDescribe();
                if (!f.isDeprecatedAndHidden()) {
                    labels.add(f.getLabel() + '=' + apiName);   // e.g. "Stage=StageName"
                }
            }
            return labels;
        } catch (Exception e) {
            return new List<String>();
        }
    }

    // ── Cloudflare Worker call ────────────────────────────────────────────────

    private static Map<String, Object> callWorker(
        String userInput,
        String sObjectType,
        String recordId,
        String pageType,
        List<String> fieldLabels
    ) {
        Map<String, Object> payload = new Map<String, Object>{
            'user_input'   => userInput,
            'sObjectType'  => sObjectType,
            'recordId'     => recordId,
            'pageType'     => pageType,
            'field_schema' => fieldLabels
        };

        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:FuruAgent_Backend/v1/agent-action');
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setTimeout(12000);
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

        // Navigation
        a.targetRecordId = (String) r.get('target_record_id');
        a.targetSObject  = (String) r.get('target_sobject');
        a.targetUrl      = (String) r.get('target_url');

        // If navigate intent but no recordId yet — run SOQL to find it
        if (a.intent == 'NAVIGATE' && String.isBlank(a.targetRecordId) && String.isNotBlank(a.targetSObject)) {
            String searchName = (String) r.get('search_name');
            if (String.isNotBlank(searchName)) {
                a.targetRecordId = findRecordId(a.targetSObject, searchName);
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
        for (List<SObject> group : results) {
            for (SObject rec : group) {
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

    // ── Single record lookup for navigation ───────────────────────────────────

    @TestVisible
    private static String findRecordId(String sObjType, String nameValue) {
        if (String.isBlank(sObjType) || String.isBlank(nameValue)) return null;
        String safe = String.escapeSingleQuotes(nameValue);
        String soql = 'SELECT Id FROM ' + sObjType + ' WHERE Name LIKE \'%' + safe + '%\' LIMIT 1';
        List<SObject> recs = Database.query(soql);
        return recs.isEmpty() ? null : recs[0].Id;
    }
}
