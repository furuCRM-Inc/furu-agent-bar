import { LightningElement, api, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import getCaseContext    from '@salesforce/apex/FlashBar_CaseTriageController.getCaseContext';
import scoreTriage       from '@salesforce/apex/FlashBar_CaseTriageController.scoreTriage';
import assignCaseToQueue from '@salesforce/apex/FlashBar_CaseTriageController.assignCaseToQueue';

export default class FlashBarCaseTriageCard extends LightningElement {

    /** Injected by the Lightning Record Page via the recordId standard property. */
    @api recordId;

    @track _triage    = null;
    @track _loading   = true;
    @track _assigning = false;
    @track _assigned  = false;
    @track _error     = null;

    connectedCallback() {
        this._loadTriage();
    }

    // ── data loading ──────────────────────────────────────────────────────────

    async _loadTriage() {
        this._loading = true;
        this._error   = null;
        try {
            const ctx = await getCaseContext({ caseId: this.recordId });
            const result = await scoreTriage({ requestJson: JSON.stringify(ctx) });
            this._triage = result;
        } catch (e) {
            this._error = e.body?.message ?? e.message ?? 'Triage analysis failed.';
        } finally {
            this._loading = false;
        }
    }

    // ── computed getters ──────────────────────────────────────────────────────

    get urgencyPercent() {
        return this._triage ? Math.round((this._triage.urgencyScore ?? 0) * 100) : 0;
    }

    get badgeTheme() {
        const score = this._triage?.urgencyScore ?? 0;
        if (score >= 0.85) return 'slds-badge furu-triage__badge--critical';
        if (score >= 0.50) return 'slds-badge furu-triage__badge--high';
        return 'slds-badge furu-triage__badge--low';
    }

    get isEscalation() {
        return this._triage?.isImmediateEscalationRequired === true;
    }

    get buttonLabel() {
        const q = this._triage?.recommendedQueueLabel ?? 'Recommended Queue';
        return `Assign to ${q}`;
    }

    get isButtonDisabled() {
        return this._assigning || this._assigned || !this._triage?.recommendedQueueDeveloperName;
    }

    // ── assign handler ────────────────────────────────────────────────────────

    async handleAssign() {
        if (!this._triage?.recommendedQueueDeveloperName) return;
        this._assigning = true;
        this._error     = null;
        try {
            const req = {
                caseId:             this.recordId,
                queueDeveloperName: this._triage.recommendedQueueDeveloperName,
            };
            const resJson = await assignCaseToQueue({ requestJson: JSON.stringify(req) });
            const res = JSON.parse(resJson);
            if (res.status === 'SUCCESS') {
                this._assigned = true;
                this.dispatchEvent(new ShowToastEvent({
                    title:   'Assigned',
                    message: `Case assigned to ${this._triage.recommendedQueueLabel}`,
                    variant: 'success',
                }));
            } else {
                this._error = res.message ?? 'Assignment failed.';
            }
        } catch (e) {
            this._error = e.body?.message ?? e.message ?? 'Assignment error.';
        } finally {
            this._assigning = false;
        }
    }

    handleRefresh() {
        this._triage   = null;
        this._assigned = false;
        this._loadTriage();
    }
}
