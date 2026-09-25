import { LightningElement, api, track, wire } from 'lwc';
import { getRecord, getFieldValue } from 'lightning/uiRecordApi';
import NAME_FIELD from '@salesforce/schema/User.Name';
import qualifyLeads          from '@salesforce/apex/FlashBar_LeadAssigner.qualifyLeads';
import assignLeadsRoundRobin from '@salesforce/apex/FlashBar_LeadAssigner.assignLeadsRoundRobin';

const TIER_CLASS = { HOT: 'fla-tier--hot', WARM: 'fla-tier--warm', COLD: 'fla-tier--cold' };

// Leads per qualifyLeads() round-trip. Smaller batches keep each LLM prompt fast
// and let independent chunks fail without blanking the whole table.
const CHUNK_SIZE = 5;

const USER_PICKER_MATCHING_INFO = {
    primaryField: { fieldPath: 'Name' },
};

export default class FuruAgentLeadAssigner extends LightningElement {

    @api records = [];

    @track _isLoading     = true;
    @track _isAssigning   = false;
    @track _resultMsg     = '';
    @track _resultMsgType = '';
    @track _minIcpScore   = 0;
    @track _reps          = [];   // [{id, name}]

    _scoreMap = {};
    _pickerRecordId;

    userPickerMatchingInfo = USER_PICKER_MATCHING_INFO;
    userObjectInfo = { apiName: 'User' };

    connectedCallback() {
        this._loadScores();
    }

    async _loadScores() {
        this._isLoading = true;
        this._scoreMap  = {};
        try {
            // qualifyLeads() forwards this JSON to the Worker verbatim (no server-side
            // shaping) — it expects { leads: [{leadId, company, title, ...}] }, not a
            // bare leadIds array. Send whatever fields the current SOQL columns gave us;
            // the Worker treats missing ones as "unknown" signals rather than erroring.
            const leads = (this.records ?? [])
                .map(r => ({
                    leadId:            r.Id ?? r.id,
                    firstName:         r.FirstName,
                    lastName:          r.LastName,
                    company:           r.Company,
                    title:             r.Title,
                    email:             r.Email,
                    annualRevenue:     r.AnnualRevenue,
                    numberOfEmployees: r.NumberOfEmployees,
                    industry:          r.Industry,
                    leadSource:        r.LeadSource,
                }))
                .filter(l => l.leadId);

            // One giant batch = one giant LLM prompt = the request most likely to hit a
            // callout timeout, and an all-or-nothing failure if it does. Chunking into
            // small parallel round-trips keeps each individual prompt fast, and a failed
            // chunk only blanks its own leads' scores instead of the whole table.
            const chunks = [];
            for (let i = 0; i < leads.length; i += CHUNK_SIZE) {
                chunks.push(leads.slice(i, i + CHUNK_SIZE));
            }

            const settled = await Promise.allSettled(
                chunks.map(chunk => qualifyLeads({ requestJson: JSON.stringify({ leads: chunk }) }))
            );

            let failedChunks  = 0;
            let lastErrorText = '';
            for (const outcome of settled) {
                if (outcome.status === 'fulfilled') {
                    const result = outcome.value;
                    for (const s of (result?.scores ?? [])) this._scoreMap[s.leadId] = s;
                    if (result?.status && result.status !== 'SUCCESS') {
                        failedChunks++;
                        lastErrorText = result.status;
                    }
                } else {
                    failedChunks++;
                    lastErrorText = outcome.reason?.body?.message ?? outcome.reason?.message ?? 'Unknown error';
                }
            }

            if (failedChunks > 0) {
                this._resultMsgType = 'warning';
                this._resultMsg = chunks.length > 1
                    ? `⚠️ ${failedChunks}/${chunks.length}件のバッチでスコア取得に失敗しました（${lastErrorText}）。一部のリードはスコアなしで表示されます。`
                    : lastErrorText;
            }
        } catch (err) {
            this._resultMsgType = 'error';
            this._resultMsg = '❌ ' + (err.body?.message ?? err.message ?? 'ICPスコア取得に失敗しました');
        } finally {
            this._isLoading = false;
        }
    }

