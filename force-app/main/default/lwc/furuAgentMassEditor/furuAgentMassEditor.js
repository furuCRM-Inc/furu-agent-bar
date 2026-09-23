import { LightningElement, api, track } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import getEditSchema        from '@salesforce/apex/FlashBarMassEditService.getEditSchema';
import updateMassiveRecords from '@salesforce/apex/FlashBarMassEditService.updateMassiveRecords';

// Maps Salesforce field type strings → HTML input type
const SF_TO_INPUT_TYPE = {
    DOUBLE:    'number',
    INTEGER:   'number',
    LONG:      'number',
    CURRENCY:  'number',
    PERCENT:   'number',
    DATE:      'date',
    DATETIME:  'datetime-local',
    BOOLEAN:   'checkbox',
};

const MAX_UNDO = 20;

export default class FuruAgentMassEditor extends NavigationMixin(LightningElement) {

    @api sObjectType  = '';
    @api records      = [];
    @api fieldNames   = [];

    // Schema loaded from Apex
    @track _schema    = [];   // [ColumnMeta]
    @track _rows      = [];   // [{id, _orig, checked, errorMsg, saveSuccess}]
    @track _isLoading = false;
    @track _isSaving  = false;
    @track _saveMsg   = '';
    @track _saveMsgType = '';

    // Bulk apply panel
    @track _showBulkPanel = false;
    @track _bulkField     = '';
    @track _bulkValue     = '';

    // AI input bar
    @track _aiInput       = '';

    // Draft map: { recordId: { fieldName: value } }
    _draftMap   = {};
    _undoStack  = [];
    _redoStack  = [];

    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    connectedCallback() {
        this._loadSchema();
    }

    async _loadSchema() {
        if (!this.sObjectType || !this.fieldNames?.length) return;
        this._isLoading = true;
        try {
            const schema = await getEditSchema({
                sObjectType: this.sObjectType,
                fieldsJson:  JSON.stringify(this.fieldNames),
            });
            this._schema = schema ?? [];
            this._buildRows();
        } catch (err) {
            this._saveMsgType = 'error';
            this._saveMsg     = err.body?.message ?? err.message ?? 'Schema load failed';
        } finally {
            this._isLoading = false;
        }
    }

