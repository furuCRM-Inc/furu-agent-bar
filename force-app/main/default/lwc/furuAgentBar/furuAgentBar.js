import { LightningElement, track, wire } from 'lwc';
import { CurrentPageReference, NavigationMixin } from 'lightning/navigation';
import { updateRecord }   from 'lightning/uiRecordApi';
import { publish, MessageContext } from 'lightning/messageService';
import { ShowToastEvent }  from 'lightning/platformShowToastEvent';
import LANG                from '@salesforce/i18n/lang';
import userId              from '@salesforce/user/Id';
import FuruAgentMessage    from '@salesforce/messageChannel/FuruAgentMessage__c';
import processIntent             from '@salesforce/apex/FuruAgentController.processIntent';
import getFieldSnapshot          from '@salesforce/apex/FuruAgentController.getFieldSnapshot';
import learnFromValidationError  from '@salesforce/apex/FuruAgentController.learnFromValidationError';
import getJapaneseAddress        from '@salesforce/apex/FuruAgentController.getJapaneseAddress';
import getObjectFieldInsights    from '@salesforce/apex/FuruAgentController.getObjectFieldInsights';
import getApprovedRules          from '@salesforce/apex/FuruAgentController.getApprovedRules';
import searchParentRecords       from '@salesforce/apex/FuruAgentController.searchParentRecords';
import processDocumentViaAgentforce    from '@salesforce/apex/FlashBarOCRController.processDocumentViaAgentforce';
import importOcrToRecord              from '@salesforce/apex/FlashBarOCRController.importOcrToRecord';
import { extractPostalCode, extractAddressTail, mapAddressToFields, getCachedAddress, setCachedAddress } from './jpAddressService';
import { parseCsv, buildRecords, sampleRows } from './csvParser';
import bulkImportCsv      from '@salesforce/apex/FuruAgentController.bulkImportCsv';
import executeSoqlQuery   from '@salesforce/apex/FuruAgentController.executeSoqlQuery';
import refreshSchemaCache    from '@salesforce/apex/FlashBarSchemaCacheService.refreshSchemaCache';
import saveClaudeApiKey        from '@salesforce/apex/FlashBarDashboardController.saveClaudeApiKey';
import checkClaudeStatus      from '@salesforce/apex/FlashBarDashboardController.checkClaudeStatus';
import disconnectClaude       from '@salesforce/apex/FlashBarDashboardController.disconnectClaude';
import createAnalytics        from '@salesforce/apex/FlashBarDashboardController.createAnalytics';
import getRecordSummary     from '@salesforce/apex/FlashBarSummaryService.getRecordSummary';
import getCandidateFields   from '@salesforce/apex/FlashBarSummaryService.getCandidateFields';
import updateSummaryFields  from '@salesforce/apex/FlashBarSummaryService.updateSummaryFields';
import getRecentRecords from '@salesforce/apex/FlashBarRecentService.getRecentRecords';
import getAdminContext  from '@salesforce/apex/FlashBarAdminController.getAdminContext';
import getPendingRules  from '@salesforce/apex/FlashBarAdminController.getPendingRules';
import getAllRules       from '@salesforce/apex/FlashBarAdminController.getAllRules';
import approveRule      from '@salesforce/apex/FlashBarAdminController.approveRule';
import rejectRule       from '@salesforce/apex/FlashBarAdminController.rejectRule';
import toggleRule       from '@salesforce/apex/FlashBarAdminController.toggleRule';
import deleteRule       from '@salesforce/apex/FlashBarAdminController.deleteRule';
import updateRuleText   from '@salesforce/apex/FlashBarAdminController.updateRuleText';
import getEditSchema        from '@salesforce/apex/FlashBarMassEditService.getEditSchema';
import updateMassiveRecords from '@salesforce/apex/FlashBarMassEditService.updateMassiveRecords';
import executeJevIntent          from '@salesforce/apex/FlashBarAgentforceRuntime.executeJevIntent';
import getSchemaForWorkerKv      from '@salesforce/apex/FlashBarAgentforceRuntime.getSchemaForWorkerKv';
import getCustomSObjectsForKv    from '@salesforce/apex/FlashBarAgentforceRuntime.getCustomSObjectsForKv';
import getUserNavItems      from '@salesforce/apex/FlashBarNavigationController.getUserNavItems';
import pinQuery             from '@salesforce/apex/FlashBarNavigationController.pinQuery';
import pinPage              from '@salesforce/apex/FlashBarNavigationController.pinPage';
import deleteNavItem        from '@salesforce/apex/FlashBarNavigationController.deleteNavItem';

const TEXTAREA_MAX_H = 160;

// Default select fields shown per sObject when SOQL_SEARCH fires
const SOQL_DEFAULT_FIELDS = {
    Opportunity: [
        { apiName: 'Name',             label: '商談名',    labelEn: 'Name' },
        { apiName: 'Amount',           label: '金額',      labelEn: 'Amount' },
        { apiName: 'StageName',        label: 'フェーズ',  labelEn: 'Stage' },
        { apiName: 'CloseDate',        label: '完了予定日', labelEn: 'Close Date' },
        { apiName: 'Account.Name',     label: '取引先',    labelEn: 'Account' },
        { apiName: 'LastActivityDate', label: '最終活動日', labelEn: 'Last Activity' },
    ],
    Account: [
        { apiName: 'Name',             label: '取引先名',  labelEn: 'Name' },
        { apiName: 'Industry',         label: '業種',      labelEn: 'Industry' },
        { apiName: 'AnnualRevenue',    label: '年間売上',  labelEn: 'Revenue' },
        { apiName: 'BillingCity',      label: '市区町村',  labelEn: 'City' },
        { apiName: 'LastActivityDate', label: '最終活動日', labelEn: 'Last Activity' },
    ],
    Contact: [
        { apiName: 'Name',             label: '氏名',    labelEn: 'Name' },
        { apiName: 'Email',            label: 'メール',  labelEn: 'Email' },
        { apiName: 'Phone',            label: '電話',    labelEn: 'Phone' },
        { apiName: 'Title',            label: '役職',    labelEn: 'Title' },
        { apiName: 'Account.Name',     label: '取引先',  labelEn: 'Account' },
        { apiName: 'LastActivityDate', label: '最終活動日', labelEn: 'Last Activity' },
    ],
    Lead: [
        { apiName: 'Name',             label: '氏名',        labelEn: 'Name' },
        { apiName: 'Company',          label: '会社名',      labelEn: 'Company' },
        { apiName: 'Email',            label: 'メール',      labelEn: 'Email' },
        { apiName: 'Status',           label: 'ステータス',  labelEn: 'Status' },
        { apiName: 'LastActivityDate', label: '最終活動日',  labelEn: 'Last Activity' },
    ],
    Case: [
        { apiName: 'CaseNumber', label: 'ケース番号',  labelEn: 'Case #' },
        { apiName: 'Subject',    label: '件名',        labelEn: 'Subject' },
        { apiName: 'Status',     label: 'ステータス',  labelEn: 'Status' },
        { apiName: 'Priority',   label: '優先度',      labelEn: 'Priority' },
        { apiName: 'Account.Name', label: '取引先',    labelEn: 'Account' },
    ],
};

const INACTIVE_DAYS = 14;  // warning threshold for LastActivityDate

// Child sObject → required parent lookup field config
const PARENT_LOOKUP = {
    Opportunity: { field: 'AccountId', parentSObj: 'Account', labelJa: '取引先',       labelEn: 'Account' },
    Contact:     { field: 'AccountId', parentSObj: 'Account', labelJa: '取引先',       labelEn: 'Account' },
    Case:        { field: 'AccountId', parentSObj: 'Account', labelJa: '取引先',       labelEn: 'Account' },
};

// Parent sObject → quick child-creation actions (chip label + parent lookup field)
const CHILD_ACTIONS = {
    Account: [
        { sObject: 'Contact',     field: 'AccountId', icon: '👤', labelJa: '担当者を追加',   labelEn: 'Add Contact'  },
        { sObject: 'Opportunity', field: 'AccountId', icon: '💼', labelJa: '商談を作成',     labelEn: 'Create Deal'  },
        { sObject: 'Task',        field: 'WhatId',    icon: '📝', labelJa: '活動を記録',     labelEn: 'Log Activity' },
    ],
    Contact: [
        { sObject: 'Opportunity', field: 'ContactId', icon: '💼', labelJa: '商談を作成',     labelEn: 'Create Deal'  },
        { sObject: 'Task',        field: 'WhoId',     icon: '📝', labelJa: '活動を記録',     labelEn: 'Log Activity' },
    ],
    Lead: [
        { sObject: 'Task',        field: 'WhoId',     icon: '📝', labelJa: '活動を記録',     labelEn: 'Log Activity' },
    ],
    Opportunity: [
        { sObject: 'Task',        field: 'WhatId',    icon: '📝', labelJa: '活動を記録',     labelEn: 'Log Activity' },
        { sObject: 'Contact',     field: 'AccountId', icon: '👤', labelJa: '担当者をリンク', labelEn: 'Link Contact' },
    ],
    Case: [
        { sObject: 'Task',        field: 'WhatId',    icon: '📝', labelJa: '活動を記録',     labelEn: 'Log Activity' },
    ],
};

// OCR target sObject options (shown in review card)
const OCR_IMPORT_TARGETS = [
    { sObject: 'Lead',        icon: '🪪', labelJa: 'リード',  labelEn: 'Lead'        },
    { sObject: 'Opportunity', icon: '💼', labelJa: '商談',    labelEn: 'Opportunity' },
    { sObject: 'Contact',     icon: '👤', labelJa: '連絡先',  labelEn: 'Contact'     },
];

const SOBJECT_FROM_URL = () => {
    const parts = window.location.pathname.split('/');
    const idx   = parts.indexOf('r');
    return idx !== -1 ? parts[idx + 1] : null;
};

// Localized sObject display names for Japanese UI
const SOBJECT_LABELS_JA = {
    Opportunity: '商談',
    Account:     '取引先',
    Contact:     '連絡先',
    Lead:        'リード',
    Case:        'ケース',
    Task:        '行動',
    Event:       '行動',
    Campaign:    'キャンペーン',
};

const I18N = {
    ja: {
        placeholder:  '〒 住所、営業メモ、またはコマンドを入力...',
        hint:         'Shift+Enter: 改行 | Enter: 実行',
        undo:         '元に戻す',
        save:         '保存',
        discard:      '破棄',
        results:      '件 — クリックで移動',
        required:     '必須',
        optional:     '任意',
        formula:      '数式',
        guideHint:    'フィールド名をコマンドに使って入力できます',
        guideCreating:'作成中',
        knowledgeTitle: '⚡ ルールアラート',
        proceed:      'そのまま続行',
        cancel:       'キャンセル',
        ctxRulesTitle: '適用中のAIルール',
        chips: [
            { key: 'addr',  label: '〒 住所自動入力', cmd: '〒 ' },
            { key: 'memo',  label: '📝 メモ解析',     cmd: '' },
            { key: 'phase', label: '⚡ フェーズ更新',  cmd: 'フェーズを ' },
        ],
    },
    en: {
        placeholder:  'Enter 〒 postal code, paste notes, or type a command...',
        hint:         'Shift+Enter: newline | Enter: run',
        undo:         'Undo',
        save:         'Save',
        discard:      'Discard',
        results:      'result(s) — click to navigate',
        required:     'Required',
        optional:     'Optional',
        formula:      'Formula',
        guideHint:    'Type a command to pre-fill any of these fields',
        guideCreating:'Creating',
        knowledgeTitle: '⚡ Rule Alert',
        proceed:      'Proceed Anyway',
        cancel:       'Cancel',
        ctxRulesTitle: 'Active AI Rules',
        chips: [
            { key: 'addr',  label: '〒 Address Fill',  cmd: '〒 ' },
            { key: 'memo',  label: '📝 Paste Notes',   cmd: '' },
            { key: 'phase', label: '⚡ Update Stage',  cmd: 'Update Stage to ' },
        ],
    },
};

export default class FuruAgentBar extends NavigationMixin(LightningElement) {

    // ── Page context ──────────────────────────────────────────────────────────
    @wire(CurrentPageReference)
    wiredPage(ref) {
        this._pageRef = ref;
        if (!ref) return;
        const attrs          = ref.attributes ?? {};
        const prevRecordId   = this._recordId;
        this._recordId       = attrs.recordId    ?? null;
        const newSObj        = attrs.objectApiName ?? SOBJECT_FROM_URL() ?? null;
        const prevSObj       = this._sObjectType;
        this._sObjectType    = newSObj;
        this._pageType       = ref.type ?? 'other';
        if (newSObj && newSObj !== prevSObj) {
            this._loadContextPanel(newSObj);
            this._seedWorkerKvSchema(newSObj);  // Warm Worker KV schema cache for Jev template validation
        }
        // Load summary when on a record page and context has changed
        if (this._recordId && (this._recordId !== prevRecordId || newSObj !== prevSObj)) {
            // Clear transient cards from previous page so summary can show
            this._soqlQuery      = null;
            this._insightAction  = null;
            this._knowledgeAlert = null;
            this.searchResults   = [];
            this._loadSummary(newSObj, this._recordId);
        } else if (!this._recordId && this._summaryResult) {
            this._summaryResult  = null;
            this._summaryEditing = false;
        }
    }

    @wire(MessageContext) _msgCtx;
    @wire(getUserNavItems)
    wiredNavItems({ data, error }) {
        if (data) this._navItems = JSON.parse(JSON.stringify(data));
        if (error) this._navItems = [];
    }

