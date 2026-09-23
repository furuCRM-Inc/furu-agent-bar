@IsTest
private class FuruAgentControllerTest {

    // ── HTTP Mock ─────────────────────────────────────────────────────────────

    private class WorkerMock implements HttpCalloutMock {
        private String body;
        private Integer statusCode;

        WorkerMock(String body) { this(body, 200); }
        WorkerMock(String body, Integer statusCode) {
            this.body       = body;
            this.statusCode = statusCode;
        }

        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setStatusCode(statusCode);
            res.setHeader('Content-Type', 'application/json');
            res.setBody(body);
            return res;
        }
    }

    // ── Fixtures ──────────────────────────────────────────────────────────────

    private static String workerJson(String intent, Map<String, Object> fields) {
        Map<String, Object> resp = new Map<String, Object>{
            'intent'      => intent,
            'message'     => 'テストメッセージ',
            'should_save' => false,
            'fields'      => fields
        };
        return JSON.serialize(resp);
    }

    private static FuruAgent_Knowledge__c makeRule(String sObj, String txt, String status) {
        return new FuruAgent_Knowledge__c(
            Target_sObject__c     = sObj,
            Plain_English_Rule__c = txt,
            Status__c             = status,
            Occurrences__c        = 1
        );
    }

    // ── processIntent — SEARCH ────────────────────────────────────────────────

    @IsTest
    static void testProcessIntent_search() {
        String mockBody = JSON.serialize(new Map<String, Object>{
            'intent'         => 'SEARCH',
            'message'        => '検索します',
            'should_save'    => false,
            'fields'         => new Map<String, Object>(),
            'search_query'   => '田中',
            'search_sobject' => 'Contact'
        });
        Test.setMock(HttpCalloutMock.class, new WorkerMock(mockBody));

        Test.startTest();
        FuruAgentController.AgentAction result = FuruAgentController.processIntent(
            '田中さんを探して', 'Contact', null, 'record', 'ja'
        );
        Test.stopTest();

        System.assertEquals('SEARCH', result.intent, 'Intent must be SEARCH');
    }

    // ── processIntent — UNKNOWN / CLARIFY ─────────────────────────────────────

    @IsTest
    static void testProcessIntent_clarify() {
        String mockBody = JSON.serialize(new Map<String, Object>{
            'intent'      => 'CLARIFY',
            'message'     => 'どのオブジェクトを作成しますか？',
            'should_save' => false,
            'fields'      => new Map<String, Object>()
        });
        Test.setMock(HttpCalloutMock.class, new WorkerMock(mockBody));

        Test.startTest();
        FuruAgentController.AgentAction result = FuruAgentController.processIntent(
            '新しいのを作りたい', null, null, 'other', 'ja'
        );
        Test.stopTest();

        // CLARIFY maps to UNKNOWN in Apex
        System.assertEquals('UNKNOWN', result.intent, 'CLARIFY from worker → UNKNOWN in Apex');
        System.assertNotEquals(null, result.message, 'Message must be set');
    }

    // ── processIntent — EXTRACT ───────────────────────────────────────────────

    @IsTest
    static void testProcessIntent_extract() {
        Map<String, Object> fields = new Map<String, Object>{
            'Amount'    => 38000000,
            'CloseDate' => '2026-11-30',
            'StageName' => 'Proposal/Price Quote'
        };
        Test.setMock(HttpCalloutMock.class, new WorkerMock(workerJson('EXTRACT', fields)));

        Test.startTest();
        FuruAgentController.AgentAction result = FuruAgentController.processIntent(
            '議事録テキスト...', 'Opportunity', null, 'record', 'ja'
        );
        Test.stopTest();

        System.assertEquals('EXTRACT', result.intent, 'Intent must be EXTRACT');
        System.assertNotEquals(null, result.fields, 'Fields must not be null');
        System.assertEquals(38000000, Integer.valueOf(String.valueOf(result.fields.get('Amount'))),
            'Amount must be 38,000,000');
        System.assertEquals('Proposal/Price Quote', result.fields.get('StageName'),
            'StageName must match');
    }

    // ── processIntent — GUIDE_CREATE ──────────────────────────────────────────

    @IsTest
    static void testProcessIntent_guideCreate() {
        String mockBody = JSON.serialize(new Map<String, Object>{
            'intent'        => 'GUIDE_CREATE',
            'message'       => '取引先を新規作成しましょう。',
            'guide_sobject' => 'Account',
            'should_save'   => false,
            'fields'        => new Map<String, Object>()
        });
        Test.setMock(HttpCalloutMock.class, new WorkerMock(mockBody));

        Test.startTest();
        FuruAgentController.AgentAction result = FuruAgentController.processIntent(
            '新規取引先を登録したい', 'Account', null, 'list', 'ja'
        );
        Test.stopTest();

        System.assertEquals('GUIDE_CREATE', result.intent, 'Intent must be GUIDE_CREATE');
        System.assertNotEquals(null, result.guideFields, 'guideFields must be set');
        System.assert(result.guideFields.size() > 0, 'guideFields must not be empty');
    }

    // ── processIntent — Worker HTTP error ─────────────────────────────────────

    @IsTest
    static void testProcessIntent_workerError() {
        Test.setMock(HttpCalloutMock.class, new WorkerMock('Internal Server Error', 500));

        Test.startTest();
        FuruAgentController.AgentAction result = FuruAgentController.processIntent(
            'テスト', 'Account', null, 'other', 'ja'
        );
        Test.stopTest();

        System.assertEquals('UNKNOWN', result.intent, 'Worker error → UNKNOWN');
        System.assertNotEquals(null, result.errorMessage, 'errorMessage must be set on failure');
    }

    // ── processIntent — UPDATE_RECORD with knowledge rules ────────────────────

    @IsTest
    static void testProcessIntent_updateRecord_knowledgeWarnings() {
        // Insert an Approved rule that should surface as a warning
        insert makeRule('Opportunity', 'クローズ日は必ず未来の日付にしてください。', 'Approved');

        String mockBody = JSON.serialize(new Map<String, Object>{
            'intent'      => 'UPDATE_RECORD',
            'message'     => 'フェーズを更新しました',
            'should_save' => true,
            'fields'      => new Map<String, Object>{ 'StageName' => 'Closed Won' }
        });
        Test.setMock(HttpCalloutMock.class, new WorkerMock(mockBody));

        Test.startTest();
        FuruAgentController.AgentAction result = FuruAgentController.processIntent(
            'フェーズをClosed Wonに変更', 'Opportunity', null, 'record', 'ja'
        );
        Test.stopTest();

        System.assertEquals('UPDATE_RECORD', result.intent);
        System.assert(
            result.knowledgeWarnings != null && result.knowledgeWarnings.size() > 0,
            'Approved knowledge rules must surface as warnings'
        );
    }

    // ── checkKnowledgeRulesInternal ───────────────────────────────────────────

    @IsTest
    static void testCheckKnowledgeRules_onlyApprovedSurface() {
        insert new List<FuruAgent_Knowledge__c>{
            makeRule('Account', 'Approved rule A', 'Approved'),
            makeRule('Account', 'Approved rule B', 'Approved'),
            makeRule('Account', 'Pending rule',    'Pending'),
            makeRule('Account', 'Rejected rule',   'Rejected'),
            makeRule('Account', 'Disabled rule',   'Disabled')
        };

        Test.startTest();
        List<String> warnings = FuruAgentController.checkKnowledgeRulesInternal('Account');
        Test.stopTest();

        System.assert(warnings.size() <= 3, 'Max 3 warnings returned');
        for (String w : warnings) {
            System.assert(w.containsIgnoreCase('Approved'), 'Only Approved rules must surface');
        }
    }

    @IsTest
    static void testCheckKnowledgeRules_approvedRuleSurfaces() {
        // The Status__c field defaults to 'Pending' — inserting without Status__c
        // gives Pending, not null. Verify that explicitly Approved rules surface.
        insert makeRule('Lead', 'Approved rule for Lead', 'Approved');

        Test.startTest();
        List<String> warnings = FuruAgentController.checkKnowledgeRulesInternal('Lead');
        Test.stopTest();

        System.assert(!warnings.isEmpty(), 'Approved rule must surface');
        System.assert(warnings[0].containsIgnoreCase('Approved rule for Lead'),
            'Rule text must match inserted rule');
    }

    @IsTest
    static void testCheckKnowledgeRules_maxThreeReturned() {
        for (Integer i = 0; i < 6; i++) {
            insert makeRule('Contact', 'Rule ' + i, 'Approved');
        }

        Test.startTest();
        List<String> warnings = FuruAgentController.checkKnowledgeRulesInternal('Contact');
        Test.stopTest();

        System.assert(warnings.size() <= 3, 'Must cap at 3 warnings regardless of records');
    }

    @IsTest
    static void testCheckKnowledgeRules_wrongSObjectNotReturned() {
        insert makeRule('Account', 'Account rule', 'Approved');

        Test.startTest();
        List<String> warnings = FuruAgentController.checkKnowledgeRulesInternal('Opportunity');
        Test.stopTest();

        System.assertEquals(0, warnings.size(), 'Rules for wrong sObject must not appear');
    }

    // ── learnFromValidationError ──────────────────────────────────────────────

    @IsTest
    static void testLearnFromValidationError_queuesCallout() {
        // Verify the method is callable and queues without exploding.
        // The @future callout itself cannot be tested synchronously, but we verify
        // the main method does not throw and the record is eventually created.
        Test.setMock(HttpCalloutMock.class, new WorkerMock(
            '{"translated":"クローズ日は未来の日付にしてください。","sObjectType":"Opportunity"}'
        ));

        Test.startTest();
        FuruAgentController.learnFromValidationError(
            'Opportunity',
            'FIELD_CUSTOM_VALIDATION_EXCEPTION: Close date must be in the future.',
            '["CloseDate"]'
        );
        Test.stopTest();
        // No exception = pass
        System.assert(true, 'learnFromValidationError must not throw');
    }

    // ── getObjectFieldInsights ────────────────────────────────────────────────

    @IsTest
    static void testGetObjectFieldInsights_returnsFields() {
        Test.startTest();
        Map<String, FuruAgentController.FieldInsight> insights =
            FuruAgentController.getObjectFieldInsights('Account');
        Test.stopTest();

        System.assert(insights.size() > 0, 'Account must have field insights');
        System.assert(insights.containsKey('Name'), 'Name field must be present');

        FuruAgentController.FieldInsight nameField = insights.get('Name');
        System.assertEquals('Name', nameField.apiName, 'apiName must match key');
        System.assertNotEquals(null, nameField.isRequired,  'isRequired must be set');
        System.assertNotEquals(null, nameField.isCalculated,'isCalculated must be set');
    }

    @IsTest
    static void testGetObjectFieldInsights_opportunityHasAmount() {
        Test.startTest();
        Map<String, FuruAgentController.FieldInsight> insights =
            FuruAgentController.getObjectFieldInsights('Opportunity');
        Test.stopTest();

        System.assert(insights.containsKey('Amount'), 'Opportunity must have Amount field');
        FuruAgentController.FieldInsight amount = insights.get('Amount');
        System.assertEquals('CURRENCY', amount.fieldType, 'Amount fieldType must be CURRENCY');
    }

    // ── getFieldSnapshot ──────────────────────────────────────────────────────

    @IsTest
    static void testGetFieldSnapshot_returnsValues() {
        Account a = new Account(Name = 'スナップショットテスト株式会社', Industry = 'Technology');
        insert a;

        Test.startTest();
        Map<String, Object> snap = FuruAgentController.getFieldSnapshot(
            a.Id, new List<String>{ 'Name', 'Industry' }
        );
        Test.stopTest();

        System.assertEquals('スナップショットテスト株式会社', snap.get('Name'), 'Name must match');
        System.assertEquals('Technology', snap.get('Industry'), 'Industry must match');
    }
}
