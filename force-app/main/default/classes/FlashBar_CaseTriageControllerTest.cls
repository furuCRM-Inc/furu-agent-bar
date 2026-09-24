@isTest
private class FlashBar_CaseTriageControllerTest {

    // ── HTTP mock ────────────────────────────────────────────────────────────

    private class MockTriageCallout implements HttpCalloutMock {
        public HTTPResponse respond(HTTPRequest req) {
            HTTPResponse res = new HTTPResponse();
            res.setStatusCode(200);
            res.setHeader('Content-Type', 'application/json');
            res.setBody(JSON.serialize(new Map<String, Object>{
                'status'     => 'SUCCESS',
                'confidence' => 0.91,
                'score'  => new Map<String, Object>{ 'urgency' => 0.95, 'churnRisk' => 0.82 },
                'choice' => new Map<String, Object>{
                    'recommendedQueueDeveloperName' => 'Test_Triage_Queue',
                    'recommendedQueueLabel'         => 'Test Triage Queue',
                    'reasoning' => '4th contact attempt with financial reimbursement delay on a Gold SLA account.'
                },
                'noul' => new Map<String, Object>{
                    'isImmediateEscalationRequired' => true,
                    'confidence' => 0.94
                }
            }));
            return res;
        }
    }

    private class MockErrorCallout implements HttpCalloutMock {
        public HTTPResponse respond(HTTPRequest req) {
            HTTPResponse res = new HTTPResponse();
            res.setStatusCode(500);
            res.setBody('Internal Server Error');
            return res;
        }
    }

    // ── Test setup ───────────────────────────────────────────────────────────

    @TestSetup
    static void setup() {
        Group q = new Group(
            Name          = 'Test Triage Queue',
            DeveloperName = 'Test_Triage_Queue',
            Type          = 'Queue'
        );
        insert q;

        QueueSObject qs = new QueueSObject(QueueId = q.Id, SObjectType = 'Case');
        insert qs;

        // Use System.runAs to avoid MIXED_DML_OPERATION (setup + non-setup DML)
        System.runAs(new User(Id = UserInfo.getUserId())) {
            Case c = new Case(
                Subject = 'Reimbursement pending for 3 weeks - Urgent',
                Status  = 'New',
                Origin  = 'Web'
            );
            insert c;
        }
    }

    // ── getCaseContext ───────────────────────────────────────────────────────

    @isTest
    static void testGetCaseContext() {
        Case c = [SELECT Id FROM Case LIMIT 1];

        Test.startTest();
        Map<String, Object> ctx = FlashBar_CaseTriageController.getCaseContext(c.Id);
        Test.stopTest();

        System.assertEquals(c.Id, (String) ctx.get('caseId'));
        System.assertEquals('Reimbursement pending for 3 weeks - Urgent', (String) ctx.get('subject'));
        System.assertEquals('Standard', (String) ctx.get('accountSlaTier'), 'No Account linked — should default to Standard');
    }

    // ── scoreTriage ──────────────────────────────────────────────────────────

    @isTest
    static void testScoreTriage_success() {
        Test.setMock(HttpCalloutMock.class, new MockTriageCallout());
        String reqJson = JSON.serialize(new Map<String, Object>{
            'subject'        => 'Reimbursement pending for 3 weeks - Urgent',
            'description'    => 'This is my 4th call. My reimbursement is still pending.',
            'accountSlaTier' => 'Gold'
        });

        Test.startTest();
        FlashBar_CaseTriageController.TriageScoreResult result =
            FlashBar_CaseTriageController.scoreTriage(reqJson);
        Test.stopTest();

        System.assertEquals('SUCCESS', result.status);
        System.assertEquals(0.95, result.urgencyScore, 'urgencyScore mismatch');
        System.assertEquals(0.82, result.churnRisk, 'churnRisk mismatch');
        System.assertEquals(true, result.isImmediateEscalationRequired);
        System.assertEquals('Test_Triage_Queue', result.recommendedQueueDeveloperName);
        System.assert(result.reasoning.contains('4th contact'), 'reasoning should mention 4th contact');
    }

    @isTest
    static void testScoreTriage_httpError() {
        Test.setMock(HttpCalloutMock.class, new MockErrorCallout());
        Test.startTest();
        FlashBar_CaseTriageController.TriageScoreResult result =
            FlashBar_CaseTriageController.scoreTriage('{}');
        Test.stopTest();

        System.assertEquals('HTTP_500', result.status);
    }

    // ── assignCaseToQueue ────────────────────────────────────────────────────

    @isTest
    static void testAssignCaseToQueue_success() {
        Case c = [SELECT Id FROM Case LIMIT 1];

        Test.startTest();
        String resJson = FlashBar_CaseTriageController.assignCaseToQueue(
            JSON.serialize(new Map<String, Object>{
                'caseId'              => c.Id,
                'queueDeveloperName'  => 'Test_Triage_Queue'
            })
        );
        Test.stopTest();

        Map<String, Object> res = (Map<String, Object>) JSON.deserializeUntyped(resJson);
        System.assertEquals('SUCCESS', res.get('status'), resJson);

        Case updated = [SELECT OwnerId FROM Case WHERE Id = :c.Id];
        Group q      = [SELECT Id FROM Group WHERE DeveloperName = 'Test_Triage_Queue'];
        System.assertEquals(q.Id, updated.OwnerId, 'Case OwnerId should be the Queue');
    }

    @isTest
    static void testAssignCaseToQueue_queueNotFound() {
        Case c = [SELECT Id FROM Case LIMIT 1];

        Test.startTest();
        String resJson = FlashBar_CaseTriageController.assignCaseToQueue(
            JSON.serialize(new Map<String, Object>{
                'caseId'             => c.Id,
                'queueDeveloperName' => 'Nonexistent_Queue_XYZ'
            })
        );
        Test.stopTest();

        Map<String, Object> res = (Map<String, Object>) JSON.deserializeUntyped(resJson);
        System.assertEquals('ERROR', res.get('status'));
        System.assertNotEquals(null, res.get('message'));
    }

    @isTest
    static void testAssignCaseToQueue_nullInput() {
        Test.startTest();
        String resJson = FlashBar_CaseTriageController.assignCaseToQueue(
            JSON.serialize(new Map<String, Object>{
                'caseId'             => null,
                'queueDeveloperName' => null
            })
        );
        Test.stopTest();

        Map<String, Object> res = (Map<String, Object>) JSON.deserializeUntyped(resJson);
        System.assertEquals('ERROR', res.get('status'));
    }
}

