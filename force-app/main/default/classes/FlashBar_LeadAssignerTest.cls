@isTest
private class FlashBar_LeadAssignerTest {

    // ── HTTP mock ────────────────────────────────────────────────────────────

    private class MockQualifyCallout implements HttpCalloutMock {
        public HTTPResponse respond(HTTPRequest req) {
            List<Object> scores = new List<Object>();
            // Return high scores for all leads so they all pass threshold
            for (Integer i = 0; i < 10; i++) {
                scores.add(new Map<String, Object>{
                    'leadId'    => 'PLACEHOLDER_' + i,
                    'icpScore'  => 0.80,
                    'tier'      => 'HOT',
                    'reasoning' => 'Strong ICP fit — enterprise company, decision-maker title'
                });
            }
            HTTPResponse res = new HTTPResponse();
            res.setStatusCode(200);
            res.setHeader('Content-Type', 'application/json');
            res.setBody(JSON.serialize(new Map<String, Object>{
                'status' => 'SUCCESS',
                'scores' => scores
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

    private class MockThrowingCallout implements HttpCalloutMock {
        public HTTPResponse respond(HTTPRequest req) {
            throw new CalloutException('Simulated callout timeout');
        }
    }

    // Echoes back the leadIds from the request body with alternating high/low
    // ICP scores, so threshold-filtering behavior can be asserted deterministically.
    private class MockQualifyCalloutEcho implements HttpCalloutMock {
        public HTTPResponse respond(HTTPRequest req) {
            Map<String, Object> body  = (Map<String, Object>) JSON.deserializeUntyped(req.getBody());
            List<Object> reqLeads     = (List<Object>) body.get('leads');
            List<Object> scores       = new List<Object>();
            Integer idx = 0;
            for (Object o : reqLeads) {
                Map<String, Object> l = (Map<String, Object>) o;
                Boolean isHigh = Math.mod(idx, 2) == 0;
                scores.add(new Map<String, Object>{
                    'leadId'    => l.get('leadId'),
                    'icpScore'  => isHigh ? 0.9 : 0.1,
                    'tier'      => isHigh ? 'HOT' : 'COLD',
                    'reasoning' => 'echo scored lead'
                });
                idx++;
            }
            HTTPResponse res = new HTTPResponse();
            res.setStatusCode(200);
            res.setHeader('Content-Type', 'application/json');
            res.setBody(JSON.serialize(new Map<String, Object>{
                'status' => 'SUCCESS',
                'scores' => scores
            }));
            return res;
        }
    }

    private class MockQualifyCalloutBadScore implements HttpCalloutMock {
        public HTTPResponse respond(HTTPRequest req) {
            List<Object> scores = new List<Object>{
                new Map<String, Object>{
                    'leadId'    => 'PLACEHOLDER_0',
                    'icpScore'  => 'not-a-number',
                    'tier'      => 'COLD',
                    'reasoning' => 'malformed score from worker'
                }
            };
            HTTPResponse res = new HTTPResponse();
            res.setStatusCode(200);
            res.setHeader('Content-Type', 'application/json');
            res.setBody(JSON.serialize(new Map<String, Object>{
                'status' => 'SUCCESS',
                'scores' => scores
            }));
            return res;
        }
    }

    // ── Test setup ───────────────────────────────────────────────────────────

    @TestSetup
    static void setup() {
        // Create 10 test leads
        List<Lead> leads = new List<Lead>();
        for (Integer i = 1; i <= 10; i++) {
            leads.add(new Lead(
                FirstName        = 'Test',
                LastName         = 'Lead ' + i,
                Company          = 'Acme Corp ' + i,
                Title            = 'VP of Sales',
                Email            = 'lead' + i + '@acme.test',
                AnnualRevenue    = 15000000,
                NumberOfEmployees = 200,
                Industry         = 'Technology',
                LeadSource       = 'Web'
            ));
        }
        insert leads;

        // Create 3 test users for round-robin — use current user's profile to avoid name-lookup failures
        Id profileId = UserInfo.getProfileId();
        List<User> users = new List<User>();
        for (Integer i = 1; i <= 3; i++) {
            users.add(new User(
                FirstName          = 'Rep',
                LastName           = 'User' + i,
                Email              = 'repuser' + i + '@furucrm.test',
                Username           = 'repuser' + i + '@furucrm.test.roundrobin',
                Alias              = 'rep' + i,
                ProfileId          = profileId,
                TimeZoneSidKey     = 'America/Los_Angeles',
                LocaleSidKey       = 'en_US',
                EmailEncodingKey   = 'UTF-8',
                LanguageLocaleKey  = 'en_US'
            ));
        }
        insert users;
    }

    // ── qualifyLeads ─────────────────────────────────────────────────────────

    @isTest
    static void testQualifyLeads_success() {
        Test.setMock(HttpCalloutMock.class, new MockQualifyCallout());

        List<Lead> leads = [SELECT Id FROM Lead LIMIT 3];
        List<Map<String, Object>> leadPayload = new List<Map<String, Object>>();
        for (Lead l : leads) {
            leadPayload.add(new Map<String, Object>{
                'leadId'  => l.Id,
                'title'   => 'VP of Sales',
                'company' => 'Acme Corp'
            });
        }
        String reqJson = JSON.serialize(new Map<String, Object>{ 'leads' => leadPayload });

        Test.startTest();
        FlashBar_LeadAssigner.QualifyResult result = FlashBar_LeadAssigner.qualifyLeads(reqJson);
        Test.stopTest();

        System.assertEquals('SUCCESS', result.status, 'status should be SUCCESS');
        System.assertNotEquals(null, result.scores, 'scores should not be null');
        System.assertNotEquals(0, result.scores.size(), 'should have at least one score');
    }

    @isTest
    static void testQualifyLeads_httpError() {
        Test.setMock(HttpCalloutMock.class, new MockErrorCallout());

        Test.startTest();
        FlashBar_LeadAssigner.QualifyResult result = FlashBar_LeadAssigner.qualifyLeads('{"leads":[]}');
        Test.stopTest();

        System.assertEquals('HTTP_500', result.status);
    }

    @isTest
    static void testQualifyLeads_calloutException_caught() {
        Test.setMock(HttpCalloutMock.class, new MockThrowingCallout());

        Test.startTest();
        FlashBar_LeadAssigner.QualifyResult result = FlashBar_LeadAssigner.qualifyLeads('{"leads":[]}');
        Test.stopTest();

        System.assert(result.status.startsWith('ERROR'), 'status should capture the exception: ' + result.status);
    }

    @isTest
    static void testQualifyLeads_malformedScore_defaultsToZero() {
        Test.setMock(HttpCalloutMock.class, new MockQualifyCalloutBadScore());

        Test.startTest();
        FlashBar_LeadAssigner.QualifyResult result = FlashBar_LeadAssigner.qualifyLeads('{"leads":[]}');
        Test.stopTest();

        System.assertEquals('SUCCESS', result.status);
        System.assertEquals(1, result.scores.size());
        System.assertEquals(0, result.scores[0].icpScore, 'malformed score should default to 0 via toDecimal catch');
    }

    // ── assignLeadsRoundRobin ────────────────────────────────────────────────

    @isTest
    static void testAssignLeads_roundRobin_evenDistribution() {
        List<Lead>  leads = [SELECT Id FROM Lead ORDER BY LastName];
        List<User>  users = [SELECT Id FROM User WHERE Username LIKE '%@furucrm.test.roundrobin' ORDER BY LastName];

        List<String> leadIds = new List<String>();
        for (Lead l : leads) leadIds.add(l.Id);

        List<String> userIds = new List<String>();
        for (User u : users) userIds.add(u.Id);

        String reqJson = JSON.serialize(new Map<String, Object>{
            'leadIds'         => leadIds,
            'assignedUserIds' => userIds,
            'minIcpScore'     => 0.0
        });

        Test.startTest();
        String resJson = FlashBar_LeadAssigner.assignLeadsRoundRobin(reqJson);
        Test.stopTest();

        Map<String, Object> res = (Map<String, Object>) JSON.deserializeUntyped(resJson);
        System.assertEquals('SUCCESS', res.get('status'), resJson);

        Integer assigned = (Integer) res.get('assignedCount');
        System.assertEquals(10, assigned, '10 leads should be assigned');

        // Verify round-robin distribution: 3 users, 10 leads → (4, 3, 3)
        Map<Id, Integer> distribution = new Map<Id, Integer>();
        for (Lead l : [SELECT OwnerId FROM Lead WHERE Id IN :leadIds]) {
            distribution.put(l.OwnerId, (distribution.get(l.OwnerId) ?? 0) + 1);
        }
        System.assertEquals(3, distribution.size(), 'all 3 reps should receive leads');

        // Max count should be 4, min 3
        Integer maxCount = 0;
        Integer minCount = 999;
        for (Integer count : distribution.values()) {
            if (count > maxCount) maxCount = count;
            if (count < minCount) minCount = count;
        }
        System.assertEquals(4, maxCount, 'busiest rep should have 4 leads');
        System.assertEquals(3, minCount, 'least-loaded rep should have 3 leads');
    }

    @isTest
    static void testAssignLeads_nullLeadIds() {
        Test.startTest();
        String resJson = FlashBar_LeadAssigner.assignLeadsRoundRobin(
            JSON.serialize(new Map<String, Object>{
                'leadIds'         => null,
                'assignedUserIds' => new List<String>{ UserInfo.getUserId() }
            })
        );
        Test.stopTest();

        Map<String, Object> res = (Map<String, Object>) JSON.deserializeUntyped(resJson);
        System.assertEquals('ERROR', res.get('status'));
    }

    @isTest
    static void testAssignLeads_nullUserIds() {
        List<Lead> leads = [SELECT Id FROM Lead LIMIT 1];
        Test.startTest();
        String resJson = FlashBar_LeadAssigner.assignLeadsRoundRobin(
            JSON.serialize(new Map<String, Object>{
                'leadIds'         => new List<String>{ leads[0].Id },
                'assignedUserIds' => null
            })
        );
        Test.stopTest();

        Map<String, Object> res = (Map<String, Object>) JSON.deserializeUntyped(resJson);
        System.assertEquals('ERROR', res.get('status'));
    }

    @isTest
    static void testAssignLeads_singleUser_allToOne() {
        List<Lead> leads = [SELECT Id FROM Lead LIMIT 5];
        List<User> users = [SELECT Id FROM User WHERE Username LIKE '%@furucrm.test.roundrobin' LIMIT 1];

        List<String> leadIds = new List<String>();
        for (Lead l : leads) leadIds.add(l.Id);

        Test.startTest();
        String resJson = FlashBar_LeadAssigner.assignLeadsRoundRobin(
            JSON.serialize(new Map<String, Object>{
                'leadIds'         => leadIds,
                'assignedUserIds' => new List<String>{ users[0].Id },
                'minIcpScore'     => 0.0
            })
        );
        Test.stopTest();

        Map<String, Object> res = (Map<String, Object>) JSON.deserializeUntyped(resJson);
        System.assertEquals('SUCCESS', res.get('status'));

        List<Lead> updated = [SELECT OwnerId FROM Lead WHERE Id IN :leadIds];
        for (Lead l : updated) {
            System.assertEquals(users[0].Id, l.OwnerId, 'all leads should go to single rep');
        }
    }

    @isTest
    static void testAssignLeads_withMinScoreThreshold_filtersLowScoreLeads() {
        Test.setMock(HttpCalloutMock.class, new MockQualifyCalloutEcho());

        List<Lead> leads = [SELECT Id FROM Lead ORDER BY LastName LIMIT 4];
        List<User> users = [SELECT Id FROM User WHERE Username LIKE '%@furucrm.test.roundrobin' LIMIT 1];

        List<String> leadIds = new List<String>();
        for (Lead l : leads) leadIds.add(l.Id);

        Test.startTest();
        String resJson = FlashBar_LeadAssigner.assignLeadsRoundRobin(
            JSON.serialize(new Map<String, Object>{
                'leadIds'         => leadIds,
                'assignedUserIds' => new List<String>{ users[0].Id },
                'minIcpScore'     => 0.5
            })
        );
        Test.stopTest();

        Map<String, Object> res = (Map<String, Object>) JSON.deserializeUntyped(resJson);
        System.assertEquals('SUCCESS', res.get('status'), resJson);
        System.assertEquals(2, (Integer) res.get('assignedCount'), 'only the two 0.9-score leads should pass the 0.5 threshold');
        System.assertEquals(2, (Integer) res.get('skippedCount'), 'the two 0.1-score leads should be skipped');
    }

    @isTest
    static void testAssignLeads_invalidLeadId_returnsError() {
        List<User> users = [SELECT Id FROM User WHERE Username LIKE '%@furucrm.test.roundrobin' LIMIT 1];

        Test.startTest();
        String resJson = FlashBar_LeadAssigner.assignLeadsRoundRobin(
            JSON.serialize(new Map<String, Object>{
                'leadIds'         => new List<String>{ 'NOT_A_VALID_ID' },
                'assignedUserIds' => new List<String>{ users[0].Id },
                'minIcpScore'     => 0.0
            })
        );
        Test.stopTest();

        Map<String, Object> res = (Map<String, Object>) JSON.deserializeUntyped(resJson);
        System.assertEquals('ERROR', res.get('status'));
        System.assertNotEquals(null, res.get('message'));
    }
}

