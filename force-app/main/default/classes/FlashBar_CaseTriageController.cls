/**
 * FlashBar_CaseTriageController
 *
 * Data flow:
 *   1. getCaseContext  — read-only, cached: fetch Case fields + Account SLA tier
 *   2. scoreTriage     — Cloudflare Worker callout: JEV Score (urgency, churnRisk) +
 *                        Choice (recommended Queue) + Noul (isImmediateEscalationRequired)
 *   3. assignCaseToQueue — DML: reassign Case.OwnerId to target Queue WITH USER_MODE
 *
 * All SOQL uses WITH USER_MODE (CRUD + FLS). DML uses `update as user` (API 56+).
 */
public with sharing class FlashBar_CaseTriageController {

    // ── Inner types ─────────────────────────────────────────────────────────

    public class TriageRequest {
        @AuraEnabled public String caseId;
        @AuraEnabled public String queueDeveloperName;
    }

    public class TriageScoreResult {
        @AuraEnabled public String  status;
        @AuraEnabled public Decimal confidence;
        @AuraEnabled public Decimal urgencyScore;
        @AuraEnabled public Decimal churnRisk;
        @AuraEnabled public String  recommendedQueueDeveloperName;
        @AuraEnabled public String  recommendedQueueLabel;
        @AuraEnabled public String  reasoning;
        @AuraEnabled public Boolean isImmediateEscalationRequired;
    }

    // ── 1. getCaseContext ────────────────────────────────────────────────────

    @AuraEnabled(cacheable=true)
    public static Map<String, Object> getCaseContext(Id caseId) {
        Case targetCase = [
            SELECT Id, CaseNumber, Subject, Description, Account.SLA__c
            FROM   Case
            WHERE  Id = :caseId
            WITH   USER_MODE
            LIMIT  1
        ];
        return new Map<String, Object>{
            'caseId'         => targetCase.Id,
            'subject'        => targetCase.Subject,
            'description'    => targetCase.Description,
            'accountSlaTier' => targetCase.Account?.SLA__c != null
                                    ? targetCase.Account.SLA__c
                                    : 'Standard'
        };
    }

    // ── 2. scoreTriage (Cloudflare Worker callout) ──────────────────────────

    @AuraEnabled
    public static TriageScoreResult scoreTriage(String requestJson) {
        TriageScoreResult result = new TriageScoreResult();
        result.status = 'ERROR';
        try {
            HttpRequest req = new HttpRequest();
            req.setEndpoint('callout:FuruAgent_Backend/api/jev/triage');
            req.setMethod('POST');
            req.setHeader('Content-Type', 'application/json');
            req.setBody(requestJson);
            req.setTimeout(10000);

            HttpResponse res = new Http().send(req);
            if (res.getStatusCode() != 200) {
                result.status = 'HTTP_' + res.getStatusCode();
                return result;
            }

            Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
            result.status     = (String) body.get('status');
            result.confidence = toDecimal(body.get('confidence'));

            Map<String, Object> scoreMap = body.get('score') != null
                ? (Map<String, Object>) body.get('score') : new Map<String, Object>();
            result.urgencyScore = toDecimal(scoreMap.get('urgency'));
            result.churnRisk    = toDecimal(scoreMap.get('churnRisk'));

            Map<String, Object> choiceMap = body.get('choice') != null
                ? (Map<String, Object>) body.get('choice') : new Map<String, Object>();
            result.recommendedQueueDeveloperName = (String) choiceMap.get('recommendedQueueDeveloperName');
            result.recommendedQueueLabel         = (String) choiceMap.get('recommendedQueueLabel');
            result.reasoning                     = (String) choiceMap.get('reasoning');

            Map<String, Object> noulMap = body.get('noul') != null
                ? (Map<String, Object>) body.get('noul') : new Map<String, Object>();
            result.isImmediateEscalationRequired =
                noulMap.containsKey('isImmediateEscalationRequired')
                    ? (Boolean) noulMap.get('isImmediateEscalationRequired')
                    : false;

        } catch (Exception e) {
            result.status = 'ERROR: ' + e.getMessage();
        }
        return result;
    }

    // ── 3. assignCaseToQueue ─────────────────────────────────────────────────

    @AuraEnabled
    public static String assignCaseToQueue(String requestJson) {
        try {
            TriageRequest req = (TriageRequest) JSON.deserialize(requestJson, TriageRequest.class);

            Group targetQueue = [
                SELECT Id
                FROM   Group
                WHERE  Type = 'Queue' AND DeveloperName = :req.queueDeveloperName
                WITH   USER_MODE
                LIMIT  1
            ];

            Case caseToUpdate = new Case(Id = req.caseId, OwnerId = targetQueue.Id);
            update as user caseToUpdate;

            return JSON.serialize(new Map<String, Object>{
                'status'          => 'SUCCESS',
                'assignedQueueId' => targetQueue.Id
            });
        } catch (Exception e) {
            return JSON.serialize(new Map<String, Object>{
                'status'  => 'ERROR',
                'message' => e.getMessage()
            });
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private static Decimal toDecimal(Object val) {
        if (val == null) return 0;
        try { return Decimal.valueOf(String.valueOf(val)); }
        catch (Exception e) { return 0; }
    }
}