    _buildRows() {
        this._rows = (this.records ?? []).map(rec => ({
            id:          rec.Id ?? rec.id ?? '',
            _orig:       { ...rec },
            checked:     false,
            errorMsg:    null,
            saveSuccess: false,
        }));
        this._draftMap  = {};
        this._undoStack = [];
        this._redoStack = [];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Computed getters
    // ─────────────────────────────────────────────────────────────────────────

    get tableRows() {
        const schema = this._schema;
        return this._rows.map(row => {
            const draft = this._draftMap[row.id] ?? {};
            const isDirtyRow = Object.keys(draft).length > 0;

            const cells = schema.map(col => {
                const isDirty  = draft[col.apiName] !== undefined;
                const rawValue = isDirty
                    ? draft[col.apiName]
                    : (row._orig[col.apiName] ?? '');
                const inputType = SF_TO_INPUT_TYPE[col.fieldType] ?? 'text';
                const isPicklist   = col.fieldType === 'PICKLIST' || col.fieldType === 'MULTIPICKLIST';
                const isCheckbox   = col.fieldType === 'BOOLEAN';
                const isEditable   = col.isEditable;

                // Build picklist options with selected flag
                const picklistOptions = (col.picklistOptions ?? []).map(opt => ({
                    ...opt,
                    key:      opt.value,
                    selected: String(rawValue) === opt.value,
                }));

                return {
                    key:            col.apiName,
                    apiName:        col.apiName,
                    label:          col.label,
                    value:          rawValue,
                    valueStr:       rawValue == null ? '' : String(rawValue),
                    isDirty,
                    isEditable,
                    inputType,
                    isPicklist,
                    isCheckbox,
                    isText:         isEditable && !isPicklist && !isCheckbox,
                    isReadOnly:     !isEditable,
                    cellClass:      'fme-cell' + (isDirty ? ' fme-cell--dirty' : ''),
                    checked:        isCheckbox ? (rawValue === true || rawValue === 'true') : false,
                    picklistOptions,
                };
            });

            let rowClass = 'fme-row';
            if (row.errorMsg)    rowClass += ' fme-row--error';
            if (row.saveSuccess) rowClass += ' fme-row--success';

            return {
                key:         row.id,
                id:          row.id,
                checked:     row.checked,
                name:        row._orig.Name ?? row._orig.CaseNumber ?? row._orig.Subject ?? row.id,
                isDirtyRow,
                errorMsg:    row.errorMsg,
                saveSuccess: row.saveSuccess,
                rowClass,
                cells,
            };
        });
    }

    get schemaColumns() {
        return this._schema;
    }

    get checkedCount() {
        return this._rows.filter(r => r.checked).length;
    }

    get totalCount() {
        return this._rows.length;
    }

    get dirtyCount() {
        return Object.keys(this._draftMap).length;
    }

    get canSave() {
        return this.dirtyCount > 0 && !this._isSaving;
    }

    get canUndo() {
        return this._undoStack.length > 0;
    }

    get canRedo() {
        return this._redoStack.length > 0;
    }

    // disabled getters (inverted for HTML disabled attribute)
    get saveDisabled()  { return !this.canSave;  }
    get undoDisabled()  { return !this.canUndo;  }
    get redoDisabled()  { return !this.canRedo;  }

    get allChecked() {
        return this._rows.length > 0 && this._rows.every(r => r.checked);
    }

    get selectionLabel() {
        const c = this.checkedCount;
        const t = this.totalCount;
        return `${c} / ${t} 件選択中`;
    }

    get saveLabel() {
        return this._isSaving ? '保存中...' : `💾 保存 (${this.dirtyCount}件)`;
    }

    get bulkFieldOptions() {
        return this._schema
            .filter(c => c.isEditable)
            .map(c => ({ label: c.label, value: c.apiName }));
    }

    get hasSaveMsg() {
        return !!this._saveMsg;
    }

    get saveMsgClass() {
        return `fme-save-msg fme-save-msg--${this._saveMsgType}`;
    }

    get bulkInputIsPicklist() {
        const col = this._schema.find(c => c.apiName === this._bulkField);
        return col?.fieldType === 'PICKLIST' || col?.fieldType === 'MULTIPICKLIST';
    }

    get bulkPicklistOptions() {
        const col = this._schema.find(c => c.apiName === this._bulkField);
        return (col?.picklistOptions ?? []).map(opt => ({ ...opt, key: opt.value }));
    }

    get bulkInputIsCheckbox() {
        const col = this._schema.find(c => c.apiName === this._bulkField);
        return col?.fieldType === 'BOOLEAN';
    }

    get bulkInputType() {
        const col = this._schema.find(c => c.apiName === this._bulkField);
        return SF_TO_INPUT_TYPE[col?.fieldType] ?? 'text';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Undo / Redo helpers
    // ─────────────────────────────────────────────────────────────────────────

    _pushUndo() {
        const snapshot = JSON.parse(JSON.stringify(this._draftMap));
        this._undoStack = [...this._undoStack, snapshot].slice(-MAX_UNDO);
        this._redoStack = [];   // new edit clears redo
    }

    _restoreDraftMap(map) {
        this._draftMap = JSON.parse(JSON.stringify(map));
        // Force row re-render by rebuilding the rows array reference
        this._rows = this._rows.map(r => ({ ...r }));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Cell change handler
    // ─────────────────────────────────────────────────────────────────────────

    handleCellChange(event) {
        const id    = event.currentTarget.dataset.id;
        const field = event.currentTarget.dataset.field;
        if (!id || !field) return;

        let value;
        const type = event.currentTarget.type ?? '';
        if (type === 'checkbox') {
            value = event.detail?.checked ?? event.target?.checked ?? false;
        } else if (event.detail?.value !== undefined) {
            value = event.detail.value;
        } else if (event.target?.value !== undefined) {
            value = event.target.value;
        } else {
            value = '';
        }

        this._pushUndo();

        const existing = this._draftMap[id] ?? {};
        this._draftMap = {
            ...this._draftMap,
            [id]: { ...existing, [field]: value },
        };
        // Force reactivity
        this._rows = this._rows.map(r => ({ ...r }));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Row selection handlers
    // ─────────────────────────────────────────────────────────────────────────

    handleSelectAll(event) {
        const checked = event.target.checked;
        this._rows = this._rows.map(r => ({ ...r, checked }));
    }

    handleRowCheck(event) {
        const id      = event.currentTarget.dataset.id;
        const checked = event.target.checked;
        this._rows = this._rows.map(r => r.id === id ? { ...r, checked } : r);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Bulk apply
    // ─────────────────────────────────────────────────────────────────────────

    handleToggleBulkPanel() {
        this._showBulkPanel = !this._showBulkPanel;
    }

    handleBulkFieldChange(event) {
        this._bulkField = event.target.value;
        this._bulkValue = '';
    }

    handleBulkValueChange(event) {
        const type = event.currentTarget.type ?? '';
        if (type === 'checkbox') {
            this._bulkValue = event.target.checked;
        } else {
            this._bulkValue = event.target.value;
        }
    }

    handleBulkApply() {
        const field = this._bulkField;
        const value = this._bulkValue;
        if (!field) return;

        const checkedIds = this._rows.filter(r => r.checked).map(r => r.id);
        if (!checkedIds.length) return;

        this._pushUndo();

        const newDraft = { ...this._draftMap };
        for (const id of checkedIds) {
            newDraft[id] = { ...(newDraft[id] ?? {}), [field]: value };
        }
        this._draftMap = newDraft;
        this._rows = this._rows.map(r => ({ ...r }));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Save
    // ─────────────────────────────────────────────────────────────────────────

    async handleSave() {
        if (!this.canSave) return;

        // Collect dirty records
        const dirtyRecords = [];
        for (const [id, fields] of Object.entries(this._draftMap)) {
            if (Object.keys(fields).length === 0) continue;
            dirtyRecords.push({ Id: id, ...fields });
        }
        if (!dirtyRecords.length) return;

        this._isSaving  = true;
        this._saveMsg   = '';
        this._saveMsgType = '';

        // Clear per-row status before saving
        this._rows = this._rows.map(r => ({ ...r, errorMsg: null, saveSuccess: false }));

        try {
            const result = await updateMassiveRecords({
                sObjectType: this.sObjectType,
                recordsJson: JSON.stringify(dirtyRecords),
            });

            const successSet = new Set(result.successIds ?? []);
            const errorMap   = {};
            for (const e of (result.errors ?? [])) {
                errorMap[e.recordId] = e.errorMessage;
            }

            // Update row status; clear draft for successful rows
            const newDraft = { ...this._draftMap };
            this._rows = this._rows.map(r => {
                if (successSet.has(r.id)) {
                    delete newDraft[r.id];
                    return { ...r, saveSuccess: true, errorMsg: null };
                }
                if (errorMap[r.id]) {
                    return { ...r, saveSuccess: false, errorMsg: errorMap[r.id] };
                }
                return r;
            });
            this._draftMap = newDraft;

            const savedCount  = (result.successIds ?? []).length;
            const errorCount  = (result.errors ?? []).length;
            this._saveMsgType = errorCount > 0 ? 'warning' : 'success';
            this._saveMsg     = errorCount > 0
                ? `✅ ${savedCount}件 保存完了 / ⚠️ ${errorCount}件 エラー`
                : `✅ ${savedCount}件 保存完了`;

            if (savedCount > 0) {
                this.dispatchEvent(new CustomEvent('masseditorclose', {
                    detail: { savedCount },
                    bubbles: true,
                    composed: true,
                }));
            }
        } catch (err) {
            this._saveMsgType = 'error';
            this._saveMsg     = '❌ 保存失敗: ' + (err.body?.message ?? err.message ?? 'Unknown');
        } finally {
            this._isSaving = false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Undo / Redo handlers
    // ─────────────────────────────────────────────────────────────────────────

    handleUndo() {
        if (!this._undoStack.length) return;
        const stack  = [...this._undoStack];
        const prev   = stack.pop();
        this._redoStack = [...this._redoStack, JSON.parse(JSON.stringify(this._draftMap))].slice(-MAX_UNDO);
        this._undoStack = stack;
        this._restoreDraftMap(prev);
    }

    handleRedo() {
        if (!this._redoStack.length) return;
        const stack  = [...this._redoStack];
        const next   = stack.pop();
        this._undoStack = [...this._undoStack, JSON.parse(JSON.stringify(this._draftMap))].slice(-MAX_UNDO);
        this._redoStack = stack;
        this._restoreDraftMap(next);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Keyboard handler
    // ─────────────────────────────────────────────────────────────────────────

    handleKeydown(event) {
        const ctrl = event.ctrlKey || event.metaKey;
        if (!ctrl) return;
        if (event.key === 'z' || event.key === 'Z') {
            event.preventDefault();
            this.handleUndo();
        } else if (event.key === 'y' || event.key === 'Y') {
            event.preventDefault();
            this.handleRedo();
        } else if (event.key === 'a' || event.key === 'A') {
            // Ctrl+A: select all rows
            event.preventDefault();
            this._rows = this._rows.map(r => ({ ...r, checked: true }));
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Close
    // ─────────────────────────────────────────────────────────────────────────

    handleClose() {
        this.dispatchEvent(new CustomEvent('masseditorclose', {
            detail:   { savedCount: 0 },
            bubbles:  true,
            composed: true,
        }));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Navigate to record
    // ─────────────────────────────────────────────────────────────────────────

    handleNavigate(event) {
        const id = event.currentTarget.dataset.id;
        if (!id) return;
        this[NavigationMixin.Navigate]({
            type:       'standard__recordPage',
            attributes: { recordId: id, actionName: 'view' },
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // AI input
    // ─────────────────────────────────────────────────────────────────────────

    handleAiInput(event) {
        this._aiInput = event.target.value;
    }

    handleAiKeydown(event) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        this._processAiCommand(this._aiInput.trim());
        this._aiInput = '';
        const inp = this.template.querySelector('.fme-ai-input');
        if (inp) inp.value = '';
    }

    _processAiCommand(cmd) {
        if (!cmd) return;

        // Pattern: "X%増加" or "X%増やす" — numeric percent increase
        const pctMatch = cmd.match(/(\d+(?:\.\d+)?)%\s*(増加|増やす|up|increase)/i);
        if (pctMatch) {
            const factor = 1 + parseFloat(pctMatch[1]) / 100;
            const checkedIds = this._rows.filter(r => r.checked).map(r => r.id);
            if (!checkedIds.length) {
                this._saveMsg     = '⚠️ まず行を選択してください。';
                this._saveMsgType = 'warning';
                return;
            }
            const numericCols = this._schema
                .filter(c => c.isEditable && (c.fieldType === 'CURRENCY' || c.fieldType === 'DOUBLE' || c.fieldType === 'PERCENT' || c.fieldType === 'INTEGER'))
                .map(c => c.apiName);
            if (!numericCols.length) {
                this._saveMsg = '⚠️ 数値フィールドがありません。';
                this._saveMsgType = 'warning';
                return;
            }
            this._pushUndo();
            const newDraft = { ...this._draftMap };
            for (const id of checkedIds) {
                const row = this._rows.find(r => r.id === id);
                if (!row) continue;
                newDraft[id] = newDraft[id] ?? {};
                for (const field of numericCols) {
                    const cur = parseFloat(newDraft[id][field] ?? row._orig[field] ?? 0);
                    if (!isNaN(cur)) {
                        newDraft[id][field] = Math.round(cur * factor * 100) / 100;
                    }
                }
            }
            this._draftMap = newDraft;
            this._rows = this._rows.map(r => ({ ...r }));
            this._saveMsg     = `✅ ${checkedIds.length}件に ${pctMatch[1]}% 増加を適用しました。`;
            this._saveMsgType = 'success';
            return;
        }

        // Pattern: "来月末" — set date field to end of next month
        const lastDayMatch = cmd.match(/来月末/);
        if (lastDayMatch) {
            const now   = new Date();
            const nm    = new Date(now.getFullYear(), now.getMonth() + 2, 0);
            const yyyy  = nm.getFullYear();
            const mm    = String(nm.getMonth() + 1).padStart(2, '0');
            const dd    = String(nm.getDate()).padStart(2, '0');
            const dateStr = `${yyyy}-${mm}-${dd}`;
            const checkedIds = this._rows.filter(r => r.checked).map(r => r.id);
            if (!checkedIds.length) {
                this._saveMsg = '⚠️ まず行を選択してください。'; this._saveMsgType = 'warning'; return;
            }
            const dateCols = this._schema
                .filter(c => c.isEditable && (c.fieldType === 'DATE' || c.fieldType === 'DATETIME'))
                .map(c => c.apiName);
            if (!dateCols.length) {
                this._saveMsg = '⚠️ 日付フィールドがありません。'; this._saveMsgType = 'warning'; return;
            }
            this._pushUndo();
            const newDraft = { ...this._draftMap };
            for (const id of checkedIds) {
                newDraft[id] = newDraft[id] ?? {};
                for (const field of dateCols) newDraft[id][field] = dateStr;
            }
            this._draftMap = newDraft;
            this._rows = this._rows.map(r => ({ ...r }));
            this._saveMsg = `✅ 来月末 (${dateStr}) を適用しました。`;
            this._saveMsgType = 'success';
            return;
        }

        // Fallback
        this._saveMsg     = '🤖 Claude APIとの統合で対応予定';
        this._saveMsgType = 'info';
    }
}
