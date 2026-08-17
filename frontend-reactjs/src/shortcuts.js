// Content for the "GSA" logo's shortcuts popover (see ShortcutsPopover in App.jsx).
//
// WELCOME_TITLE / WELCOME_TEXT: the heading and intro paragraph shown at the top of the popover.
//
// SHORTCUTS / TILE_EDITING_HINTS: each row is { keys: string[], suffix?: string, desc: string }
//   - keys: rendered as one or more <kbd> chips, joined by "/" if there's more than one
//   - suffix: optional plain text appended right after the key chip(s), e.g. "+click"
//   - desc: the action description
//
// Keep SHORTCUTS/TILE_EDITING_HINTS in sync with the actual keydown handler and tier mousedown
// handler in App.jsx — this file is documentation of that behavior, not the source of truth for it.

export const WELCOME_TITLE = 'Welcome to the GLySN Speech Annotator (GSA)';

export const WELCOME_TEXT = `We hope you find this tool useful for generating and revising word- and phoneme-level
annotations of speech. Before you get started, here are some helpful keyboard shortcuts
you should know about:`;

export const SHORTCUTS = [
  { keys: ['Space'], desc: 'Play / pause' },
  { keys: ['L'], desc: 'Toggle loop' },
  { keys: ['F'], desc: 'Fit full duration in view' },
  { keys: ['R'], desc: 'Force-refresh the spectrogram for the current view' },
  { keys: ['1'], desc: 'Toggle edit mode on/off (on by default)' },
  { keys: ['←', '→'], desc: 'Pan the view by 20% of the current span' },
  { keys: ['↑', '↓'], desc: 'Zoom the timeline viewing window in / out' },
  { keys: ['+', '-'], desc: 'Zoom the waveform amplitude, or tile text size if a tier was last clicked' },
  { keys: ['Ctrl/Cmd+S'], desc: 'Save the TextGrid to disk' },
  { keys: ['Ctrl/Cmd+Z'], desc: 'Undo' },
  { keys: ['Ctrl/Cmd+Y'], desc: 'Redo' },
  { keys: ['Ctrl/Cmd+C'], desc: 'Copy the selected tile(s) — or a group across tiers (edit mode, requires a selection)' },
  { keys: ['Ctrl/Cmd+V'], desc: 'Paste the copied tile(s) as new tile(s) anchored at the playhead (edit mode)' },
  { keys: ['⌫', 'Delete'], desc: 'Delete the selected tile(s) (edit mode, requires a selection)' },
  { keys: ['Shift'], suffix: '+click', desc: 'Range-select in this tier (keeps other tiers selected); does not set the play region (edit mode)' },
  { keys: ['Ctrl/Cmd'], suffix: '+click (or drag)', desc: 'Toggle tiles into/out of a multi-selection across tiers — unlike a plain click, does not replace the selection or set the play region; drag adds tiles in the starting tier (edit mode)' },
];

export const TILE_EDITING_HINTS = [
  { keys: ['Click'], desc: 'Select one tile exclusively and set the play region to it (replaces any previous multi-selection)' },
  { keys: ['Ctrl/Cmd'], suffix: '+click', desc: 'Add or remove that tile from the multi-selection without clearing others or changing the play region' },
  { keys: ['Shift'], suffix: '+click', desc: 'Select an anchored contiguous range in this tier while keeping selections in other tiers' },
  { keys: ['Double-click'], desc: 'Rename a tile (opens the label editor)' },
  { keys: ['Right-click'], desc: 'Open the context menu — rename, merge with next, delete, or mark a word validated' },
  { keys: ['Click+Drag'], desc: 'Set a loop selection region' },
  { keys: ['Click+Alt+Drag'], desc: 'Drag a tile edge without snapping to nearby boundaries' },
];

// TILE_COLOR_LEGEND: each row is { swatchKey: string, label: string, desc: string }
//   - swatchKey looks up the actual color in TILE_COLOR_SWATCHES (App.jsx) — kept there
//     since that's where the real color constants (EDITED_GREEN, default tile hues) live.
export const TILE_COLOR_LEGEND = [
  { swatchKey: 'word', label: 'Word (no score)', desc: 'Default color for a word tile that has no confidence score' },
  { swatchKey: 'phone', label: 'Phoneme / custom tile', desc: 'Default color for phoneme tiles and any custom tier' },
  { swatchKey: 'edited', label: 'Edited / validated', desc: 'A word that was manually created, edited, or marked "Validate word" — always this color regardless of score' },
];