    // ── State ─────────────────────────────────────────────────────────────────
    @track inputText      = '';
    @track isLoading      = false;
    @track statusMessage  = '';
    @track statusType     = 'info';
    @track showUndo       = false;
    @track searchResults  = [];
    @track _prefillAction = null;
    @track _guideAction       = null;
    @track _insightAction     = null;
    @track _knowledgeAlert    = null;   // pending UPDATE action awaiting user confirmation
    @track _addressCard       = null;   // resolved JP address awaiting user confirmation
    @track _remainingCredits  = null;   // free-tier credit count from backend
    @track _isDragOver        = false;  // file being dragged over input card
    @track _isOcrLoading      = false;  // Agentforce Vision in progress
    @track _attachedFileName  = null;   // name of file currently being processed
    // Admin
    @track _isAdmin           = false;
    @track _pendingRules      = [];     // rules awaiting approval
    @track _allRules          = [];     // rules for settings modal
    @track _showSettings      = false;
    @track _claudeConnected   = false;
    @track _savingApiKey      = false;
    @track _apiKeyInput       = '';
    @track _creatingAnalytics = false;
    @track _analyticsResult   = null;   // { reportId, reportUrl, dashboardId, dashboardUrl, reportName, dashboardName }
    @track _analyticsIntent   = null;   // 'CREATE_REPORT' | 'CREATE_DASHBOARD'
    @track _analyticsRequest  = null;   // verbatim user request
    @track _editingRuleId     = null;
    @track _editingRuleText   = '';
    // Context panel (ambient field guide + semantic rules)
    @track _contextFields     = [];
    @track _contextRules      = [];
    // SOQL smart search
    @track _soqlQuery         = null;   // { sObject, conditions, orderBy, limit, selectFields, records, summary, isLoading }
    @track _savedQueries      = [];     // personal shortcuts from localStorage
    @track _recentRecords     = [];     // from RecentlyViewed SOQL
    @track _recentPrompts     = [];     // from localStorage
    @track _viewMode          = 'card'; // 'card' | 'table'
    _isWideMode               = false;
    _resizeObs                = null;
    // Schema cache admin
    @track _refreshingCache   = false;
    // OCR direct import
    @track _ocrImporting      = false;
    // Record summary card
    @track _summaryResult     = null;   // { fields: [...], isEditable }
    @track _summaryEditing    = false;  // true while showing field-selector UI
    @track _summaryAllFields  = [];     // candidate fields for edit mode
    @track _savingSummary     = false;
    // CSV bulk import
    @track _csvState          = null;  // { phase, fileName, headers, rows, mappings, result, progress }
    @track _csvDownloadHref   = null;  // data: URI for result CSV download
    _csvRowStatuses           = [];    // [{ status:'OK'|'NG', error:string|null }] indexed by data row
    // Parent-child lookup resolver
    @track _parentState       = null;  // { field, parentSObj, labelJa, labelEn, selectedParent, candidates, isSearching, searchText }
    // Mass editor overlay (legacy — kept for external use)
    @track _showMassEditor    = false;
    // Navigation hub
    @track _navItems           = [];
    @track _pinDialogOpen      = false;
    @track _pinLabel           = '';
    @track _pinSaving          = false;
    // Inline table edit mode
    @track _tableEditMode      = false;
    @track _tableDraftMap      = {};    // { recordId: { apiName: value } }
    @track _tableSchema        = {};    // { apiName: ColumnMeta }
    @track _tableSchemaLoading = false;
    @track _tableSaving        = false;
    @track _tableErrors        = {};    // { recordId: errorMessage }
    @track _tableSaved         = {};    // { recordId: true }

    _recordId     = null;
    _sObjectType  = null;
    _pageType     = 'other';
    _undoSnapshot = null;
    _reportSummary = null;       // REPORT_EXPLAIN: plain-language summary from Jev runtime
    _workerKvSeeded = new Set(); // sObject API names already seeded into Worker KV this session

    // ── i18n ─────────────────────────────────────────────────────────────────

    get isJa()  { return (LANG ?? 'en').startsWith('ja'); }
    get i18n() { return I18N[this.isJa ? 'ja' : 'en']; }

    // ── Getters ───────────────────────────────────────────────────────────────

    get contextLabel() {
        const label = this.isJa
            ? (SOBJECT_LABELS_JA[this._sObjectType] ?? this._sObjectType)
            : this._sObjectType;
        if (label && this._recordId) return `${label}: ${this._recordId.slice(-5)}`;
        if (label) return label;
        return '';
    }

    get creditLabel()  {
        if (this._remainingCredits == null) return '';
        return `✨ ${this._remainingCredits}`;
    }
    get hasCredits()   { return this._remainingCredits != null; }
    get quickChips()   { return this.i18n.chips ?? []; }
    get isDragOver()   { return this._isDragOver; }
    get isOcrLoading() { return this._isOcrLoading; }
    get inputCardClass() {
        let c = 'furu-bar__input-card';
        if (this._isDragOver)   c += ' furu-bar__input-card--drop';
        if (this._isOcrLoading) c += ' furu-bar__input-card--ocr';
        return c;
    }

