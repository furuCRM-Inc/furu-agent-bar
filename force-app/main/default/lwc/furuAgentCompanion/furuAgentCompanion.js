import { LightningElement, track, wire } from 'lwc';
import { subscribe, unsubscribe, MessageContext, publish } from 'lightning/messageService';
import { updateRecord } from 'lightning/uiRecordApi';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import FuruAgentMessage from '@salesforce/messageChannel/FuruAgentMessage__c';

export default class FuruAgentCompanion extends LightningElement {

    @wire(MessageContext) _msgCtx;

    @track pendingItems    = [];
    @track isSaving        = false;
    @track sObjectLabel    = '';
    @track warningMessage  = '';

    _pendingFields    = {};     // raw apiName → value — used for the actual updateRecord call
    _pendingRecordId  = null;
    _subscription     = null;

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    connectedCallback() {
        this._subscription = subscribe(
            this._msgCtx,
            FuruAgentMessage,
            (msg) => this._handleMessage(msg)
        );
    }

    disconnectedCallback() {
        unsubscribe(this._subscription);
        this._subscription = null;
    }

    // ── LMS handler ───────────────────────────────────────────────────────────

    _handleMessage(msg) {
        if (!msg) return;

        if (msg.action === 'PREFILL') {
            try {
                this._pendingFields   = JSON.parse(msg.fields || '{}');
                this._pendingRecordId = msg.recordId || null;
                this.sObjectLabel     = msg.sObjectType || '';
                this.warningMessage   = msg.warningMessage || '';
                this.pendingItems     = Object.entries(this._pendingFields).map(([k, v]) => ({
                    apiName:      k,
                    displayValue: v == null ? '(clear)' : String(v)
                }));
            } catch (e) {
                this._clear();
            }
        } else if (msg.action === 'CLEAR') {
            this._clear();
        }
    }

    _clear() {
        this.pendingItems     = [];
        this._pendingFields   = {};
        this._pendingRecordId = null;
        this.sObjectLabel     = '';
        this.warningMessage   = '';
    }

    // ── Getters ───────────────────────────────────────────────────────────────

    get hasPending() { return this.pendingItems.length > 0; }

    // ── Actions ───────────────────────────────────────────────────────────────

    async handleSave() {
        if (!this._pendingRecordId || this.isSaving) return;
        this.isSaving = true;

        const fields = { Id: this._pendingRecordId };
        Object.assign(fields, this._pendingFields);

        try {
            await updateRecord({ fields });
            this.dispatchEvent(new ShowToastEvent({
                title:   'furuAgent',
                message: 'Record updated successfully.',
                variant: 'success'
            }));
            this._broadcastClear();
            this._clear();
        } catch (err) {
            this.dispatchEvent(new ShowToastEvent({
                title:   'Update failed',
                message: err.body?.message ?? err.message ?? 'Unknown error',
                variant: 'error'
            }));
        } finally {
            this.isSaving = false;
        }
    }

    handleDiscard() {
        this._broadcastClear();
        this._clear();
    }

    _broadcastClear() {
        publish(this._msgCtx, FuruAgentMessage, {
            action: 'CLEAR', sObjectType: '', recordId: '', fields: ''
        });
    }
}
