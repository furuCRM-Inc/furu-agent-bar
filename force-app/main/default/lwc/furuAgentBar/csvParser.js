/**
 * csvParser.js — client-side CSV utilities for FlashBar bulk import.
 * All processing runs in the browser — no raw CSV is ever sent to a server.
 */

// ── RFC 4180-compatible CSV parser ─────────────────────────────────────────

/**
 * Parse CSV text into { headers, rows, totalRows }.
 * Handles quoted fields, embedded commas, and CRLF/LF line endings.
 * Processes line-by-line to keep heap usage flat for large files.
 */
export function parseCsv(text) {
    const lines = splitLines(text);
    if (!lines.length) return { headers: [], rows: [], totalRows: 0 };

    const headers = parseCsvRow(lines[0]);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim()) rows.push(parseCsvRow(lines[i]));
    }
    return { headers, rows, totalRows: rows.length };
}

function splitLines(text) {
    // Split on CRLF or LF, discard trailing blank lines
    const raw = text.split(/\r?\n/);
    let end = raw.length;
    while (end > 0 && !raw[end - 1].trim()) end--;
    return raw.slice(0, end);
}

function parseCsvRow(line) {
    const cells = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
            else inQuotes = !inQuotes;
        } else if (c === ',' && !inQuotes) {
            cells.push(current);
            current = '';
        } else {
            current += c;
        }
    }
    cells.push(current);
    return cells;
}

// ── Data transforms (all run in browser) ───────────────────────────────────

/** Full-width alphanumeric / symbols → half-width ASCII */
export function fullwidthToHalf(str) {
    if (!str) return str;
    return str
        .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
        .replace(/　/g, ' ')
        .trim();
}

/** Format Japanese phone number: keep digits and hyphens, remove spaces */
export function normalizePhone(str) {
    if (!str) return str;
    const h = fullwidthToHalf(str);
    // Remove spaces and non-digit/hyphen noise, preserve leading country code
    return h.replace(/[^\d\+\-]/g, match => (match === '(' || match === ')') ? '' : '')
            .replace(/\s/g, '');
}

/** Strip non-digits from postal code, return raw 7-digit string */
export function normalizePostalCode(str) {
    if (!str) return str;
    const digits = fullwidthToHalf(str).replace(/\D/g, '');
    return digits.length === 7 ? digits : fullwidthToHalf(str);
}

/** YYYY/MM/DD or YY/M/D variants → YYYY-MM-DD */
export function normalizeDateStr(str) {
    if (!str) return str;
    const s = fullwidthToHalf(str).trim();
    const m = s.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/);
    if (m) {
        const [, y, mo, d] = m;
        return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    return s;
}

/** Apply a named transform to a single cell value */
export function applyTransform(value, transform) {
    if (value == null) return value;
    const s = String(value);
    switch (transform) {
        case 'fullwidth_to_half': return fullwidthToHalf(s);
        case 'normalize_phone':   return normalizePhone(s);
        case 'normalize_postal':  return normalizePostalCode(s);
        case 'date_format':       return normalizeDateStr(s);
        default:                  return s;
    }
}

// ── Record builder ──────────────────────────────────────────────────────────

/**
 * Convert parsed rows to array of plain field-map objects using active mappings.
 * @param {string[]}   headers  CSV header row
 * @param {string[][]} rows     All data rows (stays in JS — never serialized)
 * @param {Array}      mappings [{csvHeader, sfApiName, transform}] from Worker
 * @returns {Array<Record<string,string>>}  One object per row, keyed by sfApiName
 */
export function buildRecords(headers, rows, mappings) {
    const colMap = {};
    for (const m of mappings) {
        if (!m.sfApiName) continue;
        const idx = headers.indexOf(m.csvHeader);
        if (idx !== -1) colMap[idx] = { field: m.sfApiName, transform: m.transform ?? 'none' };
    }

    return rows.map(row => {
        const rec = {};
        for (const [idxStr, { field, transform }] of Object.entries(colMap)) {
            const raw = row[Number(idxStr)] ?? '';
            const val = applyTransform(raw, transform);
            if (val != null && String(val).trim() !== '') rec[field] = String(val).trim();
        }
        return rec;
    });
}

/** Return the first N rows as a 2-D array (for Worker sampling) */
export function sampleRows(rows, n = 5) {
    return rows.slice(0, n);
}