    get charCount()    { return this.inputText.length > 40 ? `${this.inputText.length}` : ''; }
    get statusClass()  { return `furu-bar__status furu-bar__status--${this.statusType}`; }
    get statusIcon()   { return { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' }[this.statusType] ?? 'ℹ️'; }
    get hasResults()   { return this.searchResults.length > 0; }
    get resultCount()  { return this.searchResults.length; }
    get hasPrefill()   { return this._prefillAction !== null; }
    get hasGuide()          { return this._guideAction !== null; }
    get hasInsight()        { return this._insightAction !== null; }
    get hasKnowledgeAlert() { return this._knowledgeAlert !== null; }
    get hasAddressCard()    { return this._addressCard !== null; }
    get knowledgeWarnings() { return this._knowledgeAlert?.knowledgeWarnings ?? []; }

    // ── Context panel (ambient, idle state) ───────────────────────────────────

    get showContextPanel() {
        if (!this._sObjectType) return false;
        const hasActiveCard = this.hasPrefill || this.hasGuide || this.hasResults ||
                              this.hasInsight || this.hasKnowledgeAlert || this.hasAddressCard ||
                              this.hasPendingApprovals || this.hasCsvImport || this.hasSoqlResults;
        if (hasActiveCard) return false;
        return this._contextFields.length > 0 || this._contextRules.length > 0;
    }

    // ── SOQL Smart Search getters ─────────────────────────────────────────────

    get hasSoqlResults() { return this._soqlQuery !== null; }
    get soqlIsLoading()  { return this._soqlQuery?.isLoading ?? false; }
    get soqlSummary()    { return this._soqlQuery?.summary ?? ''; }
    get soqlRecordCount(){ return this._soqlQuery?.records?.length ?? 0; }

    get soqlTotalAmount() {
        if (!this._soqlQuery?.records) return null;
        let total = 0; let found = false;
        for (const r of this._soqlQuery.records) {
            if (r.Amount != null) { total += Number(r.Amount); found = true; }
        }
        return found ? total : null;
    }

    get soqlTotalAmountLabel() {
        const v = this.soqlTotalAmount;
        if (v == null) return '';
        const man = Math.round(v / 10000);
        return this.isJa ? `合計 ￥${man.toLocaleString()}万` : `Total ¥${v.toLocaleString()}`;
    }

    get soqlFieldBadges() {
        return (this._soqlQuery?.selectFields ?? []).map((f, i) => ({
            ...f,
            idx:    String(i),
            isLast: false,   // unused, kept for extensibility
        }));
    }

    get soqlResultCards() {
        if (!this._soqlQuery?.records?.length) return [];
        const fields   = this._soqlQuery.selectFields ?? [];
        const isJa     = this.isJa;
        const today    = new Date();

        return this._soqlQuery.records.map((rec, ri) => {
            // Activity warning: LastActivityDate > INACTIVE_DAYS days ago
            const lastAct = rec['LastActivityDate'];
            let isInactive = false;
            let daysSince  = null;
            if (lastAct) {
                const diff = Math.floor((today - new Date(lastAct)) / 86400000);
                daysSince  = diff;
                isInactive = diff >= INACTIVE_DAYS;
            } else if (fields.some(f => f.apiName === 'LastActivityDate')) {
                isInactive = true;
            }

            // Build per-card field rows (skip Name + Id — shown in card header)
            const fieldRows = fields
                .filter(f => f.apiName !== 'Name' && f.apiName !== 'CaseNumber')
                .map(f => {
                    const raw = rec[f.apiName] ?? '';
                    let display = raw === '' || raw == null ? '—' : String(raw);
                    if (f.apiName === 'Amount' && raw !== '') {
                        display = '￥' + Number(raw).toLocaleString();
                    } else if (f.apiName === 'LastActivityDate') {
                        display = raw ? `${daysSince}日前` : '—';
                        if (isInactive) display += ' ⚠️';
                    } else if (f.apiName === 'CloseDate' && raw) {
                        display = raw; // already YYYY-MM-DD from Salesforce
                    }
                    return {
                        key:   String(ri) + '_' + f.apiName,
                        label: isJa ? f.label : f.labelEn,
                        value: display,
                    };
                });

            return {
                key:        String(ri),
                id:         rec['Id'] ?? '',
                name:       rec['Name'] ?? rec['CaseNumber'] ?? rec['Subject'] ?? `(#${ri + 1})`,
                isInactive,
                fieldRows,
                injectCmd:  isJa
                    ? `「${rec['Name'] ?? ''}」`
                    : `"${rec['Name'] ?? ''}"`,
            };
        });
    }

    get soqlExportFileName() {
        const sObj = this._soqlQuery?.sObject ?? 'Search';
        const ts   = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        return `FlashBar_${sObj}_${ts}.csv`;
    }

    get soqlIsCardMode()        { return this._viewMode === 'card';  }
    get soqlIsTableMode()       { return this._viewMode === 'table'; }
    get soqlWideHint()          { return !this._isWideMode && (this._soqlQuery?.selectFields?.length ?? 0) >= 4; }
    get soqlShortcutsLabel()    { return this.isJa ? 'よく使う検索' : 'Saved searches'; }

    // ── Record Summary Card getters ───────────────────────────────────────────

    get hasSummaryCard() {
        if (!this._recordId || !this._sObjectType) return false;
        // hasPendingApprovals is a bottom notification, not a replacement for the summary
        const hasActiveCard = this.hasPrefill || this.hasGuide || this.hasResults ||
                              this.hasInsight || this.hasKnowledgeAlert || this.hasAddressCard ||
                              this.hasCsvImport || this.hasSoqlResults;
        if (hasActiveCard) return false;
        return (this._summaryResult?.fields?.length ?? 0) > 0;
    }

    get summaryTitle() {
        const sObj = this._sObjectType ?? '';
        return this.isJa
            ? (SOBJECT_LABELS_JA[sObj] ?? sObj) + ' サマリー'
            : sObj + ' Summary';
    }

    get summaryFieldRows() {
        return (this._summaryResult?.fields ?? []).map((f, i) => ({
            rowKey:       f.apiName ?? String(i),
            apiName:      f.apiName,
            label:        f.label ?? f.apiName ?? '—',
            isRequired:   f.isRequired,
            displayValue: f.value != null ? String(f.value) : '—',
            cssClass:     `furu-bar__summary-field${f.isRequired ? ' furu-bar__summary-field--req' : ''}`,
        }));
    }

    get summaryEditSaveLabel() { return this.isJa ? '保存' : 'Save'; }

    // Skips for:each when editing, avoids lwc:unless issues inside nested templates
    get summaryDisplayRows() {
        if (this._summaryEditing) return [];
        return this.summaryFieldRows;
    }

    // ── Recent Records & Prompt Suggestions ───────────────────────────────────

    get showSuggestions() {
        if (this.inputText.trim() !== '') return false;
        if (this.isLoading) return false;
        const hasActiveCard = this.hasPrefill || this.hasGuide || this.hasResults ||
                              this.hasInsight || this.hasKnowledgeAlert || this.hasAddressCard ||
                              this.hasCsvImport || this.hasSoqlResults;
        if (hasActiveCard) return false;
        return this._recentRecords.length > 0 || this._recentPrompts.length > 0;
    }

    get hasRecentRecords() { return this._recentRecords.length > 0; }
    get hasRecentPrompts() { return this._recentPrompts.length > 0; }

    get recentRecordChips() {
        return this._recentRecords.map(r => ({
            id:   r.id,
            icon: r.icon,
            name: r.name.length > 18 ? r.name.slice(0, 16) + '…' : r.name,
            type: r.type,
        }));
    }

    get recentPromptChips() {
        return this._recentPrompts.map((p, i) => ({
            key:   String(i),
            text:  p,
            label: p.length > 22 ? p.slice(0, 20) + '…' : p,
        }));
    }

    // ── Child record quick-action chip getters ────────────────────────────────

    get childActionChips() {
        if (!this._recordId || !this._sObjectType) return [];
        const hasActiveCard = this.hasPrefill || this.hasGuide || this.hasResults ||
                              this.hasInsight || this.hasKnowledgeAlert || this.hasAddressCard ||
                              this.hasPendingApprovals || this.hasCsvImport || this.hasSoqlResults;
        if (hasActiveCard) return [];
        return (CHILD_ACTIONS[this._sObjectType] ?? []).map((c, i) => ({
            ...c,
            key:   String(i),
            label: this.isJa ? c.labelJa : c.labelEn,
        }));
    }

    get hasChildActions() { return this.childActionChips.length > 0; }

    get childActionsLabel() {
        const name = this.contextLabel || this._sObjectType || '';
        return this.isJa
            ? `💡 ${name} に追加:`
            : `💡 Add to ${name}:`;
    }

    // ── OCR review card getters ───────────────────────────────────────────────

    get prefillIsOcr() { return this._prefillAction?.isOcr === true; }

    get prefillDocTypeIcon() {
        const t = this._prefillAction?.docType ?? '';
        if (t === 'BUSINESS_CARD') return '🪪';
        if (t === 'MEETING_NOTE')  return '📝';
        return '📄';
    }

    get prefillDocTypeLabel() {
        const t = this._prefillAction?.docType ?? '';
        if (t === 'BUSINESS_CARD') return this.isJa ? '名刺' : 'Business Card';
        if (t === 'MEETING_NOTE')  return this.isJa ? '議事録' : 'Meeting Note';
        return this.isJa ? '書類' : 'Document';
    }

    get prefillConfidenceLabel() {
        const c = this._prefillAction?.confidence ?? 0;
        const pct = Math.round(c * 100);
        return this.isJa ? `信頼度 ${pct}%` : `Confidence ${pct}%`;
    }

    get prefillTargetOptions() {
        const cur = this._prefillAction?.updateSObject ?? '';
        return OCR_IMPORT_TARGETS.map(t => ({
            ...t,
            label:    this.isJa ? t.labelJa : t.labelEn,
            cssClass: `furu-bar__ocr-target-chip${t.sObject === cur ? ' furu-bar__ocr-target-chip--active' : ''}`,
        }));
    }

    get prefillImportLabel() {
        const sObj = this._prefillAction?.updateSObject ?? '';
        const label = this.isJa
            ? `${SOBJECT_LABELS_JA[sObj] ?? sObj} として保存`
            : `Save as ${sObj}`;
        return this._ocrImporting ? '...' : label;
    }

    get cacheRefreshHint() {
        const obj = this._sObjectType ?? (this.isJa ? '現在のオブジェクト' : 'current object');
        return this.isJa
            ? `現在のオブジェクト（${obj}）のフィールド定義を即時更新します。通常は24時間ごとに自動更新されます。`
            : `Forces an immediate refresh of ${obj} field metadata. Normally auto-refreshes every 24 hours.`;
    }
    get soqlSaveBtnTitle()      { return this.isJa ? 'この検索を保存' : 'Save this search'; }
    get soqlNameColLabel()      { return this.isJa ? '名前' : 'Name'; }

    // Table column headers — Name/CaseNumber excluded (rendered as sticky first column)
    get soqlTableHeaders() {
        return (this._soqlQuery?.selectFields ?? [])
            .filter(f => f.apiName !== 'Name' && f.apiName !== 'CaseNumber')
            .map((f, i) => ({
                key:     String(i),
                label:   this.isJa ? f.label : f.labelEn,
                apiName: f.apiName,
            }));
    }

    // Table rows — Name rendered as sticky td; cells contain all other fields
    get soqlTableRows() {
        if (!this._soqlQuery?.records?.length) return [];
        const fields    = this._soqlQuery.selectFields ?? [];
        const today     = new Date();
        const editMode  = this._tableEditMode;
        const schema    = this._tableSchema;
        const draftMap  = this._tableDraftMap;

        return this._soqlQuery.records.map((rec, ri) => {
            const lastAct    = rec['LastActivityDate'];
            const daysSince  = lastAct ? Math.floor((today - new Date(lastAct)) / 86400000) : null;
            const isInactive = (daysSince != null && daysSince >= INACTIVE_DAYS)
                || (!lastAct && fields.some(f => f.apiName === 'LastActivityDate'));
            const id       = rec['Id'] ?? '';
            const recDraft = draftMap[id] ?? {};

            const cells = fields
                .filter(f => f.apiName !== 'Name' && f.apiName !== 'CaseNumber')
                .map((f, ci) => {
                    const raw = rec[f.apiName];
                    let val = raw == null ? '' : String(raw);
                    if (f.apiName === 'Amount' && raw != null)         val = '￥' + Number(raw).toLocaleString();
                    else if (f.apiName === 'LastActivityDate' && raw)  val = `${daysSince}日前${isInactive ? ' ⚠️' : ''}`;
                    else if (f.apiName === 'LastActivityDate' && !raw) val = '—';

                    if (!editMode) {
                        return { key: `${ri}_${ci}`, apiName: f.apiName, value: val,
                                 cellClass: 'furu-bar__soql-td' };
                    }

                    const col       = schema[f.apiName];
                    const ft        = (col?.fieldType ?? '').toUpperCase();
                    const isEdit    = col?.isEditable ?? false;
                    const hasDraft  = Object.prototype.hasOwnProperty.call(recDraft, f.apiName);
                    const rawStr    = raw == null ? '' : String(raw);
                    const draftVal  = hasDraft ? recDraft[f.apiName] : null;
                    const inputVal  = hasDraft ? String(draftVal ?? '') : rawStr;
                    const boolVal   = hasDraft ? (draftVal === true || draftVal === 'true') : (raw === true);
                    const isPicklist = ft === 'PICKLIST';
                    const isBoolean  = ft === 'BOOLEAN';
                    const isNumber   = ft === 'CURRENCY' || ft === 'DOUBLE' || ft === 'PERCENT' || ft === 'INTEGER';
                    const isDate     = ft === 'DATE';
                    const inputType  = isNumber ? 'number' : isDate ? 'date' : 'text';

                    const picklistOptions = (col?.picklistOptions ?? []).map(o => ({
                        label: o.label, value: o.value, isSelected: o.value === inputVal,
                    }));

                    const cellClass = 'furu-bar__soql-td'
                        + (hasDraft                ? ' furu-bar__soql-td--dirty' : '')
                        + (this._tableErrors[id]   ? ' furu-bar__soql-td--row-error' : '');

                    return {
                        key: `${ri}_${ci}`,
                        apiName: f.apiName,
                        value: val,
                        inputVal,
                        boolVal,
                        isDirty: hasDraft,
                        isEditable: isEdit,
                        isPicklist,
                        isBoolean,
                        isText: isEdit && !isPicklist && !isBoolean,
                        inputType,
                        picklistOptions,
                        cellClass,
                    };
                });

            const rowClass = 'furu-bar__soql-tr'
                + (this._tableErrors[id] ? ' furu-bar__soql-tr--error' : '')
                + (this._tableSaved[id]  ? ' furu-bar__soql-tr--saved' : '');

            return { key: String(ri), id, isInactive, rowClass,
                     name: rec['Name'] ?? rec['CaseNumber'] ?? `#${ri + 1}`, cells };
        });
    }

    handleViewModeCard()  { this._viewMode = 'card';  }
    handleViewModeTable() { this._viewMode = 'table'; }

    get isTableEditMode()    { return this._tableEditMode; }
    get tableHasDirty()      { return Object.keys(this._tableDraftMap).length > 0; }
    get tableDirtyCount()    { return Object.keys(this._tableDraftMap).length; }
    get tableSaveDisabled()  { return this._tableSaving || !this.tableHasDirty; }
    get tableSchemaLoading() { return this._tableSchemaLoading; }
    get tableSaving()        { return this._tableSaving; }

    get hasNavItems()    { return this._navItems.length > 0; }
    get navItemRows()    {
        return this._navItems.map(item => ({
            id:          item.Id,
            label:       item.Label__c,
            icon:        item.Icon_Name__c ?? '📌',
            targetType:  item.Target_Type__c,
            isListEditor: item.Target_Type__c === 'ListEditor',
            isPage:       item.Target_Type__c === 'Page',
        }));
    }
    get pinDialogOpen()  { return this._pinDialogOpen; }
    get canPinQuery()    { return !!(this._soqlQuery?.records?.length); }
    get pinSaving()      { return this._pinSaving; }
    get pinLabel()       { return this._pinLabel; }

    get csvProgressStyle() {
        const total = this._csvState?.rows?.length ?? 1;
        const done  = this._csvState?.progress ?? 0;
        const pct   = Math.round((done / total) * 100);
        return `width: ${pct}%`;
    }

    get hasContextFields() { return this._contextFields.length > 0; }
    get hasContextRules()  { return this._contextRules.length > 0; }

    get contextSectionTitle() {
        const label = this.isJa
            ? (SOBJECT_LABELS_JA[this._sObjectType] ?? this._sObjectType ?? '')
            : (this._sObjectType ?? '');
        return this.isJa ? `${label} 入力ガイド` : `${label} Field Guide`;
    }

    get contextFieldRows() {
        return this._contextFields.map(f => ({
            ...f,
            statusIcon:  f.isRequired ? '⚠️' : '⭕',
            limitBadge:  this._fieldLimitBadge(f, this.isJa),
            exampleHint: f.isRequired ? this._fieldExampleHint(f, this.isJa) : null,
        }));
    }

    get contextRuleRows() {
        return this._contextRules.map((r, i) => ({ id: String(i), text: r }));
    }

    // ── Parent-child lookup getters ───────────────────────────────────────────

    get hasParentState()      { return this._parentState !== null; }
    get parentStateLabel()    {
        if (!this._parentState) return '';
        return this.isJa
            ? `🔗 ${this._parentState.labelJa}（親レコード）`
            : `🔗 ${this._parentState.labelEn} (parent)`;
    }
    get parentSelectedName()  { return this._parentState?.selectedParent?.name ?? null; }
    get hasParentCandidates() { return (this._parentState?.candidates?.length ?? 0) > 0; }
    get parentCandidates()    { return this._parentState?.candidates ?? []; }
    get isParentSearching()   { return this._parentState?.isSearching ?? false; }
    get parentSearchText()    { return this._parentState?.searchText ?? ''; }
    get parentSearchPlaceholder() {
        const lbl = this.isJa
            ? (this._parentState?.labelJa ?? '親')
            : (this._parentState?.labelEn ?? 'Parent');
        return this.isJa ? `${lbl}名で検索...` : `Search ${lbl}...`;
    }
    get parentAutobound() { return this._parentState?.autobound ?? false; }

    get addressRows() {
        if (!this._addressCard) return [];
        const c = this._addressCard;
        const rows = [
            { key: 'postalCode',  label: '〒',      value: c.postalCode },
            { key: 'prefecture',  label: '都道府県', value: c.prefecture + (c.prefectureKana ? `（${c.prefectureKana}）` : '') },
            { key: 'city',        label: '市区町村', value: c.city       + (c.cityKana       ? `（${c.cityKana}）`       : '') },
            { key: 'town',        label: '町名',     value: c.town       + (c.townKana       ? `（${c.townKana}）`       : '') },
        ];
        if (c.streetTail) rows.push({ key: 'street', label: '番地・建物', value: c.streetTail });
        return rows;
    }

    get prefillSummary() {
        if (!this._prefillAction?.fields) return '';
        return Object.entries(this._prefillAction.fields).map(([k, v]) => `${k}: ${v}`).join(' · ');
    }

    get prefillItems() {
        if (!this._prefillAction?.fields) return [];
        return Object.entries(this._prefillAction.fields).map(([k, v]) => ({
            apiName:      k,
            displayValue: v == null ? '(clear)' : String(v),
        }));
    }

    get prefillTitle() {
        const count     = this.prefillItems.length;
        const intent    = this._prefillAction?.intent;
        const isExtract = intent === 'EXTRACT' || intent === 'EXTRACT_AND_PREFILL';
        if (this.isJa) {
            return isExtract
                ? `✨ ${count}件のフィールドを抽出`
                : `✏️ ${count}件のフィールドを入力`;
        }
        return isExtract
            ? `✨ ${count} field${count !== 1 ? 's' : ''} extracted`
            : `✏️ ${count} field${count !== 1 ? 's' : ''} to pre-fill`;
    }

    get guideName() {
        const sObj  = this._guideAction?.guideSObject ?? '';
        const label = this.isJa ? (SOBJECT_LABELS_JA[sObj] ?? sObj) : sObj;
        return label
            ? `${this.i18n.guideCreating}: ${label}`
            : 'Object Guide';
    }

    get guideFields() {
        const all = this._guideAction?.guideFields;
        if (!all?.length) return [];
        const enrich = (f, icon) => ({
            ...f,
            statusIcon:  icon,
            limitBadge:  this._fieldLimitBadge(f, this.isJa),
            exampleHint: this._fieldExampleHint(f, this.isJa),
        });
        const required   = all.filter(f =>  f.isRequired                   ).map(f => enrich(f, '⚠️'));
        const optional   = all.filter(f => !f.isRequired && !f.isCalculated).slice(0, 6).map(f => enrich(f, '⭕'));
        const calculated = all.filter(f =>  f.isCalculated                 ).slice(0, 2).map(f => enrich(f, '🔢'));
        return [...required, ...optional, ...calculated];
    }

    _fieldLimitBadge(f, isJa) {
        const t = (f.fieldType ?? '').toUpperCase();
        switch (t) {
            case 'STRING':   case 'TEXTAREA': case 'LONGTEXTAREA':
                return f.length ? (isJa ? `最大${f.length}文字` : `Max ${f.length} chars`) : null;
            case 'EMAIL':
                return isJa ? 'メールアドレス' : 'Email';
            case 'PHONE':
                return isJa ? '半角数字・ハイフン可' : 'Phone';
            case 'URL':
                return 'URL';
            case 'DATE':
                return 'YYYY-MM-DD';
            case 'DATETIME':
                return 'YYYY-MM-DD HH:MM';
            case 'CURRENCY': case 'DOUBLE': case 'PERCENT':
                if (!f.precision) return null;
                return f.scale > 0
                    ? (isJa ? `数字/${f.precision}桁・小数${f.scale}位` : `Num ${f.precision}d.${f.scale}`)
                    : (isJa ? `数字・最大${f.precision}桁`              : `Num max ${f.precision}d`);
            case 'INTEGER': case 'LONG':
                return isJa ? '整数' : 'Integer';
            case 'PICKLIST':
                return isJa ? '選択リスト' : 'Picklist';
            case 'MULTIPICKLIST':
                return isJa ? '複数選択可' : 'Multi-select';
            case 'BOOLEAN':
                return isJa ? 'チェックボックス' : 'Checkbox';
            case 'REFERENCE':
                return isJa ? '参照' : 'Lookup';
            default:
                return null;
        }
    }

    _fieldExampleHint(f, isJa) {
        // Admin-defined inline help text takes priority
        if (f.helpText) return f.helpText;
        const t = (f.fieldType ?? '').toUpperCase();
        if (isJa) {
            switch (t) {
                case 'CURRENCY':
                    return '例: 1,500万円 または 15,000,000';
                case 'DATE':
                    return '例: 来月末、2026-12-31';
                case 'DATETIME':
                    return '例: 来週月曜 午後3時';
                case 'PHONE':
                    return '例: 03-1234-5678、090-0000-0000';
                case 'EMAIL':
                    return '例: yamada@example.co.jp';
                case 'URL':
                    return '例: https://example.co.jp';
                case 'PERCENT':
                    return '例: 15（% を除いた数値）';
                case 'PICKLIST': case 'MULTIPICKLIST':
                    return f.picklistOptions?.length
                        ? '例: ' + f.picklistOptions.slice(0, 3).join('、')
                        : null;
                case 'STRING': {
                    const lbl = (f.label ?? '').toLowerCase();
                    if (lbl.includes('name') || lbl.includes('名')) return '例: 株式会社〇〇_新規導入';
                    return null;
                }
                default:
                    return null;
            }
        } else {
            switch (t) {
                case 'CURRENCY':  return 'e.g. 15,000,000';
                case 'DATE':      return 'e.g. end of next month, 2026-12-31';
                case 'DATETIME':  return 'e.g. next Monday 3pm';
                case 'PICKLIST':  case 'MULTIPICKLIST':
                    return f.picklistOptions?.length
                        ? 'e.g. ' + f.picklistOptions.slice(0, 3).join(', ')
                        : null;
                default:          return null;
            }
        }
    }

    get insightCard() {
        if (!this._insightAction) return null;
        return {
            ...(this._insightAction.fieldInsight ?? {}),
            explanation: this._insightAction.explanation ?? null,
            message:     this._insightAction.message ?? null,
        };
    }

    // ── Input handlers ────────────────────────────────────────────────────────

    handleInputAutoResize(e) {
        this.inputText      = e.target.value;
        e.target.style.height = 'auto';
        e.target.style.height = Math.min(e.target.scrollHeight, TEXTAREA_MAX_H) + 'px';
    }

    handleCompositionStart() { this._isComposing = true;  }
    handleCompositionEnd()   { this._isComposing = false; }

    handleKeyDown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            // Skip if IME is mid-conversion — this Enter is confirming kana/kanji, not submitting
            if (this._isComposing || e.isComposing) return;
            e.preventDefault();
            this.handleSubmit();
        }
        if (e.key === 'Escape') {
            this._resetInput();
            this.dismissStatus();
            this.dismissResults();
            this.dismissGuide();
            this.dismissInsight();
            this.dismissKnowledgeAlert();
            this.dismissAddressCard();
        }
    }

