/**
 * jpAddressService — pure utility module for Japanese postal code parsing
 * and Salesforce address field mapping. No LWC decorators — plain ES module.
 *
 * The actual Zipcloud API call is made via Apex (callout:FuruAgent_Backend)
 * to avoid CSP restrictions. This module handles only regex extraction and
 * field mapping logic.
 */

// ── Postal code patterns ───────────────────────────────────────────────────
// Handles: 〒100-0001  100-0001  1000001  〒１００-０００１ (full-width digits)

function toHalfWidth(str) {
    return str.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

/**
 * Extracts a 7-digit postal code from arbitrary Japanese text.
 * Returns a clean 7-digit string, or null if none found.
 */
export function extractPostalCode(text) {
    if (!text) return null;
    const normalized = toHalfWidth(text).normalize('NFKC');
    // Match 〒123-4567, 123-4567, 〒1234567, 1234567
    const match = normalized.match(/[〒〠]?\s*(\d{3})[ー\-−－-](\d{4})|[〒〠]\s*(\d{7})/);
    if (!match) return null;
    if (match[1] && match[2]) return match[1] + match[2];
    if (match[3]) return match[3];
    return null;
}

// ── Session-scoped postal code cache ─────────────────────────────────────────
// Avoids redundant lookups for the same zip within a browser session.

const _CACHE_PREFIX = 'furu_jp_addr_';

export function getCachedAddress(zipcode) {
    try {
        const raw = sessionStorage.getItem(_CACHE_PREFIX + zipcode);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

export function setCachedAddress(zipcode, data) {
    try { sessionStorage.setItem(_CACHE_PREFIX + zipcode, JSON.stringify(data)); }
    catch { /* sessionStorage unavailable — silent */ }
}

/**
 * Strips the resolved prefecture/city/town strings from raw user input,
 * returning only the street-number and building portion.
 * E.g. "〒150-0002 東京都渋谷区渋谷2-24-12 渋谷スクランブルスクエア 39F"
 *   → "2-24-12 渋谷スクランブルスクエア 39F"
 */
export function extractAddressTail(rawInput, addressResult) {
    if (!rawInput || !addressResult) return '';

    // Remove postal code (with or without 〒, with or without hyphen)
    let tail = toHalfWidth(rawInput)
        .replace(/[〒〠]?\s*\d{3}[ー\-−－-]\d{4}/, '')
        .replace(/[〒〠]\s*\d{7}/, '')
        .trim();

    // Strip Zipcloud-returned components that repeat in user text
    for (const part of [addressResult.prefecture, addressResult.city, addressResult.town]) {
        if (part && tail.startsWith(part)) {
            tail = tail.slice(part.length).trim();
        }
    }
    return tail;
}

// ── Salesforce address field maps ──────────────────────────────────────────

const FIELD_MAPS = {
    Account:     { zip: 'BillingPostalCode', state: 'BillingState',  city: 'BillingCity',  street: 'BillingStreet'  },
    Contact:     { zip: 'MailingPostalCode',  state: 'MailingState',   city: 'MailingCity',   street: 'MailingStreet'   },
    Lead:        { zip: 'PostalCode',          state: 'State',          city: 'City',          street: 'Street'          },
    Opportunity: { zip: null,                  state: null,             city: null,            street: null             },
};

/**
 * Maps a Zipcloud address result + street tail to the correct Salesforce field
 * API names for the given sObjectType.
 * Returns a record-update-ready { FieldApiName: value } map.
 */
export function mapAddressToFields(addressResult, sObjectType, streetTail) {
    const map = FIELD_MAPS[sObjectType] ?? FIELD_MAPS.Account;
    // BillingStreet = zipcloud town + user-provided street+building
    const streetLine = [addressResult.town, streetTail].filter(Boolean).join(' ').trim();

    const fields = {};
    if (map.zip)    fields[map.zip]    = addressResult.postalCode;
    if (map.state)  fields[map.state]  = addressResult.prefecture;
    if (map.city)   fields[map.city]   = addressResult.city;
    if (map.street && (streetLine || addressResult.town)) {
        fields[map.street] = streetLine || addressResult.town;
    }
    return fields;
}
