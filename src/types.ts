// Type definitions for Nexus Mods Assistant extension

export interface StatusConfig {
  label: string;
  tone: 'success' | 'danger' | 'muted' | 'likely';
}

export type CompatibilityStatus =
  | 'COMPATIBLE'
  | 'LIKELY_COMPATIBLE'
  | 'INCOMPATIBLE'
  | 'UNKNOWN'
  | 'FAILED'
  | 'NOT_CONFIGURED';

/**
 * Where a verdict came from, ordered strongest to weakest. Surfaced to the user
 * in the badge tooltip: a verdict the user cannot interrogate is a verdict they
 * cannot correct.
 */
export type EvidenceSource =
  | 'FILE_VERSION'
  | 'FILE_NAME'
  | 'CHANGELOG'
  | 'DESCRIPTION'
  | 'UPLOAD_DATE'
  | 'NONE';

/**
 * The sources that can be the subject of a verdict sentence. NONE is "no evidence at all", which
 * reads as "Nothing states ..." once a frame puts it in front of a verb, so it is not in this type
 * and the compiler keeps it out of those frames.
 */
export type FoundEvidenceSource = Exclude<EvidenceSource, 'NONE'>;

export type Confidence = 'EXACT' | 'INFERRED' | 'NONE';

export interface CompatibilityResult {
  status: CompatibilityStatus;
  modId?: string;
  modName?: string;
  reason?: string;
  message?: string;
  detectedVersion?: string | null;
  fileId?: number | null;
  fileName?: string | null;
  fileVersion?: string | null;
  uploadedAt?: number | null;
  confidence?: Confidence;
  evidenceSource?: EvidenceSource;
  evidenceText?: string | null;
  gameDomain?: string | null;
}

export interface ModFile {
  file_id: number;
  name: string;
  version: string;
  category_id: number;
  category_name?: string;
  size_kb?: number;
  uploaded_timestamp?: number;
  description?: string;
  content_preview_link?: string;
  is_adult?: boolean; // NEW: Adult content flag
}

export interface ModRequirement {
  link_name: string;
  link: string;
  notes?: string;
  statusKey?: CompatibilityStatus;
}

export interface SelectionEntry {
  modId: string;
  gameDomain: string;
  fileIds: Set<number>;
}

export interface NexusGame {
  id: number;
  name: string;
  domain_name: string;
  game_id?: number;
}

export interface SteamVersionResponse {
  versions: string[];
}

export interface DownloadPopupInfo {
  nxm: string | null;
  key: string | null;
  expires: string | null;
  manualUrl: string | null;
}

export interface MessageRequest {
  type: string;
  modId?: string;
  fileId?: number;
  gameDomain?: string;
  priority?: 'HIGH' | 'NORMAL';
  name?: string;
  appId?: string;
  force?: boolean;
}

export interface MessageResponse {
  ok?: boolean;
  result?: any;
  error?: string;
  status?: CompatibilityStatus;
}

export interface RateLimitSnapshot {
  remaining: number | null;
  resetAt: string | null;
}

export interface VersionRange {
  min: string;
  max: string;
}

export interface BatchSession {
  ignoredModLinks: Set<string>;
  batchModIds: Set<string>;
}

export interface CacheEntry<T> {
  ts: number;
  data: T;
}

export interface StorageData {
  schemaVersion?: number;
  nexusApiKey?: string;
  targetGameDomain?: string;
  targetVersion?: string;
  targetVersionEnd?: string;
  extensionEnabled?: boolean;
  exclusionPhrases?: string;
  showOldFiles?: boolean;
  hideTranslations?: boolean;
  downloadMode?: 'MANUAL' | 'VORTEX';
  steamAppIdByDomain?: Record<string, string>;
  lastSelectedGame?: { name: string; domain: string };
  lastVersion?: string;
  lastVersionEnd?: string;
  userAllowsAdultContent?: boolean; // NEW: User's adult content preference
  nmaDebug?: boolean;
}

export type SsoPhase = 'IDLE' | 'CONNECTING' | 'WAITING_FOR_APPROVAL' | 'COMPLETE' | 'ERROR';

export interface SsoStatus {
  phase: SsoPhase;
  message: string;
  isError: boolean;
}
