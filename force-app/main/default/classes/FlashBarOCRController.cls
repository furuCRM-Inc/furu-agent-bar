/**
 * FlashBarOCRController
 * Invokes the FlashBar_Document_Extractor Agentforce Flex Prompt Template
 * via ConnectApi.EinsteinLLM. Einstein Trust Layer processes the document
 * entirely within Salesforce — no third-party vision API keys required.
 *
 * After extraction, a detected 7-digit Japanese postal code is automatically
 * enhanced via the FlashBar Worker /v1/jp-address proxy (Zipcloud).
 *
 * Flow:
 *   LWC drops image → base64 → this class → Agentforce → Zipcloud → JSON back to LWC
 */
public with sharing class FlashBarOCRController {

    // ── Public result envelope ────────────────────────────────────────────────

    public class OcrResult {
        @AuraEnabled public String              intent;          // CREATE_RECORD | UPDATE_RECORD
        @AuraEnabled public Decimal             confidence;
        @AuraEnabled public Map<String, Object> extractedFields;
        @AuraEnabled public String              errorMessage;
        @AuraEnabled public String              docType;         // BUSINESS_CARD | MEETING_NOTE | OTHER
        @AuraEnabled public String              targetSObject;   // recommended sObject to save into
    }

    // ── Main OCR entry point ──────────────────────────────────────────────────

    @AuraEnabled
    public static OcrResult processDocumentViaAgentforce(
        String base64Image,
        String mimeType,
        String targetObject,
        String recordId         // null for create flow, populated for update flow
    ) {
        if (String.isBlank(base64Image) || String.isBlank(targetObject)) {
            OcrResult err = new OcrResult();
            err.errorMessage = 'base64Image and targetObject are required.';
            return err;
        }
        try {
            String schemaJson = getFieldSchemaJson(targetObject);

            // ── Invoke Agentforce Prompt Template ─────────────────────────────
            ConnectApi.EinsteinPromptTemplateGenerationsInput promptInput =
                new ConnectApi.EinsteinPromptTemplateGenerationsInput();
            promptInput.isPreview   = false;
            promptInput.inputParams = new Map<String, ConnectApi.WrappedValue>();

            ConnectApi.WrappedValue sObjParam = new ConnectApi.WrappedValue();
            sObjParam.value = targetObject;
            promptInput.inputParams.put('Input:sObjectApiName', sObjParam);

            ConnectApi.WrappedValue schemaParam = new ConnectApi.WrappedValue();
            schemaParam.value = schemaJson;
            promptInput.inputParams.put('Input:fieldsSchema', schemaParam);

            ConnectApi.WrappedValue imageParam = new ConnectApi.WrappedValue();
            imageParam.value = base64Image;
            promptInput.inputParams.put('Input:documentImage', imageParam);

            ConnectApi.EinsteinPromptTemplateGenerationsRepresentation response =
                ConnectApi.EinsteinLLM.generateMessagesForPromptTemplate(
                    'FlashBar_Document_Extractor', promptInput
                );

            if (response?.generations == null || response.generations.isEmpty()) {
                OcrResult err = new OcrResult();
                err.errorMessage = 'Agentforce returned no extraction result.';
                return err;
            }

            // ── Parse extraction JSON ─────────────────────────────────────────
            String rawJson = response.generations[0].text;
            // Strip markdown code fences if the model wraps the output
            if (rawJson.startsWith('```')) {
                rawJson = rawJson.replaceFirst('^```[a-z]*\\n?', '').replaceAll('```$', '').trim();
            }

            Map<String, Object> parsed = (Map<String, Object>) JSON.deserializeUntyped(rawJson);
            Map<String, Object> fields = (Map<String, Object>) (parsed.get('extractedFields') ?? parsed.get('fields') ?? new Map<String, Object>());

            // ── Zipcloud postal code enhancement ─────────────────────────────
            String zipRaw = String.valueOf(
                fields.get('PostalCode') ?? fields.get('MailingPostalCode') ?? fields.get('BillingPostalCode') ?? ''
            );
            if (String.isNotBlank(zipRaw)) {
                String clean = zipRaw.replaceAll('[^0-9]', '');
                if (clean.length() == 7) {
                    Map<String, String> addr = callJpAddress(clean);
                    if (addr != null) {
                        // Overwrite with verified data; pick right field names per sObject
                        String zipField   = targetObject == 'Account'  ? 'BillingPostalCode'
                                          : targetObject == 'Contact'  ? 'MailingPostalCode'
                                          : 'PostalCode';
                        String stateField = targetObject == 'Account'  ? 'BillingState'
                                          : targetObject == 'Contact'  ? 'MailingState'
                                          : 'State';
                        String cityField  = targetObject == 'Account'  ? 'BillingCity'
                                          : targetObject == 'Contact'  ? 'MailingCity'
                                          : 'City';
                        fields.put(zipField,   addr.get('postalCode'));
                        fields.put(stateField,  addr.get('prefecture'));
                        fields.put(cityField,   addr.get('city'));
                        // Street = Zipcloud town + user-captured portion
                        String town = addr.get('town') ?? '';
                        Object existingStreet = fields.get(
                            targetObject == 'Account' ? 'BillingStreet'
                          : targetObject == 'Contact' ? 'MailingStreet'
                          : 'Street'
                        );
                        String streetField = targetObject == 'Account' ? 'BillingStreet'
                                           : targetObject == 'Contact' ? 'MailingStreet'
                                           : 'Street';
                        String streetVal = (existingStreet != null && String.isNotBlank(String.valueOf(existingStreet)))
                            ? town + ' ' + String.valueOf(existingStreet)
                            : town;
                        if (String.isNotBlank(streetVal)) fields.put(streetField, streetVal.trim());
                    }
                }
            }

            String docType     = detectDocType(fields);
            String targetSObj  = resolveTargetSObject(docType, targetObject);
            // Re-fetch schema for the resolved target and re-run postal enhancement
            // if target changed (e.g., MEETING_NOTE detected on Lead page → switch to Opportunity)
            if (!targetSObj.equalsIgnoreCase(targetObject)) {
                targetObject = targetSObj;
            }

            OcrResult result = new OcrResult();
            result.intent          = String.valueOf(parsed.get('intent') ?? 'CREATE_RECORD');
            result.confidence      = (Decimal) (parsed.get('confidence') ?? 0.0);
            result.extractedFields = fields;
            result.docType         = docType;
            result.targetSObject   = targetSObj;
            return result;

        } catch (Exception e) {
            OcrResult err = new OcrResult();
            err.errorMessage = 'OCR Processing failed: ' + e.getMessage();
            return err;
        }
    }

    // ── Zipcloud proxy via FlashBar Worker ────────────────────────────────────

    private static Map<String, String> callJpAddress(String sevenDigitZip) {
        try {
            HttpRequest req = new HttpRequest();
            req.setEndpoint('callout:FuruAgent_Backend/v1/jp-address');
            req.setMethod('POST');
            req.setHeader('Content-Type', 'application/json');
            req.setHeader('X-Salesforce-Org-Id', UserInfo.getOrganizationId());
            req.setTimeout(6000);
            req.setBody('{"zipcode":"' + sevenDigitZip + '"}');
            HttpResponse res = new Http().send(req);
            if (res.getStatusCode() == 200) {
                Map<String, Object> raw = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
                Map<String, String> out = new Map<String, String>();
                for (String k : raw.keySet()) {
                    Object v = raw.get(k);
                    if (v != null) out.put(k, String.valueOf(v));
                }
                return out;
            }
        } catch (Exception e) { /* non-critical — return null, caller skips enhancement */ }
        return null;
    }

    // ── Direct record import ──────────────────────────────────────────────────

    /**
     * Creates or updates a Salesforce record from OCR-extracted field values.
     * Handles type coercion (Currency → Decimal, Date → Date, etc.) so the LWC
     * does not need to know each field's display type.
     *
     * @param sObjectApiName  Target sObject API name (e.g., 'Lead', 'Opportunity')
     * @param fieldsJson      JSON object of { apiName: rawValue } pairs
     * @param recordId        Existing record Id for update; blank/null for create
     * @return                The Id of the created or updated record
     */
    @AuraEnabled
    public static String importOcrToRecord(String sObjectApiName, String fieldsJson, String recordId) {
        if (String.isBlank(sObjectApiName) || String.isBlank(fieldsJson)) {
            throw new AuraHandledException('sObjectApiName and fieldsJson are required.');
        }
        Schema.SObjectType token = Schema.getGlobalDescribe().get(sObjectApiName);
        if (token == null) throw new AuraHandledException('Unknown sObject: ' + sObjectApiName);

        Map<String, Object> rawFields = (Map<String, Object>) JSON.deserializeUntyped(fieldsJson);
        Map<String, Schema.SObjectField> fm = token.getDescribe().fields.getMap();
        Boolean isCreate = String.isBlank(recordId);
        SObject rec = isCreate ? token.newSObject() : token.newSObject(recordId);

        for (String apiName : rawFields.keySet()) {
            String lower = apiName.toLowerCase();
            if (!fm.containsKey(lower)) continue;
            Schema.DescribeFieldResult fr = fm.get(lower).getDescribe();
            if (isCreate  && !fr.isCreateable())  continue;
            if (!isCreate && !fr.isUpdateable())  continue;

            Object val    = rawFields.get(apiName);
            if (val == null) continue;
            String strVal = String.valueOf(val).trim();
            if (String.isBlank(strVal)) continue;

            Schema.DisplayType dt = fr.getType();
            try {
                if (dt == Schema.DisplayType.Currency || dt == Schema.DisplayType.Double
                 || dt == Schema.DisplayType.Percent) {
                    rec.put(fr.getName(), Decimal.valueOf(strVal.replaceAll('[^0-9.]', '')));
                } else if (dt == Schema.DisplayType.Integer) {
                    rec.put(fr.getName(), Integer.valueOf(strVal.replaceAll('[^0-9]', '')));
                } else if (dt == Schema.DisplayType.Date) {
                    rec.put(fr.getName(), Date.valueOf(strVal));
                } else if (dt == Schema.DisplayType.DateTime) {
                    rec.put(fr.getName(), DateTime.valueOf(strVal));
                } else if (dt == Schema.DisplayType.Boolean) {
                    rec.put(fr.getName(), 'true'.equalsIgnoreCase(strVal));
                } else {
                    rec.put(fr.getName(), strVal);
                }
            } catch (Exception typeErr) { /* incompatible value — skip silently */ }
        }

        try {
            if (isCreate) { insert rec; } else { update rec; }
            return rec.Id;
        } catch (DmlException dml) {
            throw new AuraHandledException(dml.getDmlMessage(0));
        }
    }

    // ── Document type detection ────────────────────────────────────────────────

    private static final Set<String> OPP_SIGNALS  = new Set<String>{
        'Amount','StageName','CloseDate','NextStep','Probability','ForecastCategory'
    };
    private static final Set<String> CARD_SIGNALS = new Set<String>{
        'LastName','FirstName','Phone','Email','Company','Title','Department','MobilePhone'
    };

    private static String detectDocType(Map<String, Object> fields) {
        Integer oppScore = 0, cardScore = 0;
        for (String k : fields.keySet()) {
            if (OPP_SIGNALS.contains(k))  oppScore++;
            if (CARD_SIGNALS.contains(k)) cardScore++;
        }
        if (oppScore >= 2)  return 'MEETING_NOTE';
        if (cardScore >= 2) return 'BUSINESS_CARD';
        return 'OTHER';
    }

    private static String resolveTargetSObject(String docType, String contextSObject) {
        if (docType == 'BUSINESS_CARD') return 'Lead';
        if (docType == 'MEETING_NOTE') {
            // If we're already on an Opportunity, update it; otherwise create one
            return 'Opportunity';
        }
        return String.isNotBlank(contextSObject) ? contextSObject : 'Lead';
    }

    // ── Field schema builder ──────────────────────────────────────────────────

    private static String getFieldSchemaJson(String sObjectType) {
        if (String.isBlank(sObjectType)) return '{}';
        try {
            Map<String, Schema.SObjectField> fm =
                Schema.getGlobalDescribe().get(sObjectType)?.getDescribe().fields.getMap();
            if (fm == null) return '{}';
            Map<String, String> schema = new Map<String, String>();
            for (String apiName : fm.keySet()) {
                Schema.DescribeFieldResult f = fm.get(apiName).getDescribe();
                if (f.isDeprecatedAndHidden() || !f.isUpdateable()) continue;
                schema.put(apiName, f.getLabel());
            }
            return JSON.serialize(schema);
        } catch (Exception e) {
            return '{}';
        }
    }
}
