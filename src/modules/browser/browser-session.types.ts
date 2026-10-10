import type {
  Page as StagehandPage,
  Stagehand,
  StagehandBrowser,
} from '@browserbasehq/stagehand';
import type { ExternalModelConfig } from '@modules/model/external-model.types';

/** Everything needed to (re)attach Stagehand to an already-running Steel browser. */
export interface StagehandConnectTarget {
  cdpUrl: string;
  extensionId: string;
  externalModel: ExternalModelConfig | null;
}

export interface StagehandConnection {
  stagehand: Stagehand;
  browserHandle: StagehandBrowser;
  page: StagehandPage;
}

export interface BrowserSession extends StagehandConnection {
  connectTarget: StagehandConnectTarget;
  sessionId: string;
  liveUrl: string;
  createdAt: Date;
  recordId: string;
  /** Owner; set so the saved browser profile can be finalized on close. */
  userId?: string;
  /** Steel profile this session saves to, when it persists one. */
  profileId?: string;
}

export interface BrowserCloseOpts {
  status?: 'complete' | 'stopped' | 'error';
  error?: string;
}
