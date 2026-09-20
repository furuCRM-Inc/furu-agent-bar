import { LightningElement, track, wire } from 'lwc';
import { CurrentPageReference, NavigationMixin } from 'lightning/navigation';
import { updateRecord }   from 'lightning/uiRecordApi';
import { publish, MessageContext } from 'lightning/messageService';
import { ShowToastEvent }  from 'lightning/platformShowToastEvent';
import FuruAgentMessage    from '@salesforce/messageChannel/FuruAgentMessage__c';
import processIntent       from '@salesforce/apex/FuruAgentController.processIntent';

// Detect sObject from standard page reference types
const PAGE_RECORD_TYPES  = new Set(['standard__recordPage', 'standard__objectPage']);
const SOBJECT_FROM_URL   = () => {
    const parts = window.location.pathname.split('/');
    // Lightning URL pattern: /lightning/r/Account/001.../view
    const idx = parts.indexOf('r');
    return idx !== -1 ? parts[idx + 1] : null;
};

export default class FuruAgentBar extends NavigationMixin(LightningElement) {

    // ── Page context ──────────────────────────────────────────────────────────
    @wire(CurrentPageReference)
    wiredPage(ref) {
        this._pageRef = ref;
        if (!ref) return;
        const attrs = ref.attributes ?? {};
        this._recordId   = attrs.recordId   ?? null;
        this._sObjectType = attrs.objectApiName ?? SOBJECT_FROM_URL() ?? null;
        this._pageType   = ref.type ?? 'other';
    }

    @wire(MessageContext) _msgCtx;

    // ── State ─────────────────────────────────────────────────────────────────
    @track inputText     = '';
    @track isLoading     = false;
    @track statusMessage = '';
    @track statusType    = 'info';   // 'success' | 'error' | 'info' | 'warning'
    @track showUndo      = false;
    @track searchResults = [];
    @track _prefillAction = null;    // pending prefill waiting for Save/Discard

    _recordId    = null;
    _sObjectType = null;
    _pageType    = 'other';
    _lastUpdate  = null;   // { recordId, fields } for undo

    // ── Getters ───────────────────────────────────────────────────────────────

    get contextLabel() {
        if (this._sObjectType && this._recordId) return `${this._sObjectType} · ${this._recordId.slice(-5)}`;
        if (this._sObjectType) return this._sObjectType;
        return '';
    }

    get statusClass() {
        return `furu-bar__status furu-bar__status--${this.statusType}`;
    }

    get statusIcon() {
        return { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' }[this.statusType] ?? 'ℹ️';
    }

    get hasResults()  { return this.searchResults.length > 0; }
    get resultCount() { return this.searchResults.length; }
    get hasPrefill()  { return this._prefillAction !== null; }

    get prefillSummary() {
        if (!this._prefillAction?.fields) return '';
        const entries = Object.entries(this._prefillAction.fields);
        return entries.map(([k, v]) => `${k}: ${v}`).join(' · ');
    }

    // ── Input handlers ────────────────────────────────────────────────────────

    handleInput(e)   { this.inputText = e.target.value; }

    handleKeyDown(e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.handleSubmit(); }
        if (e.key === 'Escape') { this.inputText = ''; this.dismissStatus(); this.dismissResults(); }
    }

    // ── Main submit ───────────────────────────────────────────────────────────

    async handleSubmit() {
        const text = this.inputText.trim();
        if (!text || this.isLoading) return;

        this.isLoading     = true;
        this.statusMessage = '';
        this.searchResults = [];
        this._prefillAction = null;

        try {
            const action = await processIntent({
                userInput:   text,
                sObjectType: this._sObjectType ?? '',
                recordId:    this._recordId    ?? '',
                pageType:    this._pageType    ?? 'other'
            });

            if (action.errorMessage) {
                this._setStatus(action.errorMessage || 'Unknown error', 'error');
                return;
            }

            switch (action.intent) {
                case 'NAVIGATE':     await this._doNavigate(action);     break;
                case 'UPDATE_RECORD':await this._doUpdate(action);       break;
                case 'PREFILL':      this._doPrefill(action);            break;
                case 'SEARCH':       this._doSearch(action);             break;
                default:             this._setStatus(action.message || 'Could not understand request.', 'warning');
            }

            this.inputText = '';
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
                attributes: {
                    recordId:    action.targetRecordId,
                    actionName: 'view'
                }
            });
            this._setStatus(action.message || `Navigating…`, 'info');
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

        const fields = { Id: action.updateRecordId };
        Object.assign(fields, action.fields);

        // Store for undo
        this._lastUpdate = { recordId: action.updateRecordId, fields: action.fields };

        try {
            await updateRecord({ fields });
            this._setStatus(action.message || 'Record updated.', 'success');
            this.showUndo = true;
        } catch (err) {
            this._setStatus('Update failed: ' + (err.body?.message ?? err.message), 'error');
            this._lastUpdate = null;
        }
    }

    _doPrefill(action) {
        if (!action.fields) { this._setStatus('No fields to pre-fill.', 'warning'); return; }

        this._prefillAction = action;

        // Broadcast to any page-side LWC subscribers via LMS
        publish(this._msgCtx, FuruAgentMessage, {
            action:      'PREFILL',
            sObjectType: action.updateSObject ?? this._sObjectType,
            recordId:    action.updateRecordId ?? this._recordId,
            fields:      JSON.stringify(action.fields)
        });

        this._setStatus(action.message || 'Fields pre-filled on page.', 'info');
    }

    _doSearch(action) {
        const results = action.searchResults ?? [];
        if (!results.length) {
            this._setStatus('No records found.', 'info');
            return;
        }
        // Enrich with sub-label
        this.searchResults = results.map(r => ({
            ...r,
            sub: r.Email ?? r.Phone ?? r.StageName ?? r.Status ?? ''
        }));
        this._setStatus(`${results.length} result(s) found`, 'info');
    }

    // ── Result navigation ─────────────────────────────────────────────────────

    handleResultClick(e) {
        const id   = e.currentTarget.dataset.id;
        const type = e.currentTarget.dataset.type;
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
        await this._doUpdate({ ...this._prefillAction, intent: 'UPDATE_RECORD' });
        this._prefillAction = null;

        // Tell page-side subscribers to clear highlights
        publish(this._msgCtx, FuruAgentMessage, {
            action: 'CLEAR', sObjectType: '', recordId: '', fields: ''
        });
    }

    dismissPrefill() {
        this._prefillAction = null;
        publish(this._msgCtx, FuruAgentMessage, {
            action: 'CLEAR', sObjectType: '', recordId: '', fields: ''
        });
    }

    // ── Undo last update ──────────────────────────────────────────────────────

    async handleUndo() {
        if (!this._lastUpdate) return;
        // Revert by re-applying previous values (LDS doesn't have a built-in undo)
        // For now show a toast instructing the user — full undo needs prior snapshot
        this._setStatus('Undo: reload the record to see original values. DML reversal requires a snapshot — coming in v2.', 'warning');
        this.showUndo = false;
    }

    // ── UI helpers ────────────────────────────────────────────────────────────

    _setStatus(msg, type = 'info') {
        this.statusMessage = msg;
        this.statusType    = type;
        this.showUndo      = false;
        if (type === 'error') {
            this.dispatchEvent(new ShowToastEvent({ title: 'furuAgent', message: msg, variant: 'error' }));
        }
    }

    dismissStatus()  { this.statusMessage = ''; this.showUndo = false; }
    dismissResults() { this.searchResults = []; }
}
