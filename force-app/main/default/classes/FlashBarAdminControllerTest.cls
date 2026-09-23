@IsTest
private class FlashBarAdminControllerTest {

    // ── Fixtures ──────────────────────────────────────────────────────────────

    private static FuruAgent_Knowledge__c makeRule(String sObj, String ruleText, String status) {
        return new FuruAgent_Knowledge__c(
            Target_sObject__c      = sObj,
            Plain_English_Rule__c  = ruleText,
            Status__c              = status,
            Occurrences__c         = 1
        );
    }

    // ── getAdminContext ───────────────────────────────────────────────────────

    @IsTest
    static void testGetAdminContext_noAdmin() {
        // Standard user running the test — isAdmin reflects real profile.
        // We just assert the shape is correct and pendingCount >= 0.
        Test.startTest();
        FlashBarAdminController.AdminContext ctx = FlashBarAdminController.getAdminContext();
        Test.stopTest();

        System.assertNotEquals(null, ctx,            'AdminContext must not be null');
        System.assertNotEquals(null, ctx.isAdmin,    'isAdmin must be set');
        System.assert(ctx.pendingCount >= 0,         'pendingCount must be non-negative');
    }

    @IsTest
    static void testGetAdminContext_withPendingRules() {
        insert makeRule('Opportunity', 'Close date must be in the future', 'Pending');
        insert makeRule('Account',     'Industry must not be blank',        'Pending');

        Test.startTest();
        FlashBarAdminController.AdminContext ctx = FlashBarAdminController.getAdminContext();
        Test.stopTest();

        // If the running user is an admin the count reflects the inserts; otherwise 0
        if (ctx.isAdmin) {
            System.assert(ctx.pendingCount >= 2, 'Admin should see pending count ≥ 2');
        } else {
            System.assertEquals(0, ctx.pendingCount, 'Non-admin always sees 0');
        }
    }

    // ── getPendingRules ───────────────────────────────────────────────────────

    @IsTest
    static void testGetPendingRules_returnsApprovedAndPendingNotMixed() {
        insert new List<FuruAgent_Knowledge__c>{
            makeRule('Opportunity', 'Pending rule 1',   'Pending'),
            makeRule('Opportunity', 'Approved rule',    'Approved'),
            makeRule('Opportunity', 'Rejected rule',    'Rejected')
        };

        Test.startTest();
        List<FlashBarAdminController.KnowledgeRule> rules =
            FlashBarAdminController.getPendingRules('Opportunity');
        Test.stopTest();

        if (!FlashBarAdminController.isFlashBarAdmin()) {
            System.assertEquals(0, rules.size(), 'Non-admin gets empty list');
            return;
        }
        // Only Pending rules returned
        for (FlashBarAdminController.KnowledgeRule r : rules) {
            System.assertEquals('Pending', r.status, 'getPendingRules must return only Pending');
        }
    }

    @IsTest
    static void testGetPendingRules_currentSObjectFirst() {
        insert new List<FuruAgent_Knowledge__c>{
            makeRule('Account',     'Account rule',     'Pending'),
            makeRule('Opportunity', 'Opp rule',         'Pending')
        };

        Test.startTest();
        List<FlashBarAdminController.KnowledgeRule> rules =
            FlashBarAdminController.getPendingRules('Opportunity');
        Test.stopTest();

        if (!FlashBarAdminController.isFlashBarAdmin() || rules.isEmpty()) return;
        System.assertEquals('Opportunity', rules[0].sObjectType,
            'Current sObject rules should be sorted first');
    }

    // ── getAllRules ───────────────────────────────────────────────────────────

    @IsTest
    static void testGetAllRules_excludesRejected() {
        insert new List<FuruAgent_Knowledge__c>{
            makeRule('Opportunity', 'Approved rule',  'Approved'),
            makeRule('Opportunity', 'Pending rule',   'Pending'),
            makeRule('Opportunity', 'Rejected rule',  'Rejected'),
            makeRule('Opportunity', 'Disabled rule',  'Disabled')
        };

        Test.startTest();
        List<FlashBarAdminController.KnowledgeRule> rules =
            FlashBarAdminController.getAllRules('Opportunity');
        Test.stopTest();

        if (!FlashBarAdminController.isFlashBarAdmin()) {
            System.assertEquals(0, rules.size(), 'Non-admin gets empty list');
            return;
        }
        for (FlashBarAdminController.KnowledgeRule r : rules) {
            System.assertNotEquals('Rejected', r.status, 'Rejected rules must be excluded');
        }
        System.assert(rules.size() >= 3, 'Should return Approved + Pending + Disabled');
    }

    @IsTest
    static void testGetAllRules_nullFilterReturnsAll() {
        insert new List<FuruAgent_Knowledge__c>{
            makeRule('Opportunity', 'Opp rule',     'Approved'),
            makeRule('Account',     'Acct rule',    'Approved')
        };

        Test.startTest();
        List<FlashBarAdminController.KnowledgeRule> rules =
            FlashBarAdminController.getAllRules(null);
        Test.stopTest();

        if (!FlashBarAdminController.isFlashBarAdmin()) return;
        System.assert(rules.size() >= 2, 'Null filter should return rules for all sObjects');
    }

    // ── approveRule ───────────────────────────────────────────────────────────

    @IsTest
    static void testApproveRule() {
        if (!FlashBarAdminController.isFlashBarAdmin()) return;

        FuruAgent_Knowledge__c r = makeRule('Opportunity', 'Test rule', 'Pending');
        insert r;

        Test.startTest();
        FlashBarAdminController.approveRule(r.Id);
        Test.stopTest();

        FuruAgent_Knowledge__c updated = [SELECT Status__c FROM FuruAgent_Knowledge__c WHERE Id = :r.Id];
        System.assertEquals('Approved', updated.Status__c, 'Status must be Approved after approve');
    }

