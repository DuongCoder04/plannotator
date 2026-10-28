export interface ProviderReviewDefaults {
  defaultDiffType?: string;
}

/**
 * Saved review defaults per VCS, keyed by provider id (`jj`). Git keeps its
 * original `diffOptions.defaultDiffType`, which wins over a `git` entry here.
 */
export type ReviewDefaults = Record<string, ProviderReviewDefaults>;

export interface ReviewSettingsDiffOption {
  id: string;
  label: string;
  description: string;
}

/** The default-diff choices Settings offers for one VCS. */
export interface VcsReviewSettingsDescriptor {
  id: string;
  label: string;
  defaultDiffType: string;
  diffOptions: ReviewSettingsDiffOption[];
}

export type DiffLineBgIntensity = 'subtle' | 'normal' | 'strong';

/**
 * The user's appearance choice: a palette for the light half, a palette for
 * the dark half, and which of them the mode selects. `system` follows the OS,
 * so the two halves swap with `prefers-color-scheme`.
 */
export interface ThemeConfig {
  mode?: 'light' | 'dark' | 'system';
  light?: string;
  dark?: string;
}

export interface DiffOptions {
  diffStyle?: 'split' | 'unified';
  overflow?: 'scroll' | 'wrap';
  diffIndicators?: 'bars' | 'classic' | 'none';
  lineDiffType?: 'word-alt' | 'word' | 'char' | 'none';
  showLineNumbers?: boolean;
  showDiffBackground?: boolean;
  fontFamily?: string;
  fontSize?: string;
  tabSize?: number;
  hideWhitespace?: boolean;
  expandUnchanged?: boolean;
  defaultDiffType?: string;
  lineBgIntensity?: DiffLineBgIntensity;
}
