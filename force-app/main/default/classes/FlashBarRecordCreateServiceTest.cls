@isTest
private class FlashBarRecordCreateServiceTest {

    @isTest
    static void testCreateRecordFromFields_createsLead() {
        String fieldsJson = JSON.serialize(new Map<String, Object>{
            'LastName' => 'Tanaka',
            'Company'  => 'Acme Corp',
            'Email'    => 'tanaka@acme.test'
        });

        Test.startTest();
        String newId = FlashBarRecordCreateService.createRecordFromFields('Lead', fieldsJson, null);
        Test.stopTest();

        Lead l = [SELECT LastName, Company, Email FROM Lead WHERE Id = :newId];
        System.assertEquals('Tanaka', l.LastName);
        System.assertEquals('Acme Corp', l.Company);
        System.assertEquals('tanaka@acme.test', l.Email);
    }

    @isTest
    static void testCreateRecordFromFields_updatesExistingRecord() {
        Account acc = new Account(Name = 'Original Name');
        insert acc;

        String fieldsJson = JSON.serialize(new Map<String, Object>{ 'Name' => 'Updated Name' });

        Test.startTest();
        String updatedId = FlashBarRecordCreateService.createRecordFromFields('Account', fieldsJson, acc.Id);
        Test.stopTest();

        System.assertEquals(acc.Id, updatedId);
        Account updated = [SELECT Name FROM Account WHERE Id = :acc.Id];
        System.assertEquals('Updated Name', updated.Name);
    }

    @isTest
    static void testCreateRecordFromFields_typeCoercion() {
        String fieldsJson = JSON.serialize(new Map<String, Object>{
            'LastName'      => 'Suzuki',
            'Company'       => 'Coerce Inc',
            'AnnualRevenue' => '1,500,000',
            'NumberOfEmployees' => '42'
        });

        Test.startTest();
        String newId = FlashBarRecordCreateService.createRecordFromFields('Lead', fieldsJson, null);
        Test.stopTest();

        Lead l = [SELECT AnnualRevenue, NumberOfEmployees FROM Lead WHERE Id = :newId];
        System.assertEquals(1500000, l.AnnualRevenue);
        System.assertEquals(42, l.NumberOfEmployees);
    }

    @isTest
    static void testCreateRecordFromFields_blankInputs_throwsAuraHandledException() {
        try {
            FlashBarRecordCreateService.createRecordFromFields('', '{}', null);
            System.assert(false, 'Expected AuraHandledException for blank sObjectApiName');
        } catch (AuraHandledException ahe) {
            System.assert(true);
        }
    }

    @isTest
    static void testCreateRecordFromFields_unknownSObject_throwsAuraHandledException() {
        try {
            FlashBarRecordCreateService.createRecordFromFields('NotARealObject__x', '{}', null);
            System.assert(false, 'Expected AuraHandledException for unknown sObject');
        } catch (AuraHandledException ahe) {
            System.assert(true);
        }
    }

    @isTest
    static void testCreateRecordFromFields_unknownFieldsIgnored() {
        String fieldsJson = JSON.serialize(new Map<String, Object>{
            'LastName'          => 'Ignore',
            'Company'           => 'Skip Co',
            'NotARealField__c'  => 'should be skipped silently'
        });

        Test.startTest();
        String newId = FlashBarRecordCreateService.createRecordFromFields('Lead', fieldsJson, null);
        Test.stopTest();

        System.assertNotEquals(null, newId);
    }
}
