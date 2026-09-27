/**
 * What changed in a unit, on either side (docs/device-sync.md, "Row
 * matching"). A row matched by its key is compared column by column with its
 * baseline, so an emptied column is a real deletion. A row matched by value
 * has no baseline: its values count only where they are non-empty and differ
 * from the shadow's projection, TYPE and LABEL only for phones, emails,
 * addresses and events, and IS_PRIMARY never.
 */
import { CommonKind, Data, MimeType, StructuredPostal as SP } from '../android-columns';
import type { Row } from '../types';
import { changedFromBaseline, sameCell, text } from './cells';
import type { Match } from './matching';
import { POSTAL_PART_COLUMNS } from './postal';
import { SPECS, type Unit } from './project';

/**
 * A postal row whose parts are only its formatted address copied into STREET:
 * the provider's split of an editor that wrote FORMATTED_ADDRESS alone.
 */
function providerSplitPostal(cells: Row): boolean {
  const street = text(cells[SP.STREET]);
  return street !== null
    && street === text(cells[SP.FORMATTED_ADDRESS])
    && POSTAL_PART_COLUMNS.every((c) => c === SP.STREET || text(cells[c]) === null);
}

export function localChanges(m: Match): string[] {
  const { row, unit } = m;
  const changed = rawChanges(m).filter((c) => !unit.truncated?.includes(c));
  if (row.mimetype === MimeType.STRUCTURED_POSTAL && providerSplitPostal(row.cells)) {
    // A multi-part formatted address in STREET was the provider's split, not a typed street.
    const split = m.how !== 'key' || !row.baseline || /[,\n]/.test(text(row.cells[SP.FORMATTED_ADDRESS]) ?? '');
    if (split) return changed.filter((c) => !(POSTAL_PART_COLUMNS as readonly string[]).includes(c));
  }
  return changed;
}

function rawChanges(m: Match): string[] {
  const spec = SPECS[m.row.mimetype];
  const { row, unit } = m;
  if (m.how === 'key' && row.baseline) return changedFromBaseline(row.cells, row.baseline, spec.columns);
  if (row.mimetype === MimeType.PHOTO) {
    // A photo row without our baseline was put there by an editor: its picture counts as new.
    return m.how === 'key' ? [] : [Data.DATA14];
  }
  const out = spec.valueColumns.filter((c) => text(row.cells[c]) !== null && !sameCell(row.cells[c], unit.cells[c], c));
  if (spec.typed && text(row.cells[CommonKind.TYPE]) !== null && !sameCell(row.cells[CommonKind.TYPE], unit.cells[CommonKind.TYPE])) {
    out.push(CommonKind.TYPE, CommonKind.LABEL);
  } else if (spec.typed && text(row.cells[CommonKind.LABEL]) !== null && !sameCell(row.cells[CommonKind.LABEL], unit.cells[CommonKind.LABEL])) {
    out.push(CommonKind.LABEL);
  }
  return out;
}

/** Whether two units show the same on the device (sub-fields Android can't hold don't count). */
export function sameUnit(a: Unit, b: Unit): boolean {
  if (a.mimetype !== b.mimetype) return false;
  // A photo whose bytes could not be had compares as unchanged.
  if (a.mimetype === MimeType.PHOTO) return a.photoHash === undefined || b.photoHash === undefined || a.photoHash === b.photoHash;
  return SPECS[a.mimetype].columns.every((c) => sameCell(a.cells[c], b.cells[c], c));
}