    // ── rejectRule ────────────────────────────────────────────────────────────

    @IsTest
    static void testRejectRule() {
        if (!FlashBarAdminController.isFlashBarAdmin()) return;

        FuruAgent_Knowledge__c r = makeRule('Opportunity', 'Test rule', 'Pending');
        insert r;

        Test.startTest();
        FlashBarAdminController.rejectRule(r.Id);
        Test.stopTest();

        FuruAgent_Knowledge__c updated = [SELECT Status__c FROM FuruAgent_Knowledge__c WHERE Id = :r.Id];
        System.assertEquals('Rejected', updated.Status__c, 'Status must be Rejected after reject');
    }

    // ── toggleRule ────────────────────────────────────────────────────────────

    @IsTest
    static void testToggleRule_disableAndReenable() {
        if (!FlashBarAdminController.isFlashBarAdmin()) return;

        FuruAgent_Knowledge__c r = makeRule('Account', 'Toggle rule', 'Approved');
        insert r;

        Test.startTest();
        FlashBarAdminController.toggleRule(r.Id, false);
        FuruAgent_Knowledge__c afterDisable = [SELECT Status__c FROM FuruAgent_Knowledge__c WHERE Id = :r.Id];
        System.assertEquals('Disabled', afterDisable.Status__c, 'Toggle false → Disabled');

        FlashBarAdminController.toggleRule(r.Id, true);
        FuruAgent_Knowledge__c afterEnable = [SELECT Status__c FROM FuruAgent_Knowledge__c WHERE Id = :r.Id];
        System.assertEquals('Approved', afterEnable.Status__c, 'Toggle true → Approved');
        Test.stopTest();
    }

    // ── deleteRule ────────────────────────────────────────────────────────────

    @IsTest
    static void testDeleteRule() {
        if (!FlashBarAdminController.isFlashBarAdmin()) return;

        FuruAgent_Knowledge__c r = makeRule('Lead', 'Delete me', 'Approved');
        insert r;
        String ruleId = r.Id;

        Test.startTest();
        FlashBarAdminController.deleteRule(ruleId);
        Test.stopTest();

        List<FuruAgent_Knowledge__c> remaining =
            [SELECT Id FROM FuruAgent_Knowledge__c WHERE Id = :ruleId];
        System.assertEquals(0, remaining.size(), 'Rule must be deleted');
    }

    // ── updateRuleText ────────────────────────────────────────────────────────

    @IsTest
    static void testUpdateRuleText_updatesAndTrims() {
        if (!FlashBarAdminController.isFlashBarAdmin()) return;

        FuruAgent_Knowledge__c r = makeRule('Contact', 'Original text', 'Approved');
        insert r;

        Test.startTest();
        FlashBarAdminController.updateRuleText(r.Id, '  New trimmed text  ');
        Test.stopTest();

        FuruAgent_Knowledge__c updated =
            [SELECT Plain_English_Rule__c FROM FuruAgent_Knowledge__c WHERE Id = :r.Id];
        System.assertEquals('New trimmed text', updated.Plain_English_Rule__c,
            'Text must be trimmed and saved');
    }

    @IsTest
    static void testUpdateRuleText_blankThrows() {
        if (!FlashBarAdminController.isFlashBarAdmin()) return;

        FuruAgent_Knowledge__c r = makeRule('Contact', 'Original', 'Approved');
        insert r;

        Test.startTest();
        Boolean caught = false;
        try {
            FlashBarAdminController.updateRuleText(r.Id, '   ');
        } catch (AuraHandledException e) {
            caught = true;
        }
        Test.stopTest();

        System.assert(caught, 'Blank text must throw AuraHandledException');
    }

    // ── Non-admin blocked ─────────────────────────────────────────────────────

    @IsTest
    static void testNonAdmin_writeMethodsThrow() {
        if (FlashBarAdminController.isFlashBarAdmin()) return; // skip for admin runners

        FuruAgent_Knowledge__c r = makeRule('Opportunity', 'Rule', 'Pending');
        insert r;

        Test.startTest();
        try {
            FlashBarAdminController.approveRule(r.Id);
            System.assert(false, 'Should have thrown for non-admin');
        } catch (AuraHandledException e) {
            System.assert(e.getMessage().contains('管理者') || e.getMessage().length() > 0,
                'Exception message must not be empty');
        }
        Test.stopTest();
    }

    // ── KnowledgeRule shape ───────────────────────────────────────────────────

    @IsTest
    static void testKnowledgeRuleShape() {
        if (!FlashBarAdminController.isFlashBarAdmin()) return;

        insert makeRule('Opportunity', 'Shape test rule', 'Approved');

        Test.startTest();
        List<FlashBarAdminController.KnowledgeRule> rules =
            FlashBarAdminController.getAllRules('Opportunity');
        Test.stopTest();

        System.assert(!rules.isEmpty(), 'Must have at least one rule');
        FlashBarAdminController.KnowledgeRule kr = rules[0];
        System.assertNotEquals(null, kr.id,          'id must be set');
        System.assertNotEquals(null, kr.ruleText,    'ruleText must be set');
        System.assertNotEquals(null, kr.sObjectType, 'sObjectType must be set');
        System.assertNotEquals(null, kr.status,      'status must be set');
        System.assertNotEquals(null, kr.isEnabled,   'isEnabled must be set');
        System.assertNotEquals(null, kr.createdDate, 'createdDate must be set');
    }
}
