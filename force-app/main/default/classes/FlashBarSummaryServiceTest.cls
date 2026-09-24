@isTest
private class FlashBarSummaryServiceTest {

    @TestSetup
    static void setup() {
        Account acc = new Account(Name = 'Acme Rotor Corp');
        insert acc;

        Case c = new Case(
            Subject   = 'Structural breakdown of rotor assembly',
            Status    = 'New',
            Origin    = 'Web',
            AccountId = acc.Id
        );
        insert c;
    }

    @isTest
    static void testGetRecordSummary_referenceField_resolvesToParentName() {
        Case c = [SELECT Id FROM Case LIMIT 1];

        Test.startTest();
        FlashBarSummaryService.SummaryResult result = FlashBarSummaryService.getRecordSummary('Case', c.Id);
        Test.stopTest();

        System.assertNotEquals(null, result.fields, 'fields must not be null');

        FlashBarSummaryService.SummaryField accountField;
        for (FlashBarSummaryService.SummaryField f : result.fields) {
            if (f.apiName == 'AccountId') accountField = f;
        }
        System.assertNotEquals(null, accountField, 'AccountId should be a candidate summary field');
        System.assert(accountField.isReference, 'AccountId must be flagged as a reference field');
        System.assertEquals('Acme Rotor Corp', accountField.displayValue,
            'Reference field must display the parent Account Name, not the raw Id');
        System.assertNotEquals(null, accountField.referenceRecordId, 'referenceRecordId must be populated for navigation');
    }

    @isTest
    static void testGetRecordSummary_blankInputs_returnsEmptyFields() {
        Test.startTest();
        FlashBarSummaryService.SummaryResult result = FlashBarSummaryService.getRecordSummary(null, null);
        Test.stopTest();

        System.assertEquals(0, result.fields.size());
    }

    @isTest
    static void testGetCandidateFields_returnsAccountIdAsReference() {
        Test.startTest();
        List<FlashBarSummaryService.SummaryField> candidates = FlashBarSummaryService.getCandidateFields('Case');
        Test.stopTest();

        Boolean found = false;
        for (FlashBarSummaryService.SummaryField f : candidates) {
            if (f.apiName == 'AccountId') found = true;
        }
        System.assert(found, 'AccountId should be among Case candidate fields');
    }

    @isTest
    static void testUpdateSummaryFields_persistsSelection() {
        String fieldsJson = JSON.serialize(new List<Map<String, Object>>{
            new Map<String, Object>{ 'apiName' => 'Subject', 'label' => 'Subject', 'fieldType' => 'STRING', 'isRequired' => true }
        });

        Test.startTest();
        String status = FlashBarSummaryService.updateSummaryFields('Case', fieldsJson);
        Test.stopTest();

        System.assertEquals('OK', status);
    }
}
