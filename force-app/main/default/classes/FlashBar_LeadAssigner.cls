/**
 * FlashBar_LeadAssigner
 *
 * Data flow:
 *   1. qualifyLeads     — Cloudflare Worker callout: ICP score + tier (HOT/WARM/COLD) per lead
 *   2. assignLeadsRoundRobin — DML: distribute qualified leads evenly across assigned reps WITH USER_MODE
 *
 * Round-robin formula: rep = assignedUserIds[leadIndex % assignedUserIds.size()]
 * Only leads with icpScore >= minScore threshold are assigned (default 0.0 = all leads).
 */
public with sharing class FlashBar_LeadAssigner {

    // ── Inner types ─────────────────────────────────────────────────────────

    public class AssignRequest {
        @AuraEnabled public List<String> leadIds;
        @AuraEnabled public List<String> assignedUserIds;
        @AuraEnabled public Decimal      minIcpScore;   // 0.0 = assign all
    }

    public class LeadScore {
        @AuraEnabled public String  leadId;
        @AuraEnabled public Decimal icpScore;
        @AuraEnabled public String  tier;       // HOT | WARM | COLD
        @AuraEnabled public String  reasoning;
    }

    public class QualifyResult {
        @AuraEnabled public String          status;
        @AuraEnabled public List<LeadScore> scores;
    }

    public class AssignResult {
        @AuraEnabled public String  status;
        @AuraEnabled public Integer totalLeads;
        @AuraEnabled public Integer assignedCount;
        @AuraEnabled public Integer skippedCount;
        @AuraEnabled public String  message;
    }

    // ── 1. qualifyLeads (Cloudflare Worker callout) ─────────────────────────

    @AuraEnabled
    public static QualifyResult qualifyLeads(String requestJson) {
        QualifyResult result = new QualifyResult();
        result.status = 'ERROR';
        result.scores = new List<LeadScore>();
        try {
            HttpRequest req = new HttpRequest();
            req.setEndpoint('callout:FuruAgent_Backend/api/jev/qualify-batch');
            req.setMethod('POST');
            req.setHeader('Content-Type', 'application/json');
            req.setBody(requestJson);
            // Scores a whole batch of leads (up to 20 in the UI) in one LLM call, unlike
            // the single-record Case Triage callout — 15s was routinely too short and
            // surfaced as "ERROR: Read timed out". Callout wait time doesn't consume Apex
            // CPU governor limits, so this is safe to raise well above that.
            req.setTimeout(60000);

            HttpResponse res = new Http().send(req);
            if (res.getStatusCode() != 200) {
                result.status = 'HTTP_' + res.getStatusCode();
                return result;
            }

            Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
            result.status = (String) body.get('status');

            List<Object> rawScores = (List<Object>) body.get('scores');
            if (rawScores != null) {
                for (Object s : rawScores) {
                    Map<String, Object> m = (Map<String, Object>) s;
                    LeadScore ls = new LeadScore();
                    ls.leadId    = (String)  m.get('leadId');
                    ls.icpScore  = toDecimal(m.get('icpScore'));
                    ls.tier      = (String)  m.get('tier');
                    ls.reasoning = (String)  m.get('reasoning');
                    result.scores.add(ls);
                }
            }
        } catch (Exception e) {
            result.status = 'ERROR: ' + e.getMessage();
        }
        return result;
    }

    // ── 2. assignLeadsRoundRobin ─────────────────────────────────────────────

    @AuraEnabled
    public static String assignLeadsRoundRobin(String requestJson) {
        try {
            AssignRequest req = (AssignRequest) JSON.deserialize(requestJson, AssignRequest.class);

            if (req.leadIds == null || req.leadIds.isEmpty()) {
                return errorJson('leadIds is required');
            }
            if (req.assignedUserIds == null || req.assignedUserIds.isEmpty()) {
                return errorJson('assignedUserIds is required');
            }

            Decimal threshold = req.minIcpScore != null ? req.minIcpScore : 0;
            Integer repCount  = req.assignedUserIds.size();

            // Build ICP score map from qualifyLeads callout
            Map<String, Decimal> scoreMap = new Map<String, Decimal>();
            if (threshold > 0) {
                String qualifyPayload = JSON.serialize(new Map<String, Object>{
                    'leads' => buildLeadPayload(req.leadIds)
                });
                QualifyResult qr = qualifyLeads(qualifyPayload);
                for (LeadScore ls : qr.scores) {
                    scoreMap.put(ls.leadId, ls.icpScore);
                }
            }

            List<Lead> toUpdate = new List<Lead>();
            Integer repIndex    = 0;
            Integer skipped     = 0;

            for (String leadId : req.leadIds) {
                Decimal score = scoreMap.containsKey(leadId) ? scoreMap.get(leadId) : 1;
                if (score < threshold) { skipped++; continue; }
                String ownerId = req.assignedUserIds[Math.mod(repIndex, repCount)];
                toUpdate.add(new Lead(Id = leadId, OwnerId = ownerId));
                repIndex++;
            }

            if (!toUpdate.isEmpty()) {
                update as user toUpdate;
            }

            return JSON.serialize(new Map<String, Object>{
                'status'        => 'SUCCESS',
                'totalLeads'    => req.leadIds.size(),
                'assignedCount' => toUpdate.size(),
                'skippedCount'  => skipped
            });
        } catch (Exception e) {
            return JSON.serialize(new Map<String, Object>{
                'status'  => 'ERROR',
                'message' => e.getMessage()
            });
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private static List<Map<String, Object>> buildLeadPayload(List<String> leadIds) {
        List<Lead> leads = [
            SELECT Id, FirstName, LastName, Company, Title, Email,
                   AnnualRevenue, NumberOfEmployees, Industry, LeadSource
            FROM   Lead
            WHERE  Id IN :leadIds
            WITH   USER_MODE
        ];
        List<Map<String, Object>> result = new List<Map<String, Object>>();
        for (Lead l : leads) {
            result.add(new Map<String, Object>{
                'leadId'              => l.Id,
                'firstName'           => l.FirstName,
                'lastName'            => l.LastName,
                'company'             => l.Company,
                'title'               => l.Title,
                'email'               => l.Email,
                'annualRevenue'       => l.AnnualRevenue,
                'numberOfEmployees'   => l.NumberOfEmployees,
                'industry'            => l.Industry,
                'leadSource'          => l.LeadSource
            });
        }
        return result;
    }

    private static String errorJson(String msg) {
        return JSON.serialize(new Map<String, Object>{ 'status' => 'ERROR', 'message' => msg });
    }

    private static Decimal toDecimal(Object val) {
        if (val == null) return 0;
        try { return Decimal.valueOf(String.valueOf(val)); }
        catch (Exception e) { return 0; }
    }
}
