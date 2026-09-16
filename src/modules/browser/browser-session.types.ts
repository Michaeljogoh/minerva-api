import type {
  Page as StagehandPage,
  Stagehand,
  StagehandBrowser,
} from '@browserbasehq/stagehand';

export interface BrowserSession {
  stagehand: Stagehand;
  browserHandle: StagehandBrowser;
  page: StagehandPage;
  sessionId: string;
  createdAt: Date;
  recordId: string;
}

export interface BrowserCloseOpts {
  status?: 'complete' | 'stopped' | 'error';
  error?: string;
}