    // ── Rep picker (User lookup → wire fetches display name) ───────────────

    @wire(getRecord, { recordId: '$_pickerRecordId', fields: [NAME_FIELD] })
    _wiredUser;

    handlePickerChange(event) {
        this._pickerRecordId = event.detail?.recordId ?? undefined;
    }

    handleAddRep() {
        const id = this._pickerRecordId;
        if (!id) return;
        if (this._reps.some(r => r.id === id)) {
            this._pickerRecordId = undefined;
            return;
        }
        const name = getFieldValue(this._wiredUser?.data, NAME_FIELD) ?? id;
        this._reps = [...this._reps, { id, name }];
        this._pickerRecordId = undefined;
        const picker = this.template.querySelector('.fla-user-picker');
        if (picker) picker.clearSelection?.();
    }

    handleRemoveRep(event) {
        const id = event.currentTarget.dataset.id;
        this._reps = this._reps.filter(r => r.id !== id);
    }

    handleMinScoreChange(event) {
        const v = parseFloat(event.target.value);
        this._minIcpScore = isNaN(v) ? 0 : v;
    }

    // ── Computed ─────────────────────────────────────────────────────────────

    get tableRows() {
        return (this.records ?? []).map(rec => {
            const id    = rec.Id ?? rec.id;
            const score = this._scoreMap[id];
            const tier  = score?.tier ?? '—';
            return {
                key:           id,
                id,
                name:          rec.Name ?? rec.Company ?? id,
                company:       rec.Company ?? '',
                icpScoreLabel: score ? Number(score.icpScore).toFixed(2) : '—',
                tier,
                tierClass:     'fla-tier ' + (TIER_CLASS[tier] ?? ''),
                reasoning:     score?.reasoning ?? '',
            };
        });
    }

    get totalCount()   { return (this.records ?? []).length; }
    get hasReps()       { return this._reps.length > 0; }
    get canAssign()      { return this.hasReps && !this._isAssigning && !this._isLoading && this.totalCount > 0; }
    get assignDisabled() { return !this.canAssign; }
    get addRepDisabled() { return !this._pickerRecordId; }

    get assignLabel() {
        return this._isAssigning ? '割当中...' : `🎯 割り当てる (${this.totalCount}件)`;
    }

    get hasResultMsg()   { return !!this._resultMsg; }
    get resultMsgClass() { return `fla-result-msg fla-result-msg--${this._resultMsgType}`; }

    // ── Assign ───────────────────────────────────────────────────────────────

    async handleAssign() {
        if (!this.canAssign) return;
        this._isAssigning = true;
        this._resultMsg   = '';

        try {
            const leadIds         = (this.records ?? []).map(r => r.Id ?? r.id).filter(Boolean);
            const assignedUserIds = this._reps.map(r => r.id);

            const raw    = await assignLeadsRoundRobin({
                requestJson: JSON.stringify({
                    leadIds,
                    assignedUserIds,
                    minIcpScore: this._minIcpScore,
                }),
            });
            const result = JSON.parse(raw);

            if (result.status === 'SUCCESS') {
                this._resultMsgType = result.skippedCount > 0 ? 'warning' : 'success';
                this._resultMsg = result.skippedCount > 0
                    ? `✅ ${result.assignedCount}件 割当完了 / ⏭ ${result.skippedCount}件 スキップ（ICP閾値未満）`
                    : `✅ ${result.assignedCount}件 割当完了`;

                this.dispatchEvent(new CustomEvent('leadassignerclose', {
                    detail:   { assignedCount: result.assignedCount ?? 0 },
                    bubbles:  true,
                    composed: true,
                }));
            } else {
                this._resultMsgType = 'error';
                this._resultMsg = '❌ ' + (result.message ?? '割当に失敗しました');
            }
        } catch (err) {
            this._resultMsgType = 'error';
            this._resultMsg = '❌ ' + (err.body?.message ?? err.message ?? 'Unknown error');
        } finally {
            this._isAssigning = false;
        }
    }

    handleClose() {
        this.dispatchEvent(new CustomEvent('leadassignerclose', {
            detail:   { assignedCount: 0 },
            bubbles:  true,
            composed: true,
        }));
    }
}