    _resetInput() {
        this.inputText = '';
        const ta = this.template.querySelector('.furu-bar__textarea');
        if (ta) { ta.value = ''; ta.style.height = 'auto'; }
    }

    // ── Admin lifecycle ───────────────────────────────────────────────────────

    connectedCallback() {
        getAdminContext()
            .then(ctx => {
                this._isAdmin = ctx.isAdmin;
                if (ctx.isAdmin && ctx.pendingCount > 0) this._loadPendingRules();
            })
            .catch(() => {});
        this._savedQueries = this._loadSavedQueries();
        this._loadRecentPrompts();
        getRecentRecords()
            .then(recs => { this._recentRecords = JSON.parse(JSON.stringify(recs ?? [])); })
            .catch(() => {});
        checkClaudeStatus().then(connected => { this._claudeConnected = connected; }).catch(() => {});
        // Seed Worker KV with org's custom object catalog for Jev dynamic sObject criteria.
        // Fire-and-forget: non-blocking, doesn't affect first render.
        this._seedCustomSObjectsToWorkerKv();
    }

    _seedCustomSObjectsToWorkerKv() {
        getCustomSObjectsForKv()
            .then(objects => {
                if (!objects?.length) return;
                const orgId = this._orgId ?? '';
                // Seed custom object catalog for Jev dynamic Choice criteria.
                fetch('/services/apexrest/FuruAgent/sobjects-seed', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Salesforce-Org-Id': orgId },
                    body: JSON.stringify({ objects }),
                }).catch(() => {});
                // Build and seed synonym map: label/pluralLabel → apiName.
                // This lets the Worker resolve "発注" → "Purchase_Order__c" even if
                // the term falls outside Jev's 12-slot Choice list.
                const synonyms = {};
                for (const obj of objects) {
                    if (obj.label)       synonyms[obj.label]       = obj.apiName;
                    if (obj.pluralLabel && obj.pluralLabel !== obj.label) {
                        synonyms[obj.pluralLabel] = obj.apiName;
                    }
                }
                if (Object.keys(synonyms).length > 0) {
                    fetch('/services/apexrest/FuruAgent/synonyms-seed', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-Salesforce-Org-Id': orgId },
                        body: JSON.stringify({ synonyms }),
                    }).catch(() => {});
                }
            })
            .catch(() => {});
    }

    renderedCallback() {
        if (!this._resizeObs && this.template.host) {
            this._resizeObs = new ResizeObserver(entries => {
                const w      = entries[0]?.contentRect?.width ?? 0;
                const isWide = w > 480;
                if (isWide !== this._isWideMode) {
                    this._isWideMode = isWide;
                    // Auto-switch to table when bar is popped out with 4+ fields
                    if (this._soqlQuery && isWide && this._viewMode === 'card'
                        && (this._soqlQuery.selectFields?.length ?? 0) >= 4) {
                        this._viewMode = 'table';
                    }
                    if (!isWide) this._viewMode = 'card';
                }
            });
            this._resizeObs.observe(this.template.host);
        }
    }

    disconnectedCallback() {
        this._resizeObs?.disconnect();
        this._resizeObs = null;
    }

    // ── Personal query shortcut storage (localStorage) ────────────────────────

    _queryStorageKey() {
        return `furubar_qs_${(userId ?? 'anon').slice(-8)}`;
    }

    _loadSavedQueries() {
        try {
            const raw = localStorage.getItem(this._queryStorageKey());
            return raw ? JSON.parse(raw) : [];
        } catch (_) { return []; }
    }

    _persistSavedQueries(list) {
        try { localStorage.setItem(this._queryStorageKey(), JSON.stringify(list)); }
        catch (_) {}
    }

    // ── Recent prompt history (localStorage) ──────────────────────────────────

    _promptHistoryKey() {
        return `furubar_ph_${(userId ?? 'anon').slice(-8)}`;
    }

    _loadRecentPrompts() {
        try {
            const raw = localStorage.getItem(this._promptHistoryKey());
            this._recentPrompts = raw ? JSON.parse(raw) : [];
        } catch (_) { this._recentPrompts = []; }
    }

    _saveRecentPrompt(text) {
        if (!text || text.length > 200) return;
        try {
            const existing = this._recentPrompts;
            const updated  = [text, ...existing.filter(p => p !== text)].slice(0, 5);
            localStorage.setItem(this._promptHistoryKey(), JSON.stringify(updated));
            this._recentPrompts = updated;
        } catch (_) {}
    }

    handleRecordChip(e) {
        const id   = e.currentTarget.dataset.id;
        const type = e.currentTarget.dataset.type;
        this[NavigationMixin.Navigate]({
            type:       'standard__recordPage',
            attributes: { recordId: id, objectApiName: type, actionName: 'view' },
        });
    }

    handlePromptChip(e) {
        const prompt = e.currentTarget.dataset.prompt;
        if (!prompt) return;
        this.inputText = prompt;
        // Small delay so inputText is reflected in the textarea before submit
        setTimeout(() => this.handleSubmit(), 0);
    }

    _saveQuery(nameOverride) {
        if (!this._soqlQuery) return;
        const name = nameOverride
            ?? ((this._soqlQuery.summary ?? '').slice(0, 20) || (this.isJa ? '保存した検索' : 'Saved search'));
        const entry = {
            name,
            sObject:      this._soqlQuery.sObject,
            conditions:   this._soqlQuery.conditions,
            selectFields: this._soqlQuery.selectFields,
            orderBy:      this._soqlQuery.orderBy,
            limit:        this._soqlQuery.limit,
            savedAt:      new Date().toISOString(),
            useCount:     1,
        };
        const list = this._loadSavedQueries()
            .filter(q => q.name !== name)
            .slice(0, 8);
        list.unshift(entry);
        this._persistSavedQueries(list);
        this._savedQueries = list;
        this._setStatus(
            this.isJa ? `「${name}」を保存しました ⭐` : `Saved "${name}" ⭐`,
            'success'
        );
    }

    _deleteShortcut(name) {
        const list = this._loadSavedQueries().filter(q => q.name !== name);
        this._persistSavedQueries(list);
        this._savedQueries = list;
    }

    // ── Shortcut chip getters ─────────────────────────────────────────────────

    get showShortcuts() {
        return this._savedQueries.length > 0
            && !this.hasSoqlResults && !this.hasCsvImport && !this.hasPrefill
            && !this.hasGuide && !this.hasResults;
    }

    get shortcutChips() {
        return this._savedQueries.slice(0, 5).map((q, i) => ({
            idx:    String(i),
            name:   q.name,
            sObj:   q.sObject,
        }));
    }

    handleShortcutChip(e) {
        const idx  = Number(e.currentTarget.dataset.idx);
        const saved = this._savedQueries[idx];
        if (!saved) return;
        this._runSoqlFromSaved(saved);
    }

    handleDeleteShortcut(e) {
        e.stopPropagation();
        const idx = Number(e.currentTarget.dataset.idx);
        const q   = this._savedQueries[idx];
        if (q) this._deleteShortcut(q.name);
    }

    handleSoqlSave() {
        this._saveQuery();
    }

    async _runSoqlFromSaved(saved) {
        this._clearTableEditState();
        this._soqlQuery = {
            sObject:      saved.sObject,
            conditions:   saved.conditions,
            orderBy:      saved.orderBy,
            limit:        saved.limit,
            selectFields: saved.selectFields,
            records:      [],
            summary:      saved.name,
            isLoading:    true,
        };
        try {
            const records = await executeSoqlQuery({
                sObjectType:        saved.sObject,
                conditionsJson:     JSON.stringify(saved.conditions),
                selectApiNamesJson: JSON.stringify(saved.selectFields.map(f => f.apiName)),
                orderBy:            saved.orderBy,
                maxRows:            saved.limit,
            });
            // Increment use count
            const list = this._loadSavedQueries().map(q =>
                q.name === saved.name ? { ...q, useCount: (q.useCount ?? 0) + 1 } : q
            );
            this._persistSavedQueries(list);
            this._savedQueries = list;

            this._soqlQuery = { ...this._soqlQuery, records, isLoading: false };
            this._setStatus(
                this.isJa ? `${records.length}件が見つかりました` : `${records.length} record(s) found`,
                'info'
            );
        } catch (err) {
            this._soqlQuery = null;
            this._setStatus(err.body?.message ?? err.message ?? 'Query failed', 'error');
        }
    }

    _loadPendingRules() {
        getPendingRules({ sObjectType: this._sObjectType ?? '' })
            .then(rules => { this._pendingRules = rules ?? []; })
            .catch(() => {});
    }

    _loadAllRules() {
        getAllRules({ sObjectType: this._sObjectType ?? '' })
            .then(rules => { this._allRules = rules ?? []; })
            .catch(() => {});
    }

    _loadContextPanel(sobj) {
        this._contextFields = [];
        this._contextRules  = [];
        if (!sobj) return;
        getObjectFieldInsights({ sObjectType: sobj })
            .then(insights => {
                const fields   = Object.values(insights ?? {});
                const required = fields.filter(f => f.isRequired && !f.isCalculated);
                const optional = fields.filter(f => !f.isRequired && !f.isCalculated).slice(0, 5);
                this._contextFields = [...required, ...optional].slice(0, 8);
            })
            .catch(() => {});
        getApprovedRules({ sObjectType: sobj })
            .then(rules => { this._contextRules = rules ?? []; })
            .catch(() => {});
    }

    _loadSummary(sobj, recordId) {
        this._summaryResult  = null;
        this._summaryEditing = false;
        this._summaryAllFields = [];
        if (!sobj || !recordId) return;
        getRecordSummary({ sObjectApiName: sobj, recordId })
            .then(result => {
                // JSON round-trip unwraps the LWC read-only proxy so for:each can iterate
                this._summaryResult = JSON.parse(JSON.stringify(result ?? {}));
            })
            .catch(() => {});
    }

    async handleEditSummary() {
        if (!this._summaryEditing) {
            this._summaryEditing = true;
            if (this._summaryAllFields.length === 0) {
                try {
                    const raw = await getCandidateFields({ sObjectApiName: this._sObjectType });
                    const valueMap = {};
                    (this._summaryResult?.fields ?? []).forEach(f => {
                        if (f.apiName && f.value != null) valueMap[f.apiName] = f.value;
                    });
                    this._summaryAllFields = JSON.parse(JSON.stringify(raw)).map(f => ({
                        ...f,
                        displayValue: valueMap[f.apiName] ?? null,
                    }));
                } catch(e) {
                    this._summaryEditing = false;
                }
            }
        } else {
            this._summaryEditing   = false;
            this._summaryAllFields = [];
        }
    }

    handleSummaryFieldToggle(e) {
        const apiName = e.currentTarget.dataset.apiname;
        this._summaryAllFields = this._summaryAllFields.map(f =>
            f.apiName === apiName ? { ...f, isChecked: !f.isChecked } : f
        );
    }

    async handleSummarySave() {
        const selected = this._summaryAllFields.filter(f => f.isChecked);
        if (selected.length === 0) {
            this._setStatus(this.isJa ? '少なくとも1項目を選択してください。' : 'Select at least one field.', 'warning');
            return;
        }
        this._savingSummary = true;
        try {
            await updateSummaryFields({
                sObjectApiName: this._sObjectType,
                fieldsJson:     JSON.stringify(selected),
            });
            this._summaryEditing   = false;
            this._summaryAllFields = [];
            this._loadSummary(this._sObjectType, this._recordId);
        } catch(e) {
            this._setStatus(e.body?.message ?? 'Save failed', 'error');
        } finally {
            this._savingSummary = false;
        }
    }

    // ── Admin getters ─────────────────────────────────────────────────────────

    get isAdmin()           { return this._isAdmin; }
    get showSettings()      { return this._showSettings; }

    // ── Claude / Analytics getters ────────────────────────────────────────────
    get claudeConnected()       { return this._claudeConnected; }
    get saveApiKeyLabel()       { return this._savingApiKey ? (this.isJa ? '保存中…' : 'Saving…') : (this.isJa ? '保存' : 'Save'); }
    get saveApiKeyDisabled()    { return this._savingApiKey || !this._apiKeyInput.startsWith('sk-ant-'); }
    get creatingAnalytics()    { return this._creatingAnalytics; }
    get analyticsResult()      { return this._analyticsResult; }
    get hasAnalyticsResult()   { return this._analyticsResult != null && !this._creatingAnalytics; }
    get analyticsIsDashboard() { return this._analyticsIntent === 'CREATE_DASHBOARD'; }
    get analyticsSuccessTitle() {
        return this.analyticsIsDashboard
            ? (this.isJa ? '🎉 ダッシュボードを作成しました' : '🎉 Dashboard Created')
            : (this.isJa ? '🎉 レポートを作成しました'     : '🎉 Report Created');
    }
    get analyticsCreatingLabel() {
        return this._analyticsIntent === 'CREATE_DASHBOARD'
            ? (this.isJa ? 'Claudeがダッシュボードを生成中…' : 'Claude is generating the dashboard…')
            : (this.isJa ? 'Claudeがレポートを生成中…'       : 'Claude is generating the report…');
    }
    get hasPendingApprovals() { return this._isAdmin && this._pendingRules.length > 0; }
    get pendingRule()       { return this._pendingRules[0] ?? null; }
    get allRules()          { return this._allRules.map(r => ({ ...r, isEditing: r.id === this._editingRuleId })); }
    get pendingRuleText() {
        const r = this.pendingRule;
        if (!r) return '';
        if (r.ruleText) return r.ruleText;
        if (r.triggerField) return `${r.sObjectType} の「${r.triggerField}」フィールドに関するルール（詳細翻訳中）`;
        if (r.errorMessage) return r.errorMessage;
        return '（ルール内容未設定）';
    }
    get pendingRuleCount()  { return this._pendingRules.length; }
    get pendingBadge()      {
        const n = this._pendingRules.length;
        return n > 0 ? String(n) : '';
    }

    // ── Admin handlers ────────────────────────────────────────────────────────

    async handleApproveRule() {
        const id = this.pendingRule?.id;
        if (!id) return;
        try {
            await approveRule({ ruleId: id });
            this._pendingRules = this._pendingRules.filter(r => r.id !== id);
            this._setStatus(this.isJa ? 'ルールを承認しました ✅' : 'Rule approved ✅', 'success');
        } catch(e) { this._setStatus(e.body?.message ?? e.message, 'error'); }
    }

    async handleRejectRule() {
        const id = this.pendingRule?.id;
        if (!id) return;
        try {
            await rejectRule({ ruleId: id });
            this._pendingRules = this._pendingRules.filter(r => r.id !== id);
        } catch(e) { this._setStatus(e.body?.message ?? e.message, 'error'); }
    }

    handleEditRule() {
        const r = this.pendingRule;
        if (!r) return;
        this._editingRuleId   = r.id;
        this._editingRuleText = r.ruleText ?? '';
    }

    handleEditRuleInput(e) { this._editingRuleText = e.target.value; }

    async handleSaveRuleEdit() {
        try {
            await updateRuleText({ ruleId: this._editingRuleId, newText: this._editingRuleText });
            await approveRule({ ruleId: this._editingRuleId });
            this._pendingRules = this._pendingRules.filter(r => r.id !== this._editingRuleId);
            this._editingRuleId = null; this._editingRuleText = '';
            this._setStatus(this.isJa ? 'ルールを編集・承認しました ✅' : 'Rule edited and approved ✅', 'success');
        } catch(e) { this._setStatus(e.body?.message ?? e.message, 'error'); }
    }

    handleCancelEdit() { this._editingRuleId = null; this._editingRuleText = ''; }

    openSettings() { this._showSettings = true; this._loadAllRules(); }
    closeSettings() { this._showSettings = false; this._editingRuleId = null; }

    // ── Claude API key (admin) ────────────────────────────────────────────────

    handleApiKeyInput(e) {
        this._apiKeyInput = e.target.value?.trim() ?? '';
    }

    async handleSaveApiKey() {
        if (!this._apiKeyInput.startsWith('sk-ant-')) return;
        this._savingApiKey = true;
        try {
            await saveClaudeApiKey({ apiKey: this._apiKeyInput });
            this._claudeConnected = true;
            this._apiKeyInput     = '';
            this._setStatus(this.isJa ? 'Anthropic APIキーを保存しました。' : 'Anthropic API key saved.', 'success');
        } catch(e) {
            this._setStatus(e.body?.message ?? e.message, 'error');
        } finally {
            this._savingApiKey = false;
        }
    }

    async handleDisconnectClaude() {
        try {
            await disconnectClaude();
            this._claudeConnected = false;
            this._setStatus(this.isJa ? 'Claude連携を解除しました。' : 'Disconnected from Claude.', 'info');
        } catch(e) { this._setStatus(e.body?.message ?? e.message, 'error'); }
    }

    // ── Analytics creation ────────────────────────────────────────────────────

    async _doCreateAnalytics(action) {
        if (!this._claudeConnected) {
            this._analyticsIntent  = action.intent;
            this._analyticsRequest = action.analyticsRequest;
            this._analyticsResult  = null;
            this._setStatus(this.isJa
                ? 'Dashboard BuilderにはAnthropicのAPIキーが必要です。管理者に設定を依頼してください。'
                : 'Dashboard Builder requires an Anthropic API key — ask your admin to configure it in Settings.', 'warning');
            return;
        }
        this._analyticsIntent  = action.intent;
        this._analyticsRequest = action.analyticsRequest ?? action.message;
        this._analyticsResult  = null;
        this._creatingAnalytics = true;
        this._setStatus(this.isJa ? 'Claudeがレポートを生成中…' : 'Claude is generating the report…', 'info');
        try {
            const result = await createAnalytics({
                analyticsRequest: this._analyticsRequest,
                intent:           action.intent,
                sObjectType:      action.updateSObject ?? this._sObjectType ?? 'Opportunity'
            });
            this._analyticsResult  = result;
            this._creatingAnalytics = false;
            this._setStatus('', '');
        } catch(e) {
            this._creatingAnalytics = false;
            const msg = e.body?.message ?? e.message ?? '';
            if (msg === 'CLAUDE_AUTH_REQUIRED') {
                this._claudeConnected = false;
                this._setStatus(this.isJa
                    ? 'AnthropicのAPIキーが無効または期限切れです。管理者に再設定を依頼してください。'
                    : 'Anthropic API key is invalid or revoked — ask your admin to update it in Settings.', 'warning');
            } else {
                this._setStatus(msg || 'Analytics creation failed', 'error');
            }
        }
    }

    handleOpenAnalyticsReport() {
        if (this._analyticsResult?.reportUrl) {
            this[NavigationMixin.Navigate]({
                type: 'standard__webPage',
                attributes: { url: this._analyticsResult.reportUrl }
            });
        }
    }

    handleOpenAnalyticsDashboard() {
        if (this._analyticsResult?.dashboardUrl) {
            this[NavigationMixin.Navigate]({
                type: 'standard__webPage',
                attributes: { url: this._analyticsResult.dashboardUrl }
            });
        }
    }

    handleDismissAnalytics() {
        this._analyticsResult  = null;
        this._analyticsIntent  = null;
        this._analyticsRequest = null;
    }

    async handleToggleRule(e) {
        const id     = e.currentTarget.dataset.id;
        const enable = e.target.checked;
        try {
            await toggleRule({ ruleId: id, enable });
            this._allRules = this._allRules.map(r => r.id === id ? { ...r, isEnabled: enable, status: enable ? 'Approved' : 'Disabled' } : r);
        } catch(err) { this._setStatus(err.body?.message ?? err.message, 'error'); }
    }

    async handleDeleteRule(e) {
        const id = e.currentTarget.dataset.id;
        try {
            await deleteRule({ ruleId: id });
            this._allRules = this._allRules.filter(r => r.id !== id);
        } catch(err) { this._setStatus(err.body?.message ?? err.message, 'error'); }
    }

    handleStartEditModal(e) {
        const id   = e.currentTarget.dataset.id;
        const rule = this._allRules.find(r => r.id === id);
        if (rule) { this._editingRuleId = id; this._editingRuleText = rule.ruleText ?? ''; }
    }

    async handleSaveModalEdit() {
        try {
            await updateRuleText({ ruleId: this._editingRuleId, newText: this._editingRuleText });
            this._allRules = this._allRules.map(r =>
                r.id === this._editingRuleId ? { ...r, ruleText: this._editingRuleText } : r
            );
            this._editingRuleId = null; this._editingRuleText = '';
        } catch(e) { this._setStatus(e.body?.message ?? e.message, 'error'); }
    }

    // ── Quick-action chip handler ─────────────────────────────────────────────

    handleChip(e) {
        const cmd = e.currentTarget.dataset.cmd ?? '';
        this.inputText = cmd;
        const ta = this.template.querySelector('.furu-bar__textarea');
        if (ta) {
            ta.value = cmd;
            ta.style.height = 'auto';
            ta.focus();
            ta.selectionStart = ta.selectionEnd = cmd.length;
        }
        // "メモ解析 / Paste Notes" chip has empty cmd → user pastes; no auto-submit
        // other chips pre-fill but also wait for Enter
    }

    // ── Drag-and-drop / file input (Agentforce Vision OCR) ───────────────────

    handleDragOver(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        this._isDragOver = true;
    }

    handleDragLeave(e) {
        // Only clear when leaving the card itself, not a child element
        if (!e.currentTarget.contains(e.relatedTarget)) {
            this._isDragOver = false;
        }
    }

    handleDrop(e) {
        e.preventDefault();
        this._isDragOver = false;
        const file = e.dataTransfer?.files?.[0];
        if (file) this._startOcr(file);
    }

    handleFileSelect(e) {
        const file = e.target.files?.[0];
        if (file) this._startOcr(file);
        e.target.value = '';   // reset so same file can be re-selected
    }

    dismissAttachment() {
        this._attachedFileName = null;
        this._isOcrLoading     = false;
    }

    async _startOcr(file) {
        // Route CSV files to bulk import instead of OCR
        if (file.name?.toLowerCase().endsWith('.csv') || file.type === 'text/csv') {
            await this._startCsvImport(file);
            return;
        }
        const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'application/pdf'];
        if (!ALLOWED.includes(file.type)) {
            this._setStatus('対応形式: JPG · PNG · WebP · PDF · CSV', 'warning');
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            this._setStatus('ファイルサイズが上限 (5 MB) を超えています。', 'warning');
            return;
        }

        this._isOcrLoading    = true;
        this._attachedFileName = file.name;
        this._setStatus('Agentforce Vision 解析中...', 'info');

        try {
            // Read file as base64 (strip data:...;base64, prefix)
            const base64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload  = () => resolve(reader.result.split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });

            const result = await processDocumentViaAgentforce({
                base64Image:   base64,
                mimeType:      file.type,
                targetObject:  this._sObjectType ?? 'Lead',
                recordId:      this._recordId   ?? '',
            });

            if (result.errorMessage) {
                this._setStatus('OCR エラー: ' + result.errorMessage, 'error');
                return;
            }

            const fields = result.extractedFields ?? {};
            if (!Object.keys(fields).length) {
                this._setStatus('フィールドを検出できませんでした。', 'warning');
                return;
            }

            // Resolved target (Agentforce may have detected BUSINESS_CARD → Lead, etc.)
            const targetSObj   = result.targetSObject ?? this._sObjectType ?? 'Lead';
            const isUpdate     = !!(this._recordId) && targetSObj === this._sObjectType;
            const updateId     = isUpdate ? this._recordId : null;

            // Auto-bind parent if creating a child on a matching parent page
            // e.g. meeting note dropped on Account page → Opportunity inherits AccountId
            const childCfg = (CHILD_ACTIONS[this._sObjectType] ?? []).find(c => c.sObject === targetSObj);
            if (childCfg && this._recordId && !isUpdate) {
                this._parentState = {
                    field:          childCfg.field,
                    parentSObj:     this._sObjectType,
                    labelJa:        SOBJECT_LABELS_JA[this._sObjectType] ?? this._sObjectType,
                    labelEn:        this._sObjectType,
                    selectedParent: { id: this._recordId, name: this.contextLabel },
                    candidates: [], isSearching: false, autobound: true, searchText: '',
                };
            }

            this._doPrefill({
                intent:         'EXTRACT_AND_PREFILL',
                isOcr:          true,
                docType:        result.docType  ?? 'OTHER',
                confidence:     result.confidence ?? 0,
                fields,
                updateSObject:  targetSObj,
                updateRecordId: updateId,
                message:        this.isJa
                    ? `${Object.keys(fields).length} 件のフィールドを抽出しました（信頼度 ${Math.round((result.confidence ?? 0) * 100)}%）`
                    : `${Object.keys(fields).length} fields extracted (confidence ${Math.round((result.confidence ?? 0) * 100)}%)`,
            });
            this._attachedFileName = null;
        } catch (err) {
            this._setStatus('Vision OCR エラー: ' + (err.body?.message ?? err.message ?? 'Unknown'), 'error');
        } finally {
            this._isOcrLoading = false;
        }
    }

    // ── Main submit ───────────────────────────────────────────────────────────

    async handleSubmit() {
        const text = this.inputText.trim();
        if (!text || this.isLoading) return;
        this._saveRecentPrompt(text);

        this.isLoading        = true;
        this.statusMessage    = '';
        this.searchResults    = [];
        this._prefillAction   = null;
        this._guideAction     = null;
        this._insightAction   = null;
        this._knowledgeAlert  = null;
        this._addressCard     = null;

        // Fast-path: detect Japanese postal code before calling LLM
        const zipcode = extractPostalCode(text);
        if (zipcode) {
            await this._doAddressLookup(text, zipcode);
            this.isLoading = false;
            return;
        }

        try {
            const action = await processIntent({
                userInput:    text,
                sObjectType:  this._sObjectType ?? '',
                recordId:     this._recordId    ?? '',
                pageType:     this._pageType    ?? 'other',
                userLanguage: LANG ?? 'en'
            });

            if (action.errorMessage) {
                this._setStatus(action.errorMessage || 'Unknown error', 'error');
                return;
            }

            // Surface free-tier credit count from backend (FREE_TRIAL plan)
            if (action.remainingCredits != null) {
                this._remainingCredits = action.remainingCredits;
            }

            switch (action.intent) {
                case 'NAVIGATE':        await this._doNavigate(action);  break;
                case 'UPDATE_RECORD':
                    if (action.knowledgeWarnings?.length > 0) {
                        this._knowledgeAlert = action;   // pause — show learned rule alert
                    } else {
                        await this._doUpdate(action);
                    }
                    break;
                case 'PREFILL':             this._doPrefill(action); break;
                case 'EXTRACT':             this._doPrefill(action); break;
                case 'EXTRACT_AND_PREFILL': this._doPrefill(action); break;
                case 'SEARCH':         this._doSearch(action);          break;
                case 'GUIDE_CREATE':   this._doGuide(action);           break;
                case 'SOQL_SEARCH':    this._doSoqlSearch(action);      break;
                case 'ADD_FIELDS':     this._doAddFields(action);       break;
                case 'EXPLAIN_FIELD':  this._doInsight(action);         break;
                case 'EXPLAIN_FORMULA':this._doInsight(action);         break;
                case 'CREATE_REPORT':
                case 'CREATE_DASHBOARD': await this._doCreateAnalytics(action); break;
                case 'REPORT_EXPLAIN':   this._doReportExplain(action);  break;
                // UNKNOWN with a question message = model is asking for clarification
                default: {
                    const msg = action.message || (this.isJa ? 'リクエストを理解できませんでした。' : 'Could not understand request.');
                    const isQuestion = msg.endsWith('？') || msg.endsWith('?');
                    this._setStatus(msg, isQuestion ? 'info' : 'warning');
                }
            }

            this._resetInput();
        } catch (err) {
            this._setStatus('Error: ' + (err.body?.message ?? err.message ?? 'Unknown'), 'error');
        } finally {
            this.isLoading = false;
        }
    }

    // ── Intent executors ──────────────────────────────────────────────────────

    async _doNavigate(action) {
        if (action.targetRecordId) {
            this[NavigationMixin.Navigate]({
                type: 'standard__recordPage',
                attributes: { recordId: action.targetRecordId, actionName: 'view' }
            });
            this._setStatus(action.message || 'Navigating…', 'info');
        } else if (action.targetSObject) {
            this[NavigationMixin.Navigate]({
                type: 'standard__objectPage',
                attributes: { objectApiName: action.targetSObject, actionName: 'list' },
                state: { filterName: 'Recent' }
            });
            this._setStatus(action.message || `Opening ${action.targetSObject} list`, 'info');
        } else if (action.targetUrl) {
            this[NavigationMixin.Navigate]({ type: 'standard__webPage', attributes: { url: action.targetUrl } });
        } else {
            this._setStatus('Could not determine navigation target.', 'warning');
        }
    }

    async _doUpdate(action) {
        if (!action.updateRecordId || !action.fields) {
            this._setStatus('No record or fields to update.', 'warning');
            return;
        }

        const fieldNames = Object.keys(action.fields);

        let previousValues = {};
        try {
            previousValues = await getFieldSnapshot({ recordId: action.updateRecordId, fieldNames });
        } catch (_) { /* snapshot failed — undo won't appear */ }

        const fields = { Id: action.updateRecordId };
        Object.assign(fields, action.fields);

        try {
            await updateRecord({ fields });
            const baseMsg   = action.message || 'Record updated.';
            const warnSuffix = action.warningMessage ? ` ⚠️ ${action.warningMessage}` : '';
            this._setStatus(baseMsg + warnSuffix, action.warningMessage ? 'warning' : 'success');
            if (Object.keys(previousValues).length > 0) {
                this._undoSnapshot = { recordId: action.updateRecordId, fields: previousValues };
                this.showUndo = !action.warningMessage; // hide undo when showing warning
            }
        } catch (err) {
            const errMsg = err.body?.message ?? err.message ?? 'Unknown error';
            this._setStatus('Update failed: ' + errMsg, 'error');
            this._undoSnapshot = null;
            // Fire-and-forget: learn from this validation failure asynchronously
            const validationErr = errMsg.toUpperCase();
            if (validationErr.includes('VALIDATION') || validationErr.includes('REQUIRED') || validationErr.includes('INTEGRITY')) {
                learnFromValidationError({
                    sObjType:          action.updateSObject ?? this._sObjectType ?? '',
                    errorMessage:      errMsg,
                    fieldApiNamesJson: JSON.stringify(Object.keys(action.fields ?? {}))
                }).catch(() => {});
            }
        }
    }

    _doPrefill(action) {
        if (!action.fields) { this._setStatus('No fields to pre-fill.', 'warning'); return; }
        // Inject resolved parent ID into fields if the user chose / auto-bound a parent
        let fields = action.fields;
        if (this._parentState?.selectedParent?.id && !fields[this._parentState.field]) {
            fields = { ...fields, [this._parentState.field]: this._parentState.selectedParent.id };
        }
        this._prefillAction = { ...action, fields };
        publish(this._msgCtx, FuruAgentMessage, {
            action:         'PREFILL',
            sObjectType:    action.updateSObject ?? this._sObjectType,
            recordId:       action.updateRecordId ?? this._recordId,
            fields:         JSON.stringify(action.fields),
            warningMessage: action.warningMessage ?? '',
        });
        this._setStatus(action.message || 'Fields pre-filled on page.', 'info');
    }

    _doGuide(action) {
        this._guideAction = action;
        this._initParentState(action.guideSObject);
        this._setStatus(action.message || `Guide: ${action.guideSObject ?? 'object'}`, 'info');
    }

    _initParentState(guideSObject) {
        const config = PARENT_LOOKUP[guideSObject];
        if (!config) { this._parentState = null; return; }

        this._parentState = {
            field:          config.field,
            parentSObj:     config.parentSObj,
            labelJa:        config.labelJa,
            labelEn:        config.labelEn,
            selectedParent: null,
            candidates:     [],
            isSearching:    false,
            autobound:      false,
            searchText:     '',
        };

        // Auto-bind if currently on the parent object page
        if (this._sObjectType === config.parentSObj && this._recordId) {
            const label = this.isJa
                ? (SOBJECT_LABELS_JA[this._sObjectType] ?? this._sObjectType)
                : this._sObjectType;
            const displayName = this._recordId
                ? `${label}: ${this._recordId.slice(-5)}`
                : label;
            this._parentState = {
                ...this._parentState,
                selectedParent: { id: this._recordId, name: displayName },
                autobound:      true,
            };
        }
    }

    _doInsight(action) {
        this._insightAction = action;
        this._setStatus(action.message || 'Field information loaded.', 'info');
    }

    // ── SOQL Smart Search ─────────────────────────────────────────────────────

    _doSoqlSearch(action) {
        this._clearTableEditState();
        const sObj    = action.updateSObject ?? this._sObjectType ?? '';
        const records = (action.soqlRecords ?? []).filter(r => r != null);
        let conditions = [], orderBy = 'Amount DESC', limit = 20;
        try {
            const raw = JSON.parse(action.soqlFilterJson ?? '[]');
            conditions = Array.isArray(raw) ? raw : [];
        } catch (_) {}

        this._soqlQuery = {
            sObject:      sObj,
            conditions,
            orderBy,
            limit,
            selectFields: [...(SOQL_DEFAULT_FIELDS[sObj] ?? SOQL_DEFAULT_FIELDS['Opportunity'] ?? [])],
            records,
            summary:      action.message ?? '',
            isLoading:    false,
        };
        // Auto-switch to table when popped out with 4+ fields
        if (this._isWideMode && (this._soqlQuery.selectFields?.length ?? 0) >= 4) {
            this._viewMode = 'table';
        } else {
            this._viewMode = 'card';
        }
        this._setStatus(
            this.isJa ? `${records.length}件が見つかりました` : `${records.length} record(s) found`,
            'info'
        );
    }

    // ── REPORT_EXPLAIN ────────────────────────────────────────────────────────
    // Routes through FlashBarAgentforceRuntime so report data stays in Salesforce.
    _doReportExplain(action) {
        const reportId = action.reportId ?? action.target_record_id;
        if (!reportId) {
            this._setStatus(this.isJa ? 'レポートIDが見つかりません' : 'Report ID not found', 'warning');
            return;
        }
        this.isLoading = true;
        const payload = JSON.stringify({ intent: 'REPORT_EXPLAIN', reportId });
        executeJevIntent({ intentPayloadJson: payload })
            .then(result => {
                this._reportSummary = result.reportSummary;
                this._setStatus(result.message ?? (this.isJa ? 'レポートを説明しました' : 'Report explained'), 'info');
            })
            .catch(err => {
                this._setStatus('Error: ' + (err.body?.message ?? err.message ?? 'Unknown'), 'error');
            })
            .finally(() => { this.isLoading = false; });
    }

    // ── Worker KV schema seeding ──────────────────────────────────────────────
    // Seeds accessible field API names into Worker KV so SOQL template builder
    // can validate fields without calling Salesforce. One-shot per sObject per session.
    _seedWorkerKvSchema(sObjectType) {
        if (!sObjectType || this._workerKvSeeded.has(sObjectType)) return;
        this._workerKvSeeded.add(sObjectType);
        getSchemaForWorkerKv({ sObjectType })
            .then(fields => {
                if (!fields?.length) return;
                // Fire-and-forget POST to Worker /v1/schema-seed via existing Named Credential
                // The Worker caches these field names in KV (TTL 1 h) for SOQL field validation.
                // We use a non-awaited fetch here so it never blocks the main UI flow.
                const orgId = this._orgId;
                if (orgId) {
                    fetch('/services/apexrest/FuruAgent/schema-seed', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sObjectType, fieldApiNames: fields }),
                    }).catch(() => {});
                }
            })
            .catch(() => {});
    }

    async _doAddFields(action) {
        if (!this._soqlQuery) {
            this._setStatus(this.isJa ? '先に検索を実行してください。' : 'Run a search first.', 'warning');
            return;
        }
        const newApiNames = action.fieldsToAdd ?? action.fields_to_add ?? [];
        if (!newApiNames.length) return;

        const sObj   = this._soqlQuery.sObject;
        const schema = SOQL_DEFAULT_FIELDS[sObj] ?? SOQL_DEFAULT_FIELDS['Opportunity'] ?? [];
        const schemaMap = new Map(schema.map(f => [f.apiName, f]));

        // Merge new fields — skip ones already selected
        const existingApis = new Set(this._soqlQuery.selectFields.map(f => f.apiName));
        const toAdd = newApiNames
            .filter(a => !existingApis.has(a))
            .map(a => schemaMap.get(a) ?? { apiName: a, label: a, labelEn: a, isNew: true });

        if (!toAdd.length) {
            this._setStatus(this.isJa ? '対象フィールドはすでに表示されています。' : 'Fields already shown.', 'info');
            return;
        }

        const mergedFields = [...this._soqlQuery.selectFields, ...toAdd];
        this._soqlQuery = { ...this._soqlQuery, selectFields: mergedFields, isLoading: true };

        try {
            const records = await executeSoqlQuery({
                sObjectType:       sObj,
                conditionsJson:    JSON.stringify(this._soqlQuery.conditions),
                selectApiNamesJson: JSON.stringify(mergedFields.map(f => f.apiName)),
                orderBy:           this._soqlQuery.orderBy,
                maxRows:           this._soqlQuery.limit,
            });
            this._soqlQuery = { ...this._soqlQuery, records, isLoading: false,
                summary: action.message ?? this._soqlQuery.summary };
            this._setStatus(
                this.isJa ? `${toAdd.length}件の項目を追加しました` : `Added ${toAdd.length} field(s)`,
                'success'
            );
        } catch (err) {
            this._soqlQuery = { ...this._soqlQuery, isLoading: false };
            this._setStatus(err.body?.message ?? err.message ?? 'Query failed', 'error');
        }
    }

    async handleRemoveSoqlField(e) {
        const apiName = e.currentTarget.dataset.api;
        if (!this._soqlQuery) return;
        const remaining = this._soqlQuery.selectFields.filter(f => f.apiName !== apiName);
        if (!remaining.length) return;  // must keep at least one field
        this._soqlQuery = { ...this._soqlQuery, selectFields: remaining, isLoading: true };
        try {
            const records = await executeSoqlQuery({
                sObjectType:       this._soqlQuery.sObject,
                conditionsJson:    JSON.stringify(this._soqlQuery.conditions),
                selectApiNamesJson: JSON.stringify(remaining.map(f => f.apiName)),
                orderBy:           this._soqlQuery.orderBy,
                maxRows:           this._soqlQuery.limit,
            });
            this._soqlQuery = { ...this._soqlQuery, records, isLoading: false };
        } catch (err) {
            this._soqlQuery = { ...this._soqlQuery, isLoading: false };
            this._setStatus(err.body?.message ?? err.message ?? 'Query failed', 'error');
        }
    }

    dismissSoqlResults() { this._soqlQuery = null; this._clearTableEditState(); }

    // ── Mass Editor ───────────────────────────────────────────────────────────

    handleOpenMassEditor() {
        if (this._soqlQuery?.records?.length) this._showMassEditor = true;
    }

    handleMassEditorClose(e) {
        this._showMassEditor = false;
        if (e?.detail?.savedCount > 0) {
            this._setStatus(`${e.detail.savedCount}件を一括保存しました`, 'success');
        }
    }

    get massEditorFieldNames() {
        return (this._soqlQuery?.selectFields ?? []).map(f => f.apiName);
    }

    get massEditorRecords() {
        return this._soqlQuery?.records ?? [];
    }

    // ── Navigation hub ────────────────────────────────────────────────────────

    handleNavItemClick(e) {
        const id = e.currentTarget.dataset.id;
        const item = this._navItems.find(n => n.Id === id);
        if (!item) return;
        if (item.Target_Type__c === 'ListEditor') {
            try {
                const saved = JSON.parse(item.Target_SOQL_Filter__c ?? '{}');
                if (saved.sObject) this._runSoqlFromSaved(saved);
            } catch (_) {
                this._setStatus(this.isJa ? 'クエリ読み込みエラー' : 'Query parse error', 'error');
            }
        } else if (item.Target_Type__c === 'Page' && item.Target_URL_Page__c) {
            this[NavigationMixin.Navigate]({
                type: 'standard__webPage',
                attributes: { url: item.Target_URL_Page__c },
            });
        }
    }

    async handleDeleteNavItem(e) {
        const id = e.currentTarget.dataset.id;
        const prev = this._navItems;
        this._navItems = this._navItems.filter(n => n.Id !== id);
        try {
            await deleteNavItem({ itemId: id });
        } catch (err) {
            this._navItems = prev;
            this._setStatus(err.body?.message ?? (this.isJa ? '削除エラー' : 'Delete failed'), 'error');
        }
    }

    handleOpenPinDialog() {
        if (!this._soqlQuery?.records?.length) return;
        this._pinLabel    = this._soqlQuery.summary ?? '';
        this._pinDialogOpen = true;
    }

    handlePinLabelChange(e) {
        this._pinLabel = e.target.value;
    }

    handleClosePinDialog() {
        this._pinDialogOpen = false;
        this._pinLabel      = '';
    }

    async handlePinSave() {
        if (!this._pinLabel.trim() || !this._soqlQuery) return;
        this._pinSaving = true;
        try {
            const saved = {
                name:         this._pinLabel.trim(),
                sObject:      this._soqlQuery.sObject,
                conditions:   this._soqlQuery.conditions,
                orderBy:      this._soqlQuery.orderBy,
                limit:        this._soqlQuery.limit,
                selectFields: this._soqlQuery.selectFields,
                useCount:     0,
            };
            const newItem = await pinQuery({
                label:    this._pinLabel.trim(),
                soqlJson: JSON.stringify(saved),
                iconName: '📌',
            });
            this._navItems = [...this._navItems, JSON.parse(JSON.stringify(newItem))];
            this._pinDialogOpen = false;
            this._pinLabel      = '';
            this._setStatus(
                this.isJa ? `✅「${saved.name}」をナビゲーションに追加しました` : `✅ Pinned "${saved.name}"`,
                'success'
            );
        } catch (err) {
            this._setStatus(err.body?.message ?? (this.isJa ? 'ピン留めエラー' : 'Pin failed'), 'error');
        } finally {
            this._pinSaving = false;
        }
    }

    // ── Inline table edit mode ────────────────────────────────────────────────

    _clearTableEditState() {
        this._tableEditMode      = false;
        this._tableDraftMap      = {};
        this._tableSchema        = {};
        this._tableErrors        = {};
        this._tableSaved         = {};
    }

    async handleToggleTableEdit() {
        if (this._tableEditMode) {
            this._tableEditMode = false;
            this._tableDraftMap = {};
            this._tableErrors   = {};
            this._tableSaved    = {};
            return;
        }
        if (Object.keys(this._tableSchema).length === 0) {
            this._tableSchemaLoading = true;
            try {
                const fieldNames = (this._soqlQuery?.selectFields ?? []).map(f => f.apiName);
                const raw = await getEditSchema({
                    sObjectType: this._soqlQuery?.sObject ?? '',
                    fieldsJson:  JSON.stringify(fieldNames),
                });
                const schemaMap = {};
                JSON.parse(JSON.stringify(raw)).forEach(col => { schemaMap[col.apiName] = col; });
                this._tableSchema = schemaMap;
            } catch (e) {
                this._setStatus(
                    this.isJa
                        ? 'スキーマ読み込みエラー: ' + (e.body?.message ?? e.message ?? '')
                        : 'Schema load error: ' + (e.body?.message ?? e.message ?? ''),
                    'error'
                );
                return;
            } finally {
                this._tableSchemaLoading = false;
            }
        }
        this._tableEditMode = true;
    }

    handleTableCellChange(e) {
        const recordId = e.target.dataset.recordId;
        const apiName  = e.target.dataset.apiName;
        if (!recordId || !apiName) return;
        const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
        const prev = this._tableDraftMap[recordId] ?? {};
        this._tableDraftMap = { ...this._tableDraftMap, [recordId]: { ...prev, [apiName]: val } };
    }

    handleTableDiscard() {
        this._tableDraftMap = {};
        this._tableErrors   = {};
        this._tableSaved    = {};
    }

    async handleTableSave() {
        const dirtyIds = Object.keys(this._tableDraftMap);
        if (!dirtyIds.length) return;
        const recordsToSave = dirtyIds.map(id => ({ Id: id, ...this._tableDraftMap[id] }));
        this._tableSaving = true;
        try {
            const result = await updateMassiveRecords({
                sObjectType: this._soqlQuery?.sObject ?? '',
                recordsJson: JSON.stringify(recordsToSave),
            });
            const saved = {};
            (result.successIds ?? []).forEach(id => { saved[id] = true; });
            this._tableSaved = saved;
            const errors = {};
            (result.errors ?? []).forEach(e => { errors[e.recordId] = e.errorMessage; });
            this._tableErrors = errors;
            const newDraft = { ...this._tableDraftMap };
            (result.successIds ?? []).forEach(id => { delete newDraft[id]; });
            this._tableDraftMap = newDraft;
            const savedCount = (result.successIds ?? []).length;
            const errCount   = (result.errors ?? []).length;
            if (errCount === 0) {
                this._setStatus(
                    this.isJa ? `✅ ${savedCount}件を保存しました` : `✅ Saved ${savedCount} record(s)`,
                    'success'
                );
            } else {
                this._setStatus(
                    this.isJa
                        ? `⚠️ ${savedCount}件成功、${errCount}件エラー`
                        : `⚠️ ${savedCount} saved, ${errCount} error(s)`,
                    'warning'
                );
            }
        } catch (e) {
            this._setStatus(e.body?.message ?? (this.isJa ? '保存エラー' : 'Save failed'), 'error');
        } finally {
            this._tableSaving = false;
        }
    }

    handleSoqlRecordNavigate(e) {
        const id = e.currentTarget.dataset.id;
        if (!id) return;
        this[NavigationMixin.Navigate]({ type: 'standard__recordPage', attributes: { recordId: id, actionName: 'view' } });
    }

    handleSoqlCommandInject(e) {
        const cmd = e.currentTarget.dataset.cmd ?? '';
        this.inputText = cmd;
        const ta = this.template.querySelector('.furu-bar__textarea');
        if (ta) { ta.value = cmd; ta.style.height = 'auto'; ta.focus(); ta.selectionStart = ta.selectionEnd = cmd.length; }
    }

    handleSoqlExport() {
        if (!this._soqlQuery?.records?.length) return;
        const { records, selectFields } = this._soqlQuery;
        const isJa = this.isJa;

        const esc = (v) => {
            if (v == null) return '';
            const s = String(v);
            return (s.includes(',') || s.includes('"') || s.includes('\n'))
                ? '"' + s.replace(/"/g, '""') + '"' : s;
        };

        const headers = selectFields.map(f => isJa ? f.label : f.labelEn);
        const lines = [
            headers.map(esc).join(','),
            ...records.map(rec =>
                selectFields.map(f => esc(rec[f.apiName] ?? '')).join(',')
            ),
        ];

        try {
            const csv = '﻿' + lines.join('\r\n');
            const b64 = btoa(unescape(encodeURIComponent(csv)));
            const href = `data:text/csv;charset=utf-8;base64,${b64}`;
            const a = document.createElement('a');
            a.href = href;
            a.download = this.soqlExportFileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        } catch (_) {
            this._setStatus(this.isJa ? 'CSVエクスポートに失敗しました。' : 'Export failed.', 'error');
        }
    }

    // ── Parent-record lookup handlers ─────────────────────────────────────────

    handleParentSearchInput(e) {
        this._parentState = { ...this._parentState, searchText: e.target.value };
    }

    handleParentSearchKeydown(e) {
        if (e.key === 'Enter') { e.preventDefault(); this._runParentSearch(); }
    }

    handleParentSearch() { this._runParentSearch(); }

    async _runParentSearch() {
        const term = (this._parentState?.searchText ?? '').trim();
        if (!this._parentState || !term) return;
        this._parentState = { ...this._parentState, isSearching: true, candidates: [] };
        try {
            const results = await searchParentRecords({
                parentSObjectType: this._parentState.parentSObj,
                searchTerm:        term,
            });
            this._parentState = { ...this._parentState, isSearching: false, candidates: results ?? [] };
        } catch (e) {
            this._parentState = { ...this._parentState, isSearching: false };
            this._setStatus((e.body?.message ?? e.message ?? 'Search failed'), 'error');
        }
    }

    handleSelectParent(e) {
        const id   = e.currentTarget.dataset.id;
        const name = e.currentTarget.dataset.name;
        this._parentState = { ...this._parentState, selectedParent: { id, name }, candidates: [], autobound: false, searchText: '' };
    }

    handleClearParent() {
        this._parentState = { ...this._parentState, selectedParent: null, candidates: [], autobound: false, searchText: '' };
    }

    // ── Japanese address lookup ───────────────────────────────────────────────

    async _doAddressLookup(rawText, zipcode) {
        try {
            const addr = await getJapaneseAddress({ zipcode });
            if (!addr) {
                this._setStatus('郵便番号が見つかりませんでした。', 'warning');
                return;
            }
            const streetTail = extractAddressTail(rawText, addr);
            this._addressCard = { ...addr, streetTail, rawText };
            this._setStatus(`〒${addr.postalCode} — ${addr.prefecture}${addr.city}${addr.town}`, 'info');
            this._resetInput();
        } catch (err) {
            this._setStatus('住所検索エラー: ' + (err.body?.message ?? err.message ?? 'Unknown'), 'error');
        }
    }

    async handleAddressConfirm() {
        if (!this._addressCard) return;
        const fields = mapAddressToFields(
            this._addressCard,
            this._sObjectType ?? 'Account',
            this._addressCard.streetTail ?? ''
        );
        if (!Object.keys(fields).length) {
            this._setStatus('このオブジェクトには住所フィールドがありません。', 'warning');
            this._addressCard = null;
            return;
        }
        if (this._recordId) {
            await this._doUpdate({ intent: 'UPDATE_RECORD', updateRecordId: this._recordId, updateSObject: this._sObjectType, fields, message: '住所を保存しました。' });
        } else {
            this._doPrefill({ intent: 'PREFILL', updateSObject: this._sObjectType, fields, message: '住所を入力フォームに反映しました。' });
        }
        this._addressCard = null;
    }

    dismissAddressCard() {
        this._addressCard = null;
        this.dismissStatus();
    }

    // ── Knowledge alert (learned rules — blocks DML until confirmed) ──────────

    async handleKnowledgeProceed() {
        const action = this._knowledgeAlert;
        this._knowledgeAlert = null;
        await this._doUpdate(action);
    }

    dismissKnowledgeAlert() {
        this._knowledgeAlert = null;
        this._setStatus('Update cancelled.', 'info');
    }

    _doSearch(action) {
        const results = action.searchResults ?? [];
        if (!results.length) { this._setStatus('No records found.', 'info'); return; }
        this.searchResults = results.map(r => ({
            ...r,
            sub: r.Email ?? r.Phone ?? r.StageName ?? r.Status ?? ''
        }));
        this._setStatus(`${results.length} ${this.i18n.results}`, 'info');
    }

    // ── Search result navigation ──────────────────────────────────────────────

    handleResultClick(e) {
        const id = e.currentTarget.dataset.id;
        if (!id) return;
        this[NavigationMixin.Navigate]({
            type: 'standard__recordPage',
            attributes: { recordId: id, actionName: 'view' }
        });
        this.dismissResults();
    }

    // ── Pre-fill save / discard ───────────────────────────────────────────────

    async handleSavePrefill() {
        if (!this._prefillAction) return;
        const action = this._prefillAction;
        if (action.updateRecordId) {
            await this._doUpdate({ ...action, intent: 'UPDATE_RECORD' });
        } else {
            await this._doCreate(action);
        }
        this._prefillAction = null;
        publish(this._msgCtx, FuruAgentMessage, { action: 'CLEAR', sObjectType: '', recordId: '', fields: '' });
    }

    async _doCreate(action) {
        const sObj   = action.updateSObject ?? 'Lead';
        const fields = action.fields ?? {};
        this._ocrImporting = true;
        try {
            const newId = await importOcrToRecord({
                sObjectApiName: sObj,
                fieldsJson:     JSON.stringify(fields),
                recordId:       '',
            });
            const label = this.isJa
                ? `✅ ${SOBJECT_LABELS_JA[sObj] ?? sObj} を作成しました`
                : `✅ ${sObj} created`;
            this._setStatus(label, 'success');
            this[NavigationMixin.Navigate]({
                type:       'standard__recordPage',
                attributes: { recordId: newId, actionName: 'view' },
            });
        } catch (err) {
            this._setStatus('Import failed: ' + (err.body?.message ?? err.message), 'error');
        } finally {
            this._ocrImporting = false;
        }
    }

    handleOcrTargetSwitch(e) {
        const sObj = e.currentTarget.dataset.sobject;
        if (!sObj || !this._prefillAction) return;
        this._prefillAction = { ...this._prefillAction, updateSObject: sObj, updateRecordId: null };
    }

    handleChildActionChip(e) {
        const sObject = e.currentTarget.dataset.sobject;
        const field   = e.currentTarget.dataset.field;
        if (!sObject) return;
        this._doGuide({ guideSObject: sObject });
        if (field && this._recordId) {
            this._parentState = {
                field:          field,
                parentSObj:     this._sObjectType,
                labelJa:        SOBJECT_LABELS_JA[this._sObjectType] ?? this._sObjectType,
                labelEn:        this._sObjectType,
                selectedParent: { id: this._recordId, name: this.contextLabel },
                candidates: [], isSearching: false, autobound: true, searchText: '',
            };
        }
    }

    dismissPrefill() {
        this._prefillAction = null;
        this._parentState   = null;
        publish(this._msgCtx, FuruAgentMessage, { action: 'CLEAR', sObjectType: '', recordId: '', fields: '' });
    }

    // ── Undo ─────────────────────────────────────────────────────────────────

    async handleUndo() {
        if (!this._undoSnapshot) return;
        const fields = { Id: this._undoSnapshot.recordId, ...this._undoSnapshot.fields };
        try {
            await updateRecord({ fields });
            this._setStatus('Undone — record restored to previous values.', 'success');
        } catch (err) {
            this._setStatus('Undo failed: ' + (err.body?.message ?? err.message), 'error');
        }
        this.showUndo     = false;
        this._undoSnapshot = null;
    }

    // ── CSV bulk import ───────────────────────────────────────────────────────

    // Getters
    get hasCsvImport()    { return this._csvState !== null; }
    get csvFileName()     { return this._csvState?.fileName ?? ''; }
    get csvTotalRows()    { return this._csvState?.rows?.length ?? 0; }
    get csvMappings()     { return this._csvState?.mappings ?? []; }
    get csvPhase()        { return this._csvState?.phase ?? 'idle'; }
    get csvIsMappingPhase()  { return this._csvState?.phase === 'mapping'; }
    get csvIsPreviewPhase()  { return this._csvState?.phase === 'preview'; }
    get csvIsImportingPhase(){ return this._csvState?.phase === 'importing'; }
    get csvIsDonePhase()     { return this._csvState?.phase === 'done'; }
    get csvResult()          { return this._csvState?.result ?? null; }
    get csvInserted()        { return this._csvState?.result?.totalInserted ?? 0; }
    get csvFailed()          { return this._csvState?.result?.totalFailed ?? 0; }
    get csvErrors()          { return this._csvState?.result?.errors ?? []; }
    get csvProgress()        { return this._csvState?.progress ?? 0; }
    get csvMappedCount()     { return this.csvMappings.filter(m => m.sfApiName).length; }
    get csvUnmappedCount()   { return this.csvMappings.filter(m => !m.sfApiName).length; }
    get csvHasUnmapped()     { return this.csvUnmappedCount > 0; }

    get csvMappingRows() {
        return (this._csvState?.mappings ?? []).map((m, i) => {
            const isMapped = !!m.sfApiName;
            return {
                ...m,
                idx:           String(i),
                displaySf:     m.sfApiName ?? (this.isJa ? '— 未マッピング —' : '— Unmapped —'),
                transformLabel: this._csvTransformLabel(m.transform),
                isMapped,
                sfClass:       isMapped
                    ? 'furu-bar__csv-map-sf'
                    : 'furu-bar__csv-map-sf furu-bar__csv-map-sf--none',
                confidencePct: Math.round((m.confidence ?? 0) * 100),
            };
        });
    }

    _csvTransformLabel(t) {
        if (!t || t === 'none') return '';
        const map = {
            fullwidth_to_half: this.isJa ? '全→半角変換' : 'Full→Half width',
            normalize_phone:   this.isJa ? '電話正規化' : 'Phone format',
            normalize_postal:  this.isJa ? '郵便番号正規化' : 'Postal normalize',
            date_format:       this.isJa ? '日付変換' : 'Date format',
        };
        return map[t] ?? t;
    }

    get csvProgressLabel() {
        if (!this._csvState) return '';
        const p = this._csvState.progress ?? 0;
        const total = this._csvState.rows?.length ?? 0;
        return this.isJa
            ? `${p} / ${total} 件を処理中...`
            : `Processing ${p} / ${total} records…`;
    }

    // Handlers
    dismissCsvImport() {
        this._csvState        = null;
        this._csvDownloadHref = null;
        this._csvRowStatuses  = [];
    }

    async _startCsvImport(file) {
        this._csvState        = { phase: 'mapping', fileName: file.name, headers: [], rows: [], mappings: [], result: null, progress: 0 };
        this._csvDownloadHref = null;
        this._csvRowStatuses  = [];
        this._setStatus(this.isJa ? 'CSVを解析中...' : 'Parsing CSV…', 'info');
        try {
            const text = await file.text();
            const { headers, rows } = parseCsv(text);
            if (!headers.length) {
                this._setStatus('CSV ヘッダーが見つかりません。', 'error');
                this._csvState = null;
                return;
            }
            // All mapping runs client-side — no raw CSV bytes are sent to any server
            const mappings = this._clientSideCsvMap(headers);
            this._csvState = { ...this._csvState, phase: 'preview', headers, rows, mappings };
            this._setStatus(
                this.isJa
                    ? `${rows.length}件を検出。マッピングを確認してください。`
                    : `${rows.length} records detected. Review mapping below.`,
                'info'
            );
        } catch (err) {
            this._setStatus('CSV解析エラー: ' + (err.message ?? 'Unknown'), 'error');
            this._csvState = null;
        }
    }

    _clientSideCsvMap(headers) {
        // Lightweight client-side fallback mapping dictionary
        const DICT = {
            '会社名': 'Name', '社名': 'Name', '取引先名': 'Name', '顧客名': 'Name',
            '氏名': 'LastName', '姓': 'LastName', '名': 'FirstName',
            '電話': 'Phone', '電話番号': 'Phone', 'tel': 'Phone',
            'メール': 'Email', 'メールアドレス': 'Email', 'email': 'Email',
            '郵便番号': 'BillingPostalCode', '都道府県': 'BillingState',
            '市区町村': 'BillingCity', '住所': 'BillingStreet',
            '業種': 'Industry', '従業員数': 'NumberOfEmployees',
            '備考': 'Description', 'メモ': 'Description',
            '役職': 'Title', '部署': 'Department',
            '商談名': 'Name', '金額': 'Amount', '完了予定日': 'CloseDate',
            'フェーズ': 'StageName', 'name': 'Name', 'company': 'Name',
        };
        // Context-aware overrides: parent name columns → lookup ID fields
        // Apex auto-resolves non-ID strings via SOQL name lookup before DML
        const CTX_OVERRIDE = {
            Opportunity: { '取引先名': 'AccountId', '会社名': 'AccountId' },
            Contact:     { '取引先名': 'AccountId', '会社名': 'AccountId' },
            Case:        { '取引先名': 'AccountId', '会社名': 'AccountId' },
        };
        const ctxMap = CTX_OVERRIDE[this._sObjectType] ?? {};
        const TRANSFORMS = {
            'BillingPostalCode': 'normalize_postal', 'Phone': 'normalize_phone',
            'MobilePhone': 'normalize_phone', 'Fax': 'normalize_phone',
            'CloseDate': 'date_format', 'Amount': 'fullwidth_to_half',
        };
        return headers.map(h => {
            const key   = h.trim().toLowerCase().replace(/[　\s]+/g, '');
            const sfApi = ctxMap[h.trim()] ?? DICT[key] ?? DICT[h.trim()] ?? null;
            return {
                csvHeader:  h,
                sfApiName:  sfApi,
                confidence: sfApi ? 0.85 : 0,
                transform:  sfApi ? (TRANSFORMS[sfApi] ?? 'none') : 'none',
            };
        });
    }

    async handleCsvImport() {
        if (!this._csvState?.rows?.length) return;
        const { rows, headers, mappings } = this._csvState;
        const sObj = this._sObjectType;
        if (!sObj) {
            this._setStatus(this.isJa ? 'オブジェクトが特定できません。' : 'Cannot determine sObject.', 'warning');
            return;
        }

        // Build records client-side (transform stays in browser, no raw CSV to server)
        const records = buildRecords(headers, rows, mappings);
        const BATCH = 200;
        let inserted = 0, failed = 0;
        const allErrors = [];
        // allRowStatuses[i] corresponds to rows[i] (0-based data index)
        const allRowStatuses = new Array(rows.length).fill(null).map(() => ({ status: 'NG', error: '未処理' }));

        this._csvState = { ...this._csvState, phase: 'importing', progress: 0 };

        for (let i = 0; i < records.length; i += BATCH) {
            const chunk = records.slice(i, i + BATCH);
            try {
                const res = await bulkImportCsv({
                    sObjectType:     sObj,
                    recordsJson:     JSON.stringify(chunk),
                    externalIdField: null,
                });
                inserted += res.totalInserted ?? 0;
                failed   += res.totalFailed   ?? 0;
                allErrors.push(...(res.errors ?? []));
                // Map Apex per-row results back to absolute row indices
                for (const rr of (res.rowResults ?? [])) {
                    // Apex csvRow is 1-based within the chunk (row 2 = first data row)
                    const absIdx = i + (rr.csvRow - 2);
                    if (absIdx >= 0 && absIdx < allRowStatuses.length) {
                        allRowStatuses[absIdx] = { status: rr.status, error: rr.error ?? null };
                    }
                }
            } catch (err) {
                // Mark all rows in this chunk as failed
                for (let k = i; k < Math.min(i + BATCH, rows.length); k++) {
                    allRowStatuses[k] = { status: 'NG', error: err.body?.message ?? err.message ?? 'Unknown' };
                }
                failed += chunk.length;
                allErrors.push({ row: i + 2, message: err.body?.message ?? err.message ?? 'Unknown' });
            }
            this._csvState = { ...this._csvState, progress: Math.min(i + BATCH, records.length) };
        }

        this._csvRowStatuses = allRowStatuses;
        this._csvState = {
            ...this._csvState,
            phase:  'done',
            result: { totalInserted: inserted, totalFailed: failed, errors: allErrors.slice(0, 50) },
        };
        this._buildCsvDownloadHref(headers, rows);
        this._setStatus(
            this.isJa
                ? `✅ ${inserted}件登録完了${failed ? ` / ⚠️ ${failed}件エラー` : ''}`
                : `✅ ${inserted} imported${failed ? ` / ⚠️ ${failed} failed` : ''}`,
            failed ? 'warning' : 'success'
        );
    }

    get csvDownloadFileName() {
        const base = (this._csvState?.fileName ?? 'import').replace(/\.csv$/i, '');
        return `${base}_result.csv`;
    }

    _buildCsvDownloadHref(headers, rows) {
        const statuses  = this._csvRowStatuses;
        const statusCol = this.isJa ? 'インポート結果' : 'Import_Status';
        const errorCol  = this.isJa ? 'エラー内容' : 'Error_Message';

        const esc = (v) => {
            if (v == null) return '';
            const s = String(v);
            return (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
                ? '"' + s.replace(/"/g, '""') + '"'
                : s;
        };

        const lines = [
            [...headers, statusCol, errorCol].map(esc).join(','),
            ...rows.map((row, i) => {
                const st = statuses[i] ?? { status: 'NG', error: '未処理' };
                return [...row.map(cell => esc(cell ?? '')), esc(st.status), esc(st.error ?? '')].join(',');
            }),
        ];

        try {
            // Prepend UTF-8 BOM so Japanese Excel opens correctly
            const csv = '﻿' + lines.join('\r\n');
            const b64 = btoa(unescape(encodeURIComponent(csv)));
            this._csvDownloadHref = `data:text/csv;charset=utf-8;base64,${b64}`;
        } catch (_) {
            this._csvDownloadHref = null;
        }
    }

    // ── Schema cache admin ────────────────────────────────────────────────────

    async handleRefreshSchemaCache() {
        if (!this._sObjectType) {
            this._setStatus(this.isJa ? 'オブジェクトが特定できません。' : 'No object context.', 'warning');
            return;
        }
        this._refreshingCache = true;
        try {
            await refreshSchemaCache({ sObjApiName: this._sObjectType });
            this._setStatus(
                this.isJa
                    ? `✅ ${this._sObjectType} のメタデータキャッシュを更新しました`
                    : `✅ Schema cache refreshed for ${this._sObjectType}`,
                'success'
            );
        } catch (e) {
            this._setStatus(e.body?.message ?? 'Cache refresh failed', 'error');
        } finally {
            this._refreshingCache = false;
        }
    }

    // ── UI helpers ────────────────────────────────────────────────────────────

    _setStatus(msg, type = 'info') {
        this.statusMessage = msg;
        this.statusType    = type;
        this.showUndo      = false;
        if (type === 'error') {
            this.dispatchEvent(new ShowToastEvent({ title: 'FlashBar', message: msg, variant: 'error' }));
        }
    }

    dismissStatus()  { this.statusMessage = ''; this.showUndo = false; }
    dismissResults() { this.searchResults = []; }
    dismissGuide()          { this._guideAction = null; this._parentState = null; }
    dismissInsight()        { this._insightAction = null; }
    dismissKnowledgeAlert() { this._knowledgeAlert = null; }
}

