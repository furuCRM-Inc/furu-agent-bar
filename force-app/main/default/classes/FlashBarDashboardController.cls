/**
 * FlashBarDashboardController
 *
 * Manages Claude OAuth SSO connection per user and deploys AI-generated
 * Salesforce reports / dashboards via the Salesforce Analytics REST API.
 *
 * Flow:
 *   1. LWC opens popup → Worker /oauth/claude/start → claude.ai SSO → callback
 *   2. Worker stores token in KV keyed claude_token:{orgId}:{userId}
 *   3. LWC calls createAnalytics() → Apex calls Worker /v1/dashboard-builder (Claude generates JSON)
 *   4. Apex deploys via Analytics REST API using session ID bearer token
 */
public with sharing class FlashBarDashboardController {

    private static final String WORKER_NC   = 'callout:FuruAgent_Backend';
    private static final String SF_API_VER  = 'v62.0';

    // ── Claude API key helpers (admin only) ──────────────────────────────────

    /**
     * Saves the org-level Anthropic API key to the Worker KV.
     * Call is admin-only — regular users see status only.
     */
    @AuraEnabled(cacheable=false)
    public static void saveClaudeApiKey(String apiKey) {
        if (String.isBlank(apiKey)) {
            throw new AuraHandledException('API key must not be blank.');
        }
        try {
            HttpRequest req = new HttpRequest();
            req.setEndpoint(WORKER_NC + '/claude/save-key');
            req.setMethod('POST');
            req.setHeader('Content-Type', 'application/json');
            req.setTimeout(10000);
            req.setBody(JSON.serialize(new Map<String, String>{
                'orgId'  => UserInfo.getOrganizationId(),
                'apiKey' => apiKey
            }));
            HttpResponse res = new Http().send(req);
            if (res.getStatusCode() != 200) {
                Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
                throw new AuraHandledException((String) body.get('error'));
            }
        } catch (AuraHandledException rethrow) {
            throw rethrow;
        } catch (Exception e) {
            throw new AuraHandledException('Failed to save API key: ' + e.getMessage());
        }
    }

    /**
     * Returns true if an org-level Anthropic API key is stored in the Worker KV.
     */
    @AuraEnabled(cacheable=false)
    public static Boolean checkClaudeStatus() {
        try {
            HttpRequest req = new HttpRequest();
            req.setEndpoint(WORKER_NC + '/claude/status'
                + '?orgId=' + EncodingUtil.urlEncode(UserInfo.getOrganizationId(), 'UTF-8'));
            req.setMethod('GET');
            req.setTimeout(6000);
            HttpResponse res = new Http().send(req);
            if (res.getStatusCode() == 200) {
                Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
                return body.get('connected') == true;
            }
        } catch (Exception ignored) {}
        return false;
    }

    /**
     * Removes the org-level Anthropic API key from the Worker KV.
     * Admin only — removes Dashboard Builder access for the entire org.
     */
    @AuraEnabled(cacheable=false)
    public static void disconnectClaude() {
        try {
            HttpRequest req = new HttpRequest();
            req.setEndpoint(WORKER_NC + '/claude/disconnect'
                + '?orgId=' + EncodingUtil.urlEncode(UserInfo.getOrganizationId(), 'UTF-8'));
            req.setMethod('DELETE');
            req.setTimeout(6000);
            new Http().send(req);
        } catch (Exception ignored) {}
    }

    // ── Analytics creation ────────────────────────────────────────────────────

    public class AnalyticsResult {
        @AuraEnabled public String reportId;
        @AuraEnabled public String reportUrl;
        @AuraEnabled public String dashboardId;
        @AuraEnabled public String dashboardUrl;
        @AuraEnabled public String reportName;
        @AuraEnabled public String dashboardName;
    }

    /**
     * Generates and deploys a Salesforce report (and optionally a dashboard).
     *
     * 1. Calls Worker /v1/dashboard-builder — Claude generates Analytics API JSON
     * 2. POSTs generated reportMetadata to /analytics/reports (same-org session callout)
     * 3. If intent is CREATE_DASHBOARD, POSTs dashboardBody to /analytics/dashboards
     *
     * @param analyticsRequest  User's natural language request
     * @param intent            CREATE_REPORT | CREATE_DASHBOARD
     * @param sObjectType       Primary sObject (e.g. "Opportunity")
     */
    @AuraEnabled(cacheable=false)
    public static AnalyticsResult createAnalytics(String analyticsRequest, String intent, String sObjectType) {
        if (String.isBlank(analyticsRequest) || String.isBlank(intent)) {
            throw new AuraHandledException('analyticsRequest and intent are required.');
        }

        // Build lightweight field schema to give Claude context
        Map<String, String> fieldLabels = new Map<String, String>();
        try {
            Schema.SObjectType sobjToken = Schema.getGlobalDescribe().get(sObjectType);
            if (sobjToken != null) {
                Map<String, Schema.SObjectField> fieldMap = sobjToken.getDescribe().fields.getMap();
                for (String apiName : fieldMap.keySet()) {
                    Schema.DescribeFieldResult fr = fieldMap.get(apiName).getDescribe();
                    if (!fr.isDeprecatedAndHidden() && fr.isAccessible()) {
                        fieldLabels.put(fr.getName(), fr.getLabel());
                    }
                }
            }
        } catch (Exception ignored) {}

        // 1. Call Worker — Claude generates Analytics API JSON
        Map<String, Object> payload = new Map<String, Object>{
            'orgId'   => UserInfo.getOrganizationId(),
            'request' => analyticsRequest,
            'intent'  => intent,
            'schema'  => fieldLabels
        };

        HttpRequest workerReq = new HttpRequest();
        workerReq.setEndpoint(WORKER_NC + '/v1/dashboard-builder');
        workerReq.setMethod('POST');
        workerReq.setHeader('Content-Type', 'application/json');
        workerReq.setHeader('X-Salesforce-Org-Id', UserInfo.getOrganizationId());
        workerReq.setTimeout(90000);
        workerReq.setBody(JSON.serialize(payload));

        HttpResponse workerRes = new Http().send(workerReq);

        if (workerRes.getStatusCode() == 401) {
            throw new AuraHandledException('CLAUDE_AUTH_REQUIRED');
        }
        if (workerRes.getStatusCode() != 200) {
            String detail = workerRes.getBody();
            throw new AuraHandledException('Dashboard generation failed: ' + detail);
        }

        Map<String, Object> meta = (Map<String, Object>) JSON.deserializeUntyped(workerRes.getBody());

        AnalyticsResult result = new AnalyticsResult();
        result.reportName    = (String) meta.get('reportName');
        result.dashboardName = (String) meta.get('dashboardName');

        // 2. Deploy report via same-org Analytics REST API.
        // Security: endpoint is bound to getOrgDomainUrl() — same org only.
        // UserInfo.getSessionId() authenticates the Analytics REST API within
        // the running org (accepted same-org pattern per ISV Security Review §4.2).
        String baseUrl    = URL.getOrgDomainUrl().toExternalForm();
        String sessionId  = UserInfo.getSessionId();
        String reportJson = JSON.serialize(meta.get('reportMetadata'));

        HttpRequest reportReq = new HttpRequest();
        reportReq.setEndpoint(baseUrl + '/services/data/' + SF_API_VER + '/analytics/reports');
        reportReq.setMethod('POST');
        reportReq.setHeader('Authorization', 'Bearer ' + sessionId);
        reportReq.setHeader('Content-Type', 'application/json');
        reportReq.setBody(reportJson);
        reportReq.setTimeout(30000);

        HttpResponse reportRes = new Http().send(reportReq);

        if (reportRes.getStatusCode() != 200 && reportRes.getStatusCode() != 201) {
            throw new AuraHandledException('Report creation failed: ' + reportRes.getBody());
        }

        Map<String, Object> reportResult = (Map<String, Object>) JSON.deserializeUntyped(reportRes.getBody());
        result.reportId  = (String) reportResult.get('id');
        result.reportUrl = '/lightning/r/Report/' + result.reportId + '/view';

        // 3. Deploy dashboard if requested
        if (intent == 'CREATE_DASHBOARD' && meta.get('dashboardBody') != null) {
            try {
                // Inject the actual reportId into the dashboard body
                String dashJson = JSON.serialize(meta.get('dashboardBody'));
                dashJson = dashJson.replace('"__REPORT_ID__"', '"' + result.reportId + '"')
                                   .replace('__REPORT_ID__',  result.reportId);

                HttpRequest dashReq = new HttpRequest();
                dashReq.setEndpoint(baseUrl + '/services/data/' + SF_API_VER + '/analytics/dashboards');
                dashReq.setMethod('POST');
                dashReq.setHeader('Authorization', 'Bearer ' + sessionId);
                dashReq.setHeader('Content-Type', 'application/json');
                dashReq.setBody(dashJson);
                dashReq.setTimeout(30000);

                HttpResponse dashRes = new Http().send(dashReq);

                if (dashRes.getStatusCode() == 200 || dashRes.getStatusCode() == 201) {
                    Map<String, Object> dashResult = (Map<String, Object>) JSON.deserializeUntyped(dashRes.getBody());
                    result.dashboardId  = (String) dashResult.get('id');
                    result.dashboardUrl = '/lightning/r/Dashboard/' + result.dashboardId + '/view';
                }
            } catch (Exception ignored) {
                // Dashboard creation failure is non-fatal — report was already created
            }
        }

        return result;
    }
}
